/**
 * AIController.js
 * ---------------
 * Handles all communication with the OpenAI Chat Completions API.
 *
 * Responsibilities:
 *   1. generateCase()     — Build a full noir suspect dossier from scratch.
 *   2. getOpeningLine()   — Generate the suspect's first words when the call connects.
 *   3. getResponse()      — Generate a suspect reply to a player interrogation message,
 *                           plus metadata (stressDelta, confessed, terminated).
 *
 * All calls are made directly from the browser using the key stored in
 * the Vite env variable VITE_OPENAI_API_KEY.
 *
 * ⚠️  WARNING — Production note:
 *   Calling OpenAI directly from the browser exposes your API key to any
 *   user who opens DevTools. For a shipped product, proxy these calls
 *   through a backend or serverless function. For this local game prototype
 *   it is acceptable.
 */

// ─── Constants ────────────────────────────────────────────────────────────────

const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";

/** GPT model to use for all calls. */
const MODEL = "gpt-4o";

/** Temperature for case generation (more creative). */
const TEMP_GENERATE = 1.05;

/** Temperature for in-game responses (more controlled, in-character). */
const TEMP_RESPONSE = 0.85;

/**
 * ElevenLabs voice IDs mapped to rough personality archetypes.
 * The generator picks one that fits the suspect's profile.
 * Replace these with real voice IDs from your ElevenLabs account.
 */
const VOICE_POOL = [
  { id: "21m00Tcm4TlvDq8ikWAM", label: "rachel", archetype: "calm female" },
  { id: "AZnzlk1XvdvUeBnXmlld", label: "domi", archetype: "nervous female" },
  { id: "EXAVITQu4vr4xnSDxMaL", label: "bella", archetype: "cold female" },
  { id: "ErXwobaYiN019PkySvjV", label: "antoni", archetype: "smooth male" },
  { id: "MF3mGyEYCl7XYWbV9V6O", label: "elli", archetype: "young female" },
  { id: "TxGEqnHWrfWFTfGW9XjX", label: "josh", archetype: "gruff male" },
  {
    id: "VR6AewLTigWG4xSOukaG",
    label: "arnold",
    archetype: "intimidating male",
  },
  { id: "pNInz6obpgDQGcFmaJgB", label: "adam", archetype: "weary male" },
  { id: "yoZ06aMxZJJ28mfd3POQ", label: "sam", archetype: "evasive male" },
  { id: "onwK4e9ZLuTAKqWW03F9", label: "daniel", archetype: "refined male" },
];

// ─── Prompt templates ────────────────────────────────────────────────────────

/**
 * System prompt for case generation.
 * The model must return strict JSON — no markdown fences, no prose.
 */
const CASE_GENERATION_SYSTEM = `
You are a hard-boiled noir fiction writer creating dossiers for an interrogation game called Puaro.

Your output MUST be a single valid JSON object. No markdown. No code fences. No commentary outside the JSON.

Generate a morally complex, atmospheric noir suspect with a believable secret. The crime should be specific and evocative — not generic. Avoid clichés like "diamond heist". Think small-time betrayals, desperate cover-ups, accidental crimes, blackmail, or quiet corruption.

The suspect must:
- Have a consistent internal logic to their alibi and secret
- React defensively but not cartoonishly when pressed
- Have a human backstory that makes them sympathetic even if guilty

Return exactly this JSON shape (all fields required):
{
  "caseNumber":    string,   // 6-digit number like "441892"
  "suspectName":   string,   // Full name, era-appropriate (1940s–1960s feel)
  "age":           number,   // 25–65
  "crime":         string,   // Short charge description, e.g. "Suspected arson — Harlow Street Warehouse"
  "location":      string,   // Last known location, atmospheric
  "notes":         string,   // 2–4 sentences of detective's field notes. First-person, terse, noir voice.
  "personality":   string,   // 3–5 adjectives describing how the suspect behaves under questioning
  "alibi":         string,   // The alibi they will give (plausible but with a hole)
  "secretTruth":   string,   // The actual truth — what really happened. 2–3 sentences. NEVER revealed by suspect unless broken.
  "voiceArchetype": string,  // One of: calm female, nervous female, cold female, smooth male, gruff male, intimidating male, weary male, evasive male, refined male, young female
  "openingMood":   string    // How the suspect answers the phone: one of: hostile, guarded, nervous, cooperative, dismissive, confused
}
`.trim();

/**
 * Build the system prompt for in-game suspect responses.
 * This is injected at the start of every turn's API call.
 *
 * @param {object} caseData
 * @param {number} stress  0–100
 * @param {number} turn    current turn number
 * @returns {string}
 */
function buildSuspectSystemPrompt(caseData, stress, turn) {
  const stressDesc =
    stress < 30
      ? "calm and composed"
      : stress < 60
        ? "noticeably uncomfortable and defensive"
        : stress < 85
          ? "visibly rattled, voice cracking"
          : "on the verge of breaking — desperately clinging to their story";

  return `
You are playing the role of ${caseData.suspectName}, a suspect being interrogated by a detective over the phone.

CASE FACTS (known only to you):
- What you're charged with: ${caseData.crime}
- Your alibi: ${caseData.alibi}
- The truth: ${caseData.secretTruth}
- Your personality: ${caseData.personality}

CURRENT STATE:
- Turn: ${turn} of 12
- Your stress level: ${stressDesc} (${Math.round(stress)}%)
- The detective knows what's in your dossier. They do NOT know the truth yet.

RULES:
1. Stay in character at ALL times. You are ${caseData.suspectName}. Speak naturally, not theatrically.
2. You will NOT confess unless the detective asks something that cuts directly to the truth AND your stress is high (above 80%). Even then, confessions are rare — stall, deflect, or partially admit.
3. Responses should be 1–4 sentences. Short. Tense. Real.
4. Do NOT use quotation marks around your own speech. Respond as if speaking.
5. If the detective says something clever or catches a contradiction, increase your defensiveness noticeably.
6. If the detective is vague or off-track, you may regain some composure.
7. You may ask the detective a sharp question back occasionally (once every 3–4 turns max).
8. Never break the fourth wall. Never reference game mechanics.

RESPONSE FORMAT:
Return a single JSON object. No markdown. No code fences.
{
  "text":        string,   // Your spoken response as ${caseData.suspectName}
  "stressDelta": number,   // How much this exchange changes your stress. Range: -8 to +20. Positive = more stressed.
  "confessed":   boolean,  // true ONLY if you just explicitly admitted guilt in the "text" field
  "terminated":  boolean   // true if you hang up / refuse to continue (only after extreme provocation, turn 8+)
}
`.trim();
}

/**
 * Build the system prompt for the suspect's opening line.
 * @param {object} caseData
 * @returns {string}
 */
function buildOpeningSystemPrompt(caseData) {
  const moodMap = {
    hostile:
      "You answer irritably. You know why they're calling and you resent it.",
    guarded: "You answer cautiously. You're choosing every word carefully.",
    nervous:
      "You answer with a slight tremor. You've been waiting for this call.",
    cooperative: "You answer almost too pleasantly. You're playing innocent.",
    dismissive: "You answer curtly. You think this is a waste of your time.",
    confused:
      "You answer as if caught off guard. You weren't expecting them to call.",
  };

  const mood = moodMap[caseData.openingMood] ?? moodMap.guarded;

  return `
You are ${caseData.suspectName}. A detective has just called you.
${mood}

Deliver your opening line when you pick up the phone.
- 1–3 sentences maximum.
- Natural, in-character dialogue. No quotation marks around your speech.
- Do NOT introduce yourself by full name — people don't do that on the phone.
- Set the tone for your character.

Return a single JSON object:
{
  "text": string   // Your opening words when you pick up
}
`.trim();
}

// ─── AIController ─────────────────────────────────────────────────────────────

export class AIController {
  /** @type {string} */
  #apiKey;

  /**
   * @param {object} options
   * @param {string} options.apiKey  — VITE_OPENAI_API_KEY
   */
  constructor({ apiKey } = {}) {
    if (!apiKey) {
      console.warn(
        "[AIController] No API key provided. Set VITE_OPENAI_API_KEY in your .env file.",
      );
    }
    this.#apiKey = apiKey ?? "";
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  /**
   * Generate a complete noir suspect dossier.
   *
   * @returns {Promise<CaseData>}
   * @throws {Error} if the API call fails or returns malformed JSON
   */
  async generateCase() {
    const messages = [
      { role: "system", content: CASE_GENERATION_SYSTEM },
      {
        role: "user",
        content:
          "Generate a new case file. Make it original, atmospheric, and morally nuanced.",
      },
    ];

    const raw = await this.#callOpenAI(messages, TEMP_GENERATE);
    const caseData = this.#parseJSON(raw, "generateCase");

    // Resolve voice ID from archetype
    caseData.voiceId = this.#resolveVoiceId(caseData.voiceArchetype);

    // Validate required fields — fill gaps gracefully
    caseData.caseNumber = caseData.caseNumber ?? this.#randomCaseNumber();
    caseData.suspectName = caseData.suspectName ?? "Unknown Subject";
    caseData.age = caseData.age ?? 40;
    caseData.crime = caseData.crime ?? "Suspected conduct";
    caseData.location = caseData.location ?? "Unknown";
    caseData.notes = caseData.notes ?? "No field notes available.";
    caseData.alibi = caseData.alibi ?? "Claims to have been home.";
    caseData.secretTruth = caseData.secretTruth ?? "Truth unknown.";
    caseData.openingMood = caseData.openingMood ?? "guarded";

    return caseData;
  }

  /**
   * Generate the suspect's opening line when the call first connects.
   *
   * @param {CaseData} caseData
   * @returns {Promise<{ text: string }>}
   */
  async getOpeningLine(caseData) {
    const messages = [
      { role: "system", content: buildOpeningSystemPrompt(caseData) },
      {
        role: "user",
        content: "[Detective dials. The line rings twice. You pick up.]",
      },
    ];

    const raw = await this.#callOpenAI(messages, TEMP_RESPONSE);
    const parsed = this.#parseJSON(raw, "getOpeningLine");

    return {
      text: parsed.text ?? "…Yeah?",
    };
  }

  /**
   * Generate the suspect's response to a player interrogation message.
   *
   * @param {CaseData}  caseData            — full case object
   * @param {Message[]} conversationHistory — [{role, content}] accumulated so far
   * @param {object}    context             — { turn: number, stress: number }
   * @returns {Promise<TurnResponse>}
   */
  async getResponse(
    caseData,
    conversationHistory,
    { turn = 1, stress = 0 } = {},
  ) {
    const systemPrompt = buildSuspectSystemPrompt(caseData, stress, turn);

    // Build messages array: system + full history
    const messages = [
      { role: "system", content: systemPrompt },
      ...conversationHistory,
    ];

    const raw = await this.#callOpenAI(messages, TEMP_RESPONSE);
    const parsed = this.#parseJSON(raw, "getResponse");

    // Clamp and validate stressDelta
    let delta = Number(parsed.stressDelta ?? 5);
    if (isNaN(delta)) delta = 5;
    delta = Math.max(-8, Math.min(20, delta));

    return {
      text: String(parsed.text ?? "…"),
      stressDelta: delta,
      confessed: Boolean(parsed.confessed),
      terminated: Boolean(parsed.terminated),
    };
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  /**
   * Make a Chat Completions API call and return the assistant's raw text.
   *
   * @param {Array<{role:string, content:string}>} messages
   * @param {number} temperature
   * @returns {Promise<string>}
   * @throws {Error}
   */
  async #callOpenAI(messages, temperature = 0.9) {
    if (!this.#apiKey) {
      throw new Error(
        "OpenAI API key not configured. Add VITE_OPENAI_API_KEY to your .env file.",
      );
    }

    const body = {
      model: MODEL,
      messages,
      temperature,
      max_tokens: 600,
      // Instruct the model to return JSON only — reduces fencing artifacts
      response_format: { type: "json_object" },
    };

    let response;
    try {
      response = await fetch(OPENAI_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.#apiKey}`,
        },
        body: JSON.stringify(body),
      });
    } catch (networkErr) {
      throw new Error(`[AIController] Network error: ${networkErr.message}`);
    }

    if (!response.ok) {
      let detail = "";
      try {
        const errBody = await response.json();
        detail = errBody?.error?.message ?? JSON.stringify(errBody);
      } catch {
        detail = await response.text();
      }
      throw new Error(
        `[AIController] OpenAI API error ${response.status}: ${detail}`,
      );
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;

    if (!content) {
      throw new Error("[AIController] Empty response from OpenAI.");
    }

    return content;
  }

  /**
   * Parse a JSON string returned by the model.
   * Strips markdown code fences if the model ignores the response_format hint.
   *
   * @param {string} raw
   * @param {string} caller  — for error messages
   * @returns {object}
   */
  #parseJSON(raw, caller = "unknown") {
    // Strip ``` fences just in case (some model versions still emit them)
    let cleaned = raw.trim();
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");

    try {
      return JSON.parse(cleaned);
    } catch (err) {
      console.error(`[AIController.${caller}] Failed to parse JSON:`, cleaned);
      throw new Error(
        `[AIController.${caller}] Model returned invalid JSON. ` +
          `Raw content logged to console.`,
      );
    }
  }

  /**
   * Map a voice archetype string to a concrete ElevenLabs voice ID.
   * Falls back to a random pick if the archetype is unrecognised.
   *
   * @param {string} archetype
   * @returns {string}  ElevenLabs voice ID
   */
  #resolveVoiceId(archetype) {
    if (!archetype) return this.#randomVoiceId();
    const match = VOICE_POOL.find(
      (v) => v.archetype.toLowerCase() === archetype.toLowerCase(),
    );
    return match?.id ?? this.#randomVoiceId();
  }

  /** @returns {string} random voice ID from the pool */
  #randomVoiceId() {
    return VOICE_POOL[Math.floor(Math.random() * VOICE_POOL.length)].id;
  }

  /** @returns {string} zero-padded 6-digit case number */
  #randomCaseNumber() {
    return String(Math.floor(100000 + Math.random() * 900000));
  }
}

// ─── JSDoc type definitions ───────────────────────────────────────────────────

/**
 * @typedef {object} CaseData
 * @property {string} caseNumber
 * @property {string} suspectName
 * @property {number} age
 * @property {string} crime
 * @property {string} location
 * @property {string} notes
 * @property {string} personality
 * @property {string} alibi
 * @property {string} secretTruth
 * @property {string} voiceArchetype
 * @property {string} voiceId
 * @property {string} openingMood
 */

/**
 * @typedef {object} TurnResponse
 * @property {string}  text         — suspect's spoken reply
 * @property {number}  stressDelta  — stress change this turn (-8 to +20)
 * @property {boolean} confessed    — true if suspect admitted guilt
 * @property {boolean} terminated   — true if suspect hung up
 */

/**
 * @typedef {object} Message
 * @property {'user'|'assistant'|'system'} role
 * @property {string} content
 */
