/**
 * AudioController.js
 * ------------------
 * Manages music, ambient rain, call lead-in, and UI button sounds for Puaro.
 */

const MUSIC_TRACKS = {
  calm: "/assets/sfx/Abyssal_Calm_2026-04-27T073104.mp3",
  tense: "/assets/sfx/Abyssal_Calm_2026-04-27T073104.mp3",
  critical: "/assets/sfx/Abyssal_Calm_2026-04-27T073104.mp3",
};

const SFX_TRACKS = {
  ambientRain: "/assets/sfx/rain.mp3",
  static: null,
  phone: "/assets/sfx/old_phone.mp3",
  button: "/assets/sfx/button.mp3",
  win: "/assets/sfx/button.mp3",
  lose: "/assets/sfx/button.mp3",
};

const MUSIC_VOLUME = 0.48;
const AMBIENT_VOLUME = 0.18;
const STATIC_VOLUME = 0.08;
const SFX_VOLUME = 0.72;
const CROSSFADE_MS = 2000;
const STATIC_FADE_MS = 400;
const FADE_STEP_MS = 30;
const AMBIENT_LOOP_START_SECONDS = 576 / 48000 + 0.008;
const AMBIENT_LOOP_END_TRIM_SECONDS = 576 / 48000 + 0.01;

export class AudioController {
  #musicNodes = new Map();
  #staticNode = null;
  #activeTier = null;
  #unlocked = false;
  #fadeInterval = null;
  #staticFadeInterval = null;
  #musicMuted = false;
  #sfxMuted = false;

  #ambientContext = null;
  #ambientGainNode = null;
  #ambientSourceNode = null;
  #ambientArrayBufferPromise = null;
  #ambientBuffer = null;
  #ambientStarting = false;

  constructor() {
    this.#preloadAll();
    this.#listenForUnlock();
  }

  #preloadAll() {
    for (const [key, src] of Object.entries(MUSIC_TRACKS)) {
      const node = this.#createAudioNode(src, { loop: true, volume: 0 });
      this.#makeLoopSeamless(node, 0.12);
      this.#musicNodes.set(key, node);
    }

    this.#ambientArrayBufferPromise = fetch(SFX_TRACKS.ambientRain)
      .then((response) => {
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        return response.arrayBuffer();
      })
      .catch((err) => {
        console.warn(
          `[AudioController] Could not preload ambient rain: ${err.message}`,
        );
        return null;
      });

    if (SFX_TRACKS.static) {
      this.#staticNode = this.#createAudioNode(SFX_TRACKS.static, {
        loop: true,
        volume: 0,
      });
    }
  }

  #createAudioNode(src, { loop = false, volume = 1 } = {}) {
    const node = new Audio();
    node.src = src;
    node.loop = loop;
    node.volume = volume;
    node.preload = "auto";
    node.addEventListener("error", () => {
      console.warn(`[AudioController] Could not load audio: ${src}`);
    });
    return node;
  }

  #makeLoopSeamless(node, restartWindowSeconds = 0.18, restartAt = 0) {
    if (!node) return;
    node.addEventListener("timeupdate", () => {
      if (!node.duration || !Number.isFinite(node.duration)) return;
      if (node.currentTime >= node.duration - restartWindowSeconds) {
        node.currentTime = restartAt;
        if (node.paused) this.#startNode(node, "music");
      }
    });
  }

  #listenForUnlock() {
    const unlock = () => {
      if (this.#unlocked) return;
      this.#unlocked = true;

      if (this.#activeTier) {
        const activeNode = this.#musicNodes.get(this.#activeTier);
        if (activeNode) this.#startNode(activeNode, "music");
        void this.#startAmbient();
      }
      if (this.#staticNode && !this.#staticNode.paused) {
        this.#startNode(this.#staticNode, "sfx");
      }

      document.removeEventListener("click", unlock);
      document.removeEventListener("keydown", unlock);
      document.removeEventListener("touchstart", unlock);
    };

    document.addEventListener("click", unlock, { once: true });
    document.addEventListener("keydown", unlock, { once: true });
    document.addEventListener("touchstart", unlock, {
      once: true,
      passive: true,
    });
  }

  play(tier) {
    if (this.#musicMuted) {
      this.#activeTier = tier;
      if (!this.#sfxMuted) void this.#startAmbient();
      return;
    }
    const node = this.#musicNodes.get(tier);
    if (!node) {
      console.warn(`[AudioController] Unknown tier: ${tier}`);
      return;
    }

    this.#musicNodes.forEach((other, key) => {
      if (key === tier) return;
      other.pause();
      other.volume = 0;
      other.currentTime = 0;
    });

    this.#clearFade();
    this.#activeTier = tier;
    node.volume = MUSIC_VOLUME;
    this.#startNode(node, "music");
    void this.#startAmbient();
  }

  crossfadeTo(newTier) {
    if (this.#musicMuted) {
      this.#activeTier = newTier;
      if (!this.#sfxMuted) void this.#startAmbient();
      return;
    }
    if (newTier === this.#activeTier) {
      void this.#startAmbient();
      return;
    }

    const incoming = this.#musicNodes.get(newTier);
    if (!incoming) {
      console.warn(`[AudioController] Unknown tier: ${newTier}`);
      return;
    }

    const outgoing = this.#activeTier
      ? this.#musicNodes.get(this.#activeTier)
      : null;

    this.#clearFade();
    this.#activeTier = newTier;
    incoming.volume = 0;
    this.#startNode(incoming, "music");
    void this.#startAmbient();

    const steps = Math.ceil(CROSSFADE_MS / FADE_STEP_MS);
    const volStep = MUSIC_VOLUME / steps;
    let step = 0;

    this.#fadeInterval = setInterval(() => {
      step += 1;
      incoming.volume = Math.min(MUSIC_VOLUME, incoming.volume + volStep);

      if (outgoing) {
        outgoing.volume = Math.max(0, outgoing.volume - volStep);
        if (outgoing.volume <= 0) {
          outgoing.pause();
          outgoing.volume = 0;
          outgoing.currentTime = 0;
        }
      }

      if (step >= steps) {
        this.#clearFade();
        incoming.volume = MUSIC_VOLUME;
      }
    }, FADE_STEP_MS);
  }

  startStatic() {
    if (!this.#staticNode || this.#sfxMuted) return;

    this.#clearStaticFade();
    this.#startNode(this.#staticNode, "sfx");

    const steps = Math.ceil(STATIC_FADE_MS / FADE_STEP_MS);
    const volStep = STATIC_VOLUME / steps;
    let step = 0;

    this.#staticFadeInterval = setInterval(() => {
      step += 1;
      this.#staticNode.volume = Math.min(
        STATIC_VOLUME,
        this.#staticNode.volume + volStep,
      );
      if (step >= steps) {
        this.#clearStaticFade();
        this.#staticNode.volume = STATIC_VOLUME;
      }
    }, FADE_STEP_MS);
  }

  stopStatic() {
    if (!this.#staticNode || this.#staticNode.paused) return;

    this.#clearStaticFade();
    const steps = Math.ceil(STATIC_FADE_MS / FADE_STEP_MS);
    const volStep = this.#staticNode.volume / steps;
    let step = 0;

    this.#staticFadeInterval = setInterval(() => {
      step += 1;
      this.#staticNode.volume = Math.max(0, this.#staticNode.volume - volStep);
      if (step >= steps || this.#staticNode.volume <= 0) {
        this.#clearStaticFade();
        this.#staticNode.pause();
        this.#staticNode.volume = 0;
        this.#staticNode.currentTime = 0;
      }
    }, FADE_STEP_MS);
  }

  playSFX(key) {
    if (this.#sfxMuted) return;
    const src = SFX_TRACKS[key];
    if (!src) {
      console.warn(`[AudioController] Unknown SFX key: ${key}`);
      return;
    }

    const volume =
      key === "button" ? 0.18 : key === "phone" ? 0.06 : SFX_VOLUME;
    const node = this.#createAudioNode(src, { loop: false, volume });
    this.#startNode(node, "sfx");
    node.addEventListener(
      "ended",
      () => {
        node.src = "";
      },
      { once: true },
    );
  }

  stopAll() {
    this.#clearFade();
    this.#clearStaticFade();

    this.#musicNodes.forEach((node) => {
      node.pause();
      node.volume = 0;
      node.currentTime = 0;
    });

    this.#stopAmbient();

    if (this.#staticNode) {
      this.#staticNode.pause();
      this.#staticNode.volume = 0;
      this.#staticNode.currentTime = 0;
    }

    this.#activeTier = null;
  }

  setMusicVolume(vol) {
    const clamped = Math.max(0, Math.min(1, vol));
    if (this.#activeTier) {
      const node = this.#musicNodes.get(this.#activeTier);
      if (node) node.volume = clamped;
    }
  }

  setStaticVolume(vol) {
    if (this.#staticNode) {
      this.#staticNode.volume = Math.max(0, Math.min(1, vol));
    }
  }

  setMuted(muted) {
    this.setMusicMuted(muted);
    this.setSfxMuted(muted);
  }

  setMusicMuted(muted) {
    this.#musicMuted = Boolean(muted);
    if (this.#musicMuted) {
      this.#musicNodes.forEach((node) => node.pause());
      return;
    }

    if (this.#activeTier) {
      const node = this.#musicNodes.get(this.#activeTier);
      if (node) {
        node.volume = MUSIC_VOLUME;
        this.#startNode(node, "music");
      }
    }
  }

  setSfxMuted(muted) {
    this.#sfxMuted = Boolean(muted);
    if (this.#sfxMuted) {
      this.#stopAmbient();
      this.#staticNode?.pause();
      return;
    }
    if (this.#activeTier) {
      void this.#startAmbient();
    }
  }

  get activeTier() {
    return this.#activeTier;
  }

  get isUnlocked() {
    return this.#unlocked;
  }

  get isMuted() {
    return this.#musicMuted && this.#sfxMuted;
  }

  #startNode(node, channel = "music") {
    if (channel === "music" && this.#musicMuted) return;
    if (channel === "sfx" && this.#sfxMuted) return;
    const promise = node.play();
    if (promise !== undefined) {
      promise.catch((err) => {
        if (err.name !== "NotAllowedError") {
          console.warn("[AudioController] Playback failed:", err.message);
        }
      });
    }
  }

  async #startAmbient() {
    if (this.#sfxMuted || this.#ambientSourceNode || this.#ambientStarting) return;
    this.#ambientStarting = true;

    try {
      const ctx = await this.#ensureAmbientContext();
      const buffer = await this.#ensureAmbientBuffer(ctx);
      if (!ctx || !buffer || this.#sfxMuted || this.#ambientSourceNode) return;

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      if (
        buffer.duration >
        AMBIENT_LOOP_START_SECONDS + AMBIENT_LOOP_END_TRIM_SECONDS + 0.05
      ) {
        source.loopStart = AMBIENT_LOOP_START_SECONDS;
        source.loopEnd = buffer.duration - AMBIENT_LOOP_END_TRIM_SECONDS;
      }
      source.connect(this.#ambientGainNode);
      this.#ambientGainNode.gain.value = AMBIENT_VOLUME;
      source.start(0, source.loopStart || 0);
      this.#ambientSourceNode = source;
    } catch (err) {
      console.warn(
        `[AudioController] Ambient rain failed to start: ${err.message}`,
      );
    } finally {
      this.#ambientStarting = false;
    }
  }

  async #ensureAmbientContext() {
    const AudioCtx = window.AudioContext ?? window.webkitAudioContext;
    if (!AudioCtx) return null;

    if (!this.#ambientContext || this.#ambientContext.state === "closed") {
      this.#ambientContext = new AudioCtx();
      this.#ambientGainNode = this.#ambientContext.createGain();
      this.#ambientGainNode.gain.value = AMBIENT_VOLUME;
      this.#ambientGainNode.connect(this.#ambientContext.destination);
    }

    if (this.#ambientContext.state === "suspended" && this.#unlocked) {
      await this.#ambientContext.resume();
    }

    return this.#ambientContext;
  }

  async #ensureAmbientBuffer(ctx) {
    if (this.#ambientBuffer) return this.#ambientBuffer;
    const arrayBuffer = await this.#ambientArrayBufferPromise;
    if (!arrayBuffer || !ctx) return null;
    this.#ambientBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
    return this.#ambientBuffer;
  }

  #stopAmbient() {
    if (this.#ambientSourceNode) {
      try {
        this.#ambientSourceNode.stop();
      } catch {
        /* ignore */
      }
      this.#ambientSourceNode.disconnect();
      this.#ambientSourceNode = null;
    }
    if (this.#ambientGainNode) {
      this.#ambientGainNode.gain.value = 0;
    }
  }

  #clearFade() {
    if (this.#fadeInterval !== null) {
      clearInterval(this.#fadeInterval);
      this.#fadeInterval = null;
    }
  }

  #clearStaticFade() {
    if (this.#staticFadeInterval !== null) {
      clearInterval(this.#staticFadeInterval);
      this.#staticFadeInterval = null;
    }
  }
}
