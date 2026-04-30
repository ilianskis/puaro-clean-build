/**
 * VoiceController.js
 * ------------------
 * Handles all voice I/O for Puaro:
 *
 *   INPUT  — ElevenLabs Scribe v2 Realtime for push-to-talk mic capture.
 *   OUTPUT — ElevenLabs REST API for suspect TTS, played via HTMLAudioElement.
 *
 * Constructor options:
 * {
 *   elevenLabsKey:    string   — VITE_ELEVENLABS_API_KEY
 *   scribeTokenUrl:   string   — server endpoint for short-lived Scribe tokens
 *   onTranscriptChunk: fn(str) — called with interim speech-to-text chunks
 *   onSpeechEnd:       fn(str) — called with final transcript when mic closes
 * }
 *
 * Public API:
 *   startListening()         → Promise<void>  start mic capture
 *   stopListening()          → void           commit current utterance
 *   speak(text, voiceId)     → Promise<void>  TTS playback via ElevenLabs
 *   stopSpeaking()           → void           immediately halt TTS playback
 *   getLastTranscript()      → string         last committed player utterance
 *   isCurrentlySpeaking()    → boolean        true while TTS audio is playing
 *   isCurrentlyListening()   → boolean        true while mic is open
 */

import { CommitStrategy, RealtimeEvents, Scribe } from "@elevenlabs/client";

// ─── ElevenLabs constants ─────────────────────────────────────────────────────

const ELEVENLABS_BASE = "https://api.elevenlabs.io/v1";
const ELEVENLABS_SCRIBE_MODEL = "scribe_v2_realtime";
const ELEVENLABS_SCRIBE_TOKEN_URL =
  `${ELEVENLABS_BASE}/single-use-token/realtime_scribe`;
const ELEVENLABS_SCRIBE_LANGUAGE = "en";

/**
 * Default voice IDs to cycle through when no specific voiceId is given.
 * These are stable ElevenLabs pre-made voices as of 2024.
 */
const DEFAULT_VOICE_IDS = [
  "ErXwobaYiN019PkySvjV", // Antoni  — warm male
  "VR6AewLTigWG4xSOukaG", // Arnold  — authoritative male
  "pNInz6obpgDQGcFmaJgB", // Adam    — deep male
  "yoZ06aMxZJJ28mfd3POQ", // Sam     — raspy male
  "21m00Tcm4TlvDq8ikWAM", // Rachel  — calm female
];

/**
 * ElevenLabs model to use.
 * eleven_turbo_v2_5 offers the best latency for real-time game use.
 */
const ELEVENLABS_MODEL = "eleven_turbo_v2_5";

/**
 * Voice settings applied to all TTS requests.
 * Stability ↑ = more consistent, less expressive.
 * Similarity boost ↑ = closer to reference voice.
 */
const VOICE_SETTINGS = {
  stability: 0.45,
  similarity_boost: 0.82,
  style: 0.3,
  use_speaker_boost: true,
};

// ─── Realtime transcription constants ────────────────────────────────────────

/** Max ms to wait for speech after recognition starts before auto-closing. */
const RECOGNITION_TIMEOUT_MS = 12_000;

/** Minimum ms of audio before we consider it a valid utterance. */
const MIN_SPEECH_DURATION_MS = 300;

/** Max ms to wait for Scribe to return a committed transcript after commit(). */
const COMMIT_TIMEOUT_MS = 1_800;

// ─────────────────────────────────────────────────────────────────────────────

export class VoiceController {
  // ── Private state ──────────────────────────────────────────────────────────

  /** @type {string} */
  #elevenLabsKey;

  /** @type {string} */
  #scribeTokenUrl;

  /** @type {Function|null} */
  #onTranscriptChunk;

  /** @type {Function|null} */
  #onSpeechEnd;

  /** @type {import("@elevenlabs/client").RealtimeConnection|null} */
  #recognition = null;

  /** @type {boolean} */
  #recognitionActive = false;

  /** @type {boolean} */
  #recognitionStarting = false;

  /** @type {boolean} */
  #stopRequestedDuringStartup = false;

  /** @type {boolean} */
  #recognitionPendingCommit = false;

  /** @type {string} Accumulates interim + final recognition results. */
  #interimTranscript = "";

  /** @type {string[]} Finalized transcript chunks returned by Scribe. */
  #committedTranscriptSegments = [];

  /** @type {string} Last committed final transcript from a recognition session. */
  #lastTranscript = "";

  /** @type {number|null} setTimeout handle for recognition auto-close. */
  #recognitionTimeout = null;

  /** @type {number|null} setTimeout handle for commit fallback. */
  #commitTimeout = null;

  /** @type {HTMLAudioElement|null} Currently playing TTS audio element. */
  #ttsAudio = null;

  /** @type {string|null} Object URL for the current TTS blob (must be revoked). */
  #ttsBlobUrl = null;

  /** @type {boolean} */
  #ttsPlaying = false;

  /** @type {AbortController|null} For cancelling in-flight TTS fetch. */
  #fetchAbortController = null;

  /** @type {AudioContext|null} Shared Web Audio context for radio filter chain. */
  #audioContext = null;

  /** @type {AudioBufferSourceNode|null} Currently playing decoded audio source. */
  #sourceNode = null;

  /** @type {number} Start timestamp of mic session, for duration gating. */
  #listenStartTime = 0;

  /** @type {boolean} Prevent duplicate finalization from stop + onend. */
  #recognitionCommitted = false;

  /** @type {{ keyterms: string[], languageCode: string, noVerbatim: boolean }} */
  #recognitionContext = {
    keyterms: [],
    languageCode: ELEVENLABS_SCRIBE_LANGUAGE,
    noVerbatim: true,
  };

  // ───────────────────────────────────────────────────────────────────────────

  /**
   * @param {object} opts
   * @param {string}   opts.elevenLabsKey
   * @param {string}   [opts.scribeTokenUrl]
   * @param {Function} [opts.onTranscriptChunk]
   * @param {Function} [opts.onSpeechEnd]
   */
  constructor({
    elevenLabsKey,
    scribeTokenUrl,
    onTranscriptChunk,
    onSpeechEnd,
  } = {}) {
    this.#elevenLabsKey = elevenLabsKey ?? "";
    this.#scribeTokenUrl = scribeTokenUrl ?? "/api/elevenlabs/scribe-token";
    this.#onTranscriptChunk = onTranscriptChunk ?? null;
    this.#onSpeechEnd = onSpeechEnd ?? null;

    if (!this.#elevenLabsKey) {
      console.warn(
        "[VoiceController] No client-side ElevenLabs API key provided. " +
          "Realtime voice input can still work through the server token endpoint, " +
          "but suspect TTS will be skipped unless VITE_ELEVENLABS_API_KEY is set.",
      );
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // PUBLIC API — RECORDING (player input)
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Open the microphone and begin capturing speech.
   * Uses ElevenLabs Scribe v2 Realtime.
   * Resolves once the realtime session is ready to accept audio.
   * Rejects if token creation fails or microphone access is denied.
   *
   * @returns {Promise<void>}
   */
  startListening() {
    return new Promise(async (resolve, reject) => {
      if (!this.#elevenLabsKey && !this.#scribeTokenUrl) {
        reject(
          new Error(
            "No ElevenLabs speech configuration found for voice input.",
          ),
        );
        return;
      }

      this.#teardownRecognition();
      this.#interimTranscript = "";
      this.#lastTranscript = "";
      this.#committedTranscriptSegments = [];
      this.#listenStartTime = Date.now();
      this.#recognitionCommitted = false;
      this.#recognitionStarting = true;
      this.#stopRequestedDuringStartup = false;
      this.#recognitionPendingCommit = false;

      let settled = false;
      const settleResolve = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const settleReject = (error) => {
        if (settled) return;
        settled = true;
        reject(error instanceof Error ? error : new Error(String(error)));
      };

      try {
        const token = await this.#fetchScribeToken();
        if (!this.#recognitionStarting && !this.#recognition) return;

        const rec = Scribe.connect({
          token,
          modelId: ELEVENLABS_SCRIBE_MODEL,
          languageCode: this.#recognitionContext.languageCode,
          commitStrategy: CommitStrategy.MANUAL,
          keyterms: this.#recognitionContext.keyterms,
          noVerbatim: this.#recognitionContext.noVerbatim,
          microphone: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            channelCount: 1,
          },
        });

        this.#recognition = rec;

        rec.on(RealtimeEvents.SESSION_STARTED, () => {
          this.#recognitionStarting = false;
          this.#recognitionActive = true;
          console.info("[VoiceController] Scribe microphone session open.");
          this.#setRecognitionTimeout();
          settleResolve();

          if (this.#stopRequestedDuringStartup) {
            this.stopListening();
          }
        });

        rec.on(RealtimeEvents.PARTIAL_TRANSCRIPT, (data) => {
          this.#clearRecognitionTimeout();
          this.#interimTranscript = (data?.text ?? "").trim();

          if (this.#onTranscriptChunk) {
            this.#onTranscriptChunk(this.#buildLiveTranscript());
          }

          if (!this.#recognitionPendingCommit) {
            this.#setRecognitionTimeout();
          }
        });

        rec.on(RealtimeEvents.COMMITTED_TRANSCRIPT, (data) => {
          const text = (data?.text ?? "").trim();
          if (text) {
            this.#committedTranscriptSegments.push(text);
          }
          this.#interimTranscript = "";

          if (this.#recognitionPendingCommit) {
            this.#finalizeRecognitionCommit();
          }
        });

        rec.on(RealtimeEvents.ERROR, (error) => {
          const message = this.#humaniseRealtimeError(error);
          console.error("[VoiceController] Scribe error:", error, message);

          if (!settled) {
            this.#teardownRecognition();
            settleReject(new Error(message));
            return;
          }

          this.#finalizeRecognitionCommit(message);
        });

        rec.on(RealtimeEvents.CLOSE, () => {
          this.#recognitionActive = false;
          this.#recognitionStarting = false;

          if (!settled) {
            this.#teardownRecognition();
            settleReject(
              new Error("The realtime transcription session closed unexpectedly."),
            );
            return;
          }

          if (this.#recognitionPendingCommit && !this.#recognitionCommitted) {
            this.#finalizeRecognitionCommit();
          }
        });
      } catch (err) {
        this.#teardownRecognition();
        settleReject(err);
      }
    });
  }

  /**
   * Stop mic capture immediately and commit whatever was captured so far.
   * Safe to call even if not currently listening.
   */
  stopListening() {
    if (
      !this.#recognitionActive &&
      !this.#recognitionStarting &&
      !this.#recognition
    ) {
      return;
    }

    if (this.#recognitionStarting && !this.#recognitionActive) {
      this.#stopRequestedDuringStartup = true;
      return;
    }

    if (this.#recognitionPendingCommit) return;

    this.#clearRecognitionTimeout();
    this.#recognitionActive = false;
    this.#recognitionPendingCommit = true;

    try {
      this.#recognition?.commit();
    } catch (err) {
      console.warn("[VoiceController] Scribe commit failed:", err);
      this.#finalizeRecognitionCommit();
      return;
    }

    this.#setCommitTimeout();
  }

  /**
   * Return the last complete transcript from a recognition session.
   * @returns {string}
   */
  getLastTranscript() {
    return this.#lastTranscript;
  }

  /**
   * @returns {boolean}
   */
  isCurrentlyListening() {
    return this.#recognitionActive || this.#recognitionStarting;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // PUBLIC API — TTS (suspect voice output)
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Convert text to speech using ElevenLabs and play it.
   * Returns a Promise that resolves when playback finishes, or rejects on error.
   *
   * If no API key is set, logs a warning and resolves immediately so the game
   * continues without audio.
   *
   * @param {string} text      — The text to speak.
   * @param {string} [voiceId] — ElevenLabs voice ID. Falls back to a default.
   * @returns {Promise<void>}
   */
  async speak(text, voiceId) {
    if (!text || !text.trim()) return;

    // Stop any current playback first
    this.stopSpeaking();

    // ── Graceful no-op if no key ──────────────────────────────────────────────
    if (!this.#elevenLabsKey) {
      console.warn("[VoiceController] Skipping TTS — no ElevenLabs API key.");
      // Simulate a short delay so UI state changes still feel natural
      await this.#delay(text.length * 40); // ~40ms per character
      return;
    }

    const resolvedVoiceId = voiceId ?? this.#pickDefaultVoice();
    const endpoint = `${ELEVENLABS_BASE}/text-to-speech/${resolvedVoiceId}`;

    this.#fetchAbortController = new AbortController();

    // ── Fetch audio from ElevenLabs ───────────────────────────────────────────
    let response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        signal: this.#fetchAbortController.signal,
        headers: {
          "xi-api-key": this.#elevenLabsKey,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        body: JSON.stringify({
          text: text.trim(),
          model_id: ELEVENLABS_MODEL,
          voice_settings: VOICE_SETTINGS,
        }),
      });
    } catch (err) {
      if (err.name === "AbortError") {
        console.info("[VoiceController] TTS fetch aborted.");
        return;
      }
      throw new Error(`ElevenLabs fetch failed: ${err.message}`);
    }

    if (!response.ok) {
      let detail = response.statusText;
      try {
        const body = await response.json();
        detail = body?.detail?.message ?? body?.detail ?? detail;
      } catch {
        // ignore json parse error
      }
      throw new Error(`ElevenLabs API error ${response.status}: ${detail}`);
    }

    // ── Decode blob → Object URL → HTMLAudioElement ───────────────────────────
    let blob;
    try {
      blob = await response.blob();
    } catch (err) {
      if (err.name === "AbortError") return;
      throw new Error(`Failed to read TTS audio blob: ${err.message}`);
    }

    // Play the audio and wait for it to finish
    await this.#playBlob(blob);
  }

  /**
   * Immediately stop and dispose of any playing TTS audio.
   */
  stopSpeaking() {
    // Abort any in-flight fetch
    if (this.#fetchAbortController) {
      this.#fetchAbortController.abort();
      this.#fetchAbortController = null;
    }

    // Stop Web Audio source node (radio-filtered path)
    if (this.#sourceNode) {
      try {
        this.#sourceNode.onended = null;
        this.#sourceNode.stop();
      } catch {
        // Already stopped — ignore
      }
      this.#sourceNode = null;
    }

    // Stop the fallback audio element (plain path)
    if (this.#ttsAudio) {
      this.#ttsAudio.pause();
      this.#ttsAudio.src = "";
      this.#ttsAudio = null;
    }

    // Release the blob URL to free memory
    if (this.#ttsBlobUrl) {
      URL.revokeObjectURL(this.#ttsBlobUrl);
      this.#ttsBlobUrl = null;
    }

    this.#ttsPlaying = false;
  }

  /**
   * @returns {boolean} True while ElevenLabs audio is actively playing.
   */
  isCurrentlySpeaking() {
    return this.#ttsPlaying;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // PRIVATE — RECOGNITION HELPERS
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Commit the current interim transcript as the final result and fire
   * the onSpeechEnd callback.
   */
  #commitTranscript() {
    if (this.#recognitionCommitted) return;
    this.#recognitionCommitted = true;

    const duration = Date.now() - this.#listenStartTime;
    const raw = this.#buildFinalTranscript();

    // Gate on minimum duration to avoid stray noise being committed
    if (raw && duration >= MIN_SPEECH_DURATION_MS) {
      this.#lastTranscript = raw;
      console.info(`[VoiceController] Transcript committed: "${raw}"`);
    } else {
      this.#lastTranscript = "";
      if (raw && duration < MIN_SPEECH_DURATION_MS) {
        console.debug(
          `[VoiceController] Transcript discarded (too short: ${duration}ms): "${raw}"`,
        );
      }
    }

    this.#interimTranscript = "";
    this.#committedTranscriptSegments = [];

    if (this.#onSpeechEnd) {
      this.#onSpeechEnd(this.#lastTranscript);
    }
  }

  /**
   * Tear down any existing realtime transcription session cleanly.
   */
  #teardownRecognition() {
    this.#clearRecognitionTimeout();
    this.#clearCommitTimeout();

    if (this.#recognition) {
      try {
        this.#recognition.close();
      } catch {
        // Already stopped
      }

      this.#recognition = null;
    }

    this.#recognitionActive = false;
    this.#recognitionStarting = false;
    this.#stopRequestedDuringStartup = false;
    this.#recognitionPendingCommit = false;
    this.#recognitionCommitted = false;
  }

  /**
   * Set a timeout that auto-stops recognition after a period of silence.
   */
  #setRecognitionTimeout() {
    this.#clearRecognitionTimeout();
    this.#recognitionTimeout = window.setTimeout(() => {
      console.info("[VoiceController] Recognition silence timeout — closing.");
      this.stopListening();
    }, RECOGNITION_TIMEOUT_MS);
  }

  /**
   * Cancel the auto-close silence timeout.
   */
  #clearRecognitionTimeout() {
    if (this.#recognitionTimeout !== null) {
      clearTimeout(this.#recognitionTimeout);
      this.#recognitionTimeout = null;
    }
  }

  /**
   * Set a timeout that finalizes the transcript even if the commit event stalls.
   */
  #setCommitTimeout() {
    this.#clearCommitTimeout();
    this.#commitTimeout = window.setTimeout(() => {
      console.info("[VoiceController] Scribe commit timeout — finalizing.");
      this.#finalizeRecognitionCommit();
    }, COMMIT_TIMEOUT_MS);
  }

  /**
   * Cancel any pending commit fallback timeout.
   */
  #clearCommitTimeout() {
    if (this.#commitTimeout !== null) {
      clearTimeout(this.#commitTimeout);
      this.#commitTimeout = null;
    }
  }

  /**
   * Convert a Scribe error into a human-readable message.
   * @param {unknown} error
   * @returns {string}
   */
  #humaniseRealtimeError(error) {
    if (!error) return "A realtime transcription error occurred.";

    if (error instanceof Error && error.message) {
      if (/denied|permission/i.test(error.message)) {
        return "Microphone access was denied. Please allow mic access and try again.";
      }
      return error.message;
    }

    const errorCode =
      typeof error === "object" && error !== null && "error" in error
        ? String(error.error)
        : String(error);

    const messages = {
      auth_error:
        "ElevenLabs authentication failed. Check the API key and token setup.",
      quota_exceeded: "ElevenLabs quota exceeded for realtime transcription.",
      commit_throttled:
        "Speech commit was throttled. Try holding the talk button a little longer between turns.",
      transcriber_error:
        "ElevenLabs hit a transcription error while processing the mic input.",
      unaccepted_terms:
        "ElevenLabs Terms need to be accepted in the dashboard before Scribe can be used.",
      rate_limited: "ElevenLabs rate-limited this transcription request.",
      input_error: "The microphone audio format was rejected by Scribe.",
      queue_overflow:
        "ElevenLabs is overloaded right now. Please try the call again.",
      resource_exhausted:
        "ElevenLabs is temporarily out of realtime transcription capacity.",
      session_time_limit_exceeded:
        "The realtime transcription session lasted too long and was closed.",
      chunk_size_exceeded:
        "The realtime audio chunk was too large for ElevenLabs.",
      insufficient_audio_activity:
        "No clear speech was detected. Please speak closer to the mic.",
      NotAllowedError:
        "Microphone access was denied. Please allow mic access in browser settings.",
      NotFoundError:
        "No microphone was found. Ensure a mic is connected and allowed.",
    };

    return messages[errorCode] ?? `Realtime transcription error: ${errorCode}`;
  }

  /**
   * Request a short-lived Scribe token from ElevenLabs.
   * In this frontend-only app we mint it directly with the existing API key.
   *
   * @returns {Promise<string>}
   */
  async #fetchScribeToken() {
    if (this.#scribeTokenUrl) {
      try {
        const response = await fetch(this.#scribeTokenUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
        });

        if (response.ok) {
          const data = await response.json();
          if (data?.token) return data.token;
        } else {
          let detail = response.statusText;
          try {
            const body = await response.json();
            detail = body?.error ?? body?.detail?.message ?? body?.detail ?? detail;
          } catch {
            // ignore
          }
          console.warn(
            `[VoiceController] Server token endpoint failed (${response.status}): ${detail}`,
          );
        }
      } catch (err) {
        console.warn(
          "[VoiceController] Server token endpoint unavailable, trying client-side fallback.",
          err,
        );
      }
    }

    if (!this.#elevenLabsKey) {
      throw new Error(
        "Voice input is unavailable. Configure the /api/elevenlabs/scribe-token endpoint or set VITE_ELEVENLABS_API_KEY for local fallback.",
      );
    }

    const response = await fetch(ELEVENLABS_SCRIBE_TOKEN_URL, {
      method: "POST",
      headers: {
        "xi-api-key": this.#elevenLabsKey,
      },
    });

    if (!response.ok) {
      let detail = response.statusText;
      try {
        const body = await response.json();
        detail = body?.detail?.message ?? body?.detail ?? detail;
      } catch {
        // ignore json parse errors
      }
      throw new Error(
        `Failed to create ElevenLabs Scribe token (${response.status}): ${detail}`,
      );
    }

    const data = await response.json();
    if (!data?.token) {
      throw new Error("ElevenLabs did not return a realtime Scribe token.");
    }

    return data.token;
  }

  /**
   * Finalize the current Scribe session and emit the committed transcript.
   * @param {string} [fallbackMessage]
   */
  #finalizeRecognitionCommit(fallbackMessage) {
    if (this.#recognitionCommitted) return;

    this.#clearCommitTimeout();
    this.#recognitionPendingCommit = false;

    if (
      fallbackMessage &&
      this.#committedTranscriptSegments.length === 0 &&
      this.#interimTranscript
    ) {
      console.warn("[VoiceController] Finalizing with partial transcript only.");
      this.#committedTranscriptSegments.push(this.#interimTranscript.trim());
    }

    this.#commitTranscript();
    this.#teardownRecognition();
  }

  /**
   * Build the live transcript shown while the player is speaking.
   * @returns {string}
   */
  #buildLiveTranscript() {
    const parts = [...this.#committedTranscriptSegments];
    if (this.#interimTranscript.trim()) {
      parts.push(this.#interimTranscript.trim());
    }
    return parts.join(" ").trim();
  }

  /**
   * Build the final transcript that should be committed to the game.
   * @returns {string}
   */
  #buildFinalTranscript() {
    const parts = [...this.#committedTranscriptSegments];
    if (!parts.length && this.#interimTranscript.trim()) {
      parts.push(this.#interimTranscript.trim());
    }
    return parts.join(" ").replace(/\s+/g, " ").trim();
  }

  // ───────────────────────────────────────────────────────────────────────────
  // PRIVATE — TTS PLAYBACK HELPERS
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Create an Object URL from a Blob, attach it to an Audio element,
   * and return a Promise that resolves on `ended` or rejects on `error`.
   *
   * @param {Blob} blob
   * @returns {Promise<void>}
   */
  /**
   * Decode an audio Blob and play it through the radio telephone filter chain.
   * Uses Web Audio API for frequency shaping; falls back to HTMLAudioElement
   * if AudioContext is unavailable.
   *
   * @param {Blob} blob
   * @returns {Promise<void>}  resolves when playback ends
   */
  async #playBlob(blob) {
    // ── Web Audio path (preferred) ────────────────────────────────────────────
    const AudioCtx = window.AudioContext ?? window.webkitAudioContext;

    if (AudioCtx) {
      try {
        // Lazily create / resume shared context
        if (!this.#audioContext || this.#audioContext.state === "closed") {
          this.#audioContext = new AudioCtx();
        }
        if (this.#audioContext.state === "suspended") {
          await this.#audioContext.resume();
        }

        // Blob → ArrayBuffer → AudioBuffer
        const arrayBuffer = await blob.arrayBuffer();
        const audioBuffer =
          await this.#audioContext.decodeAudioData(arrayBuffer);

        // Build source + filter chain
        const source = this.#audioContext.createBufferSource();
        source.buffer = audioBuffer;
        this.#sourceNode = source;
        this.#ttsPlaying = true;

        const { input, output } = this.#buildRadioChain(this.#audioContext);
        source.connect(input);
        output.connect(this.#audioContext.destination);

        return new Promise((resolve, reject) => {
          source.onended = () => {
            console.info(
              "[VoiceController] TTS (Web Audio) playback complete.",
            );
            this.#ttsPlaying = false;
            this.#sourceNode = null;
            resolve();
          };

          try {
            source.start(0);
          } catch (err) {
            this.#ttsPlaying = false;
            this.#sourceNode = null;
            reject(
              new Error(`AudioBufferSourceNode.start() failed: ${err.message}`),
            );
          }
        });
      } catch (err) {
        console.warn(
          "[VoiceController] Web Audio path failed — falling back to HTMLAudioElement.",
          err,
        );
        // Fall through to HTMLAudioElement fallback below
      }
    }

    // ── HTMLAudioElement fallback (no radio filter) ───────────────────────────
    return new Promise((resolve, reject) => {
      if (this.#ttsBlobUrl) {
        URL.revokeObjectURL(this.#ttsBlobUrl);
      }

      this.#ttsBlobUrl = URL.createObjectURL(blob);
      const audio = new Audio(this.#ttsBlobUrl);
      audio.volume = 0.03;
      this.#ttsAudio = audio;
      this.#ttsPlaying = true;

      const cleanup = () => {
        this.#ttsPlaying = false;
        if (this.#ttsBlobUrl) {
          URL.revokeObjectURL(this.#ttsBlobUrl);
          this.#ttsBlobUrl = null;
        }
        this.#ttsAudio = null;
      };

      audio.onended = () => {
        console.info(
          "[VoiceController] TTS (HTMLAudio fallback) playback complete.",
        );
        cleanup();
        resolve();
      };

      audio.onerror = (e) => {
        console.error("[VoiceController] TTS audio playback error:", e);
        cleanup();
        reject(new Error("TTS audio playback failed."));
      };

      audio.play().catch((err) => {
        console.error("[VoiceController] audio.play() rejected:", err);
        cleanup();
        reject(
          new Error(
            "Audio autoplay was blocked by the browser. " +
              "Ensure the user has interacted with the page first.",
          ),
        );
      });
    });
  }

  /**
   * Build a radio / telephone filter chain using Web Audio API nodes.
   *
   * Chain: source → [highpass] → [lowpass] → [mid-boost] → [compressor] → [waveshaper] → [gain] → destination
   *
   * @param {AudioContext} ctx
   * @returns {{ input: AudioNode, output: AudioNode }}
   */
  #buildRadioChain(ctx) {
    // ── High-pass: strip sub-300 Hz rumble ───────────────────────────────────
    const highpass = ctx.createBiquadFilter();
    highpass.type = "highpass";
    highpass.frequency.value = 300;
    highpass.Q.value = 0.7;

    // ── Low-pass: strip above 3 400 Hz (phone bandwidth ceiling) ────────────
    const lowpass = ctx.createBiquadFilter();
    lowpass.type = "lowpass";
    lowpass.frequency.value = 3400;
    lowpass.Q.value = 0.7;

    // ── Peaking mid-boost: the 'honky' telephone presence at 1.8 kHz ────────
    const mid = ctx.createBiquadFilter();
    mid.type = "peaking";
    mid.frequency.value = 1800;
    mid.gain.value = 2;
    mid.Q.value = 1.4;

    // ── Dynamics compressor: squashed radio character ────────────────────────
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -22;
    compressor.knee.value = 8;
    compressor.ratio.value = 10;
    compressor.attack.value = 0.002;
    compressor.release.value = 0.1;

    // ── WaveShaper: subtle harmonic grit (soft-clip sigmoid) ────────────────
    const waveshaper = ctx.createWaveShaper();
    waveshaper.curve = this.#makeDistortionCurve(18);
    waveshaper.oversample = "2x";

    // ── Output gain ──────────────────────────────────────────────────────────
    const gain = ctx.createGain();
    gain.gain.value = 0.03;

    // Connect chain
    highpass.connect(lowpass);
    lowpass.connect(mid);
    mid.connect(compressor);
    compressor.connect(waveshaper);
    waveshaper.connect(gain);

    return { input: highpass, output: gain };
  }

  /**
   * Generate a soft-clip distortion curve for a WaveShaperNode.
   * Uses an arctangent-based sigmoid that adds warmth without harshness.
   *
   * @param {number} amount  — distortion intensity (10–50 recommended)
   * @returns {Float32Array}
   */
  #makeDistortionCurve(amount = 18) {
    const samples = 512;
    const curve = new Float32Array(samples);
    const k = amount;

    for (let i = 0; i < samples; i++) {
      const x = (i * 2) / samples - 1; // x ∈ [-1, +1]
      curve[i] = ((Math.PI + k) * x) / (Math.PI + k * Math.abs(x));
    }

    return curve;
  }

  /**
   * Pick a voice ID from the defaults, deterministically based on the
   * current second so it varies between cases without being random per call.
   * @returns {string}
   */
  #pickDefaultVoice() {
    const idx = Math.floor(Date.now() / 1000) % DEFAULT_VOICE_IDS.length;
    return DEFAULT_VOICE_IDS[idx];
  }

  // ───────────────────────────────────────────────────────────────────────────
  // PRIVATE — UTILITIES
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * @param {number} ms
   * @returns {Promise<void>}
   */
  #delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Provide case-specific hints to Scribe so it catches names and places better.
   *
   * @param {object} [context]
   * @param {string[]} [context.keyterms]
   * @param {string} [context.languageCode]
   * @param {boolean} [context.noVerbatim]
   */
  setRecognitionContext(context = {}) {
    const keyterms = Array.isArray(context.keyterms)
      ? context.keyterms
          .map((term) => String(term ?? "").trim())
          .filter(Boolean)
          .map((term) => term.slice(0, 20))
      : [];

    this.#recognitionContext = {
      keyterms: Array.from(new Set(keyterms)).slice(0, 50),
      languageCode: context.languageCode || ELEVENLABS_SCRIBE_LANGUAGE,
      noVerbatim:
        typeof context.noVerbatim === "boolean" ? context.noVerbatim : true,
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // CLEANUP
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Release all resources.
   * Call when the game is torn down or navigated away from.
   */
  destroy() {
    this.stopListening();
    this.stopSpeaking();
    this.#teardownRecognition();

    // Close the Web Audio context to release hardware resources
    if (this.#audioContext && this.#audioContext.state !== "closed") {
      this.#audioContext.close().catch(() => {
        /* ignore */
      });
      this.#audioContext = null;
    }

    console.info("[VoiceController] Destroyed.");
  }
}
