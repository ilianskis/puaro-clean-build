/**
 * OllamaController.js
 * -------------------
 * Wraps the Gemini API for:
 *   1. Case generation (full murder mystery)
 *   2. Suspect interrogation responses
 *   3. Witness interview responses
 *   4. Evidence analysis results
 */

const GEMINI_CHAT_URL = "/api/gemini/generate-content";
const OPENAI_CHAT_URL = "/api/openai/generate-content";
// Default server-side model:
// use Flash-Lite so the owner's server key can stay on Gemini's free tier
// much longer. It is still a Flash-family model, just the cheaper one.
const GEMINI_MODEL = "gemini-2.5-flash-lite";
const OPENAI_MODEL = "gpt-4.1-mini";

// The JSON schema we ask Gemma to generate for a full case.
// FLAT structure (not deeply nested) for reliability with smaller models.
const CASE_GENERATION_PROMPT = `You are writing a noir murder mystery case for a detective game. Generate a complete case as a single valid JSON object. No markdown, no code fences, no extra text — ONLY the JSON object.

The case must have 10 suspects (exactly), 2-3 witnesses, and 1-3 victim evidence items. Exactly ONE suspect must have role "guilty". Zero, one, or two others may have role "accomplice". The rest must be "innocent".

Required JSON shape (all fields required, use exact field names):
{
  "caseTitle": "string — atmospheric title like 'Death at the Silver Lantern'",
  "storyBrief": "string — 2-3 sentences describing what happened and why",
  "victim": {
    "name": "string",
    "age": number,
    "occupation": "string",
    "foundAt": "string — specific atmospheric location",
    "timeOfDeath": "string — e.g. 'between 10 PM and midnight'",
    "causeOfDeath": "string",
    "weapon": "string",
    "hairColor": "string",
    "bloodType": "string — A, B, AB, or O"
  },
  "guiltyId": "string — must match one of the suspect ids below, e.g. 'S2'",
  "accompliceIds": ["array of suspect ids, or empty array"],
  "suspects": [
    {
      "id": "S1",
      "name": "string",
      "surname": "string",
      "age": number,
      "occupation": "string",
      "role": "innocent",
      "motive": "string — empty string if innocent",
      "alibi": "string — what they CLAIM (may be false if guilty/accomplice)",
      "alibiTrue": boolean,
      "trueLocation": "string — where they actually were",
      "personality": "string — 3-5 adjectives e.g. 'nervous, defensive, chatty'",
      "voiceArchetype": "string — one of: calm female, nervous female, cold female, smooth male, gruff male, intimidating male, weary male, evasive male",
      "openingMood": "string — one of: hostile, guarded, nervous, cooperative, dismissive, confused",
      "victimConnection": "string — how this suspect knew the victim",
      "victimCallReason": "string or null — why this suspect may have called the victim recently",
      "personalIrregularity": "string — a small suspicious detail that may be unrelated to the murder",
      "passportId": "string — 8 alphanumeric e.g. 'AB123456'",
      "passportAddress": "string — street address",
      "passportNationality": "string",
      "passportIssue": "string — MM/YYYY",
      "passportExpiry": "string — MM/YYYY",
      "passportFake": boolean,
      "passportDiscrepancy": "string or null — what's wrong if fake",
      "hairColor": "string",
      "bloodType": "string — A, B, AB, or O",
      "clothingClue": "string or null — e.g. 'faint blood stain on right cuff'",
      "gender": "string — exactly 'male' or 'female'",
      "alibiLocation": "string — specific named place e.g. 'Marco\\'s Italian Restaurant on Vine Street' or 'Grand Theater showing Black Panther'",
      "alibiVerifierName": "string — full name of person who can verify alibi e.g. 'Marco Rossi'",
      "alibiVerifierTitle": "string — their role e.g. 'Restaurant Owner', 'Theater Director', 'Hotel Manager', 'Bar Manager'",
      "alibiDetails": "string — extra detail e.g. 'Had a reservation under Cole at 8 PM' or 'Ticket booked for 9 PM showing'",
      "phoneNumber": "string — fake US phone number e.g. '(555) 034-8821'"
    }
  ],
  "witnesses": [
    {
      "id": "W1",
      "name": "string",
      "surname": "string",
      "relationship": "string — e.g. 'neighbor', 'colleague', 'bartender nearby'",
      "personality": "string",
      "voiceArchetype": "string — same options as suspects",
      "testimony": "string — what they will say when called, 2-3 sentences",
      "mentionsSuspectId": "string or null — suspect id they will reference by name",
      "phoneNumber": "string — fake US phone number e.g. '(555) 221-4409'",
      "passportId": "string",
      "passportAddress": "string",
      "passportNationality": "string",
      "passportIssue": "string — MM/YYYY",
      "passportExpiry": "string — MM/YYYY in the FUTURE (after 2026)",
      "passportFake": boolean,
      "passportDiscrepancy": "string or null",
      "gender": "string — exactly 'male' or 'female'"
    }
  ],
  "victimEvidence": [
    {
      "id": "VE1",
      "type": "string — one of: hair, blood, fiber, fingerprint, footprint",
      "description": "string — what the detective finds, e.g. 'dark brown hair on victim's collar'",
      "analysisResult": "string — what the lab report says",
      "belongsToId": "string or null — suspect id"
    }
  ]
}`;

const FAST_CASE_GENERATION_PROMPT = `Write a fast noir murder case as a single JSON object only. Keep text concise.

Required shape:
{
  "caseTitle": "string",
  "storyBrief": "2 short sentences",
  "victim": {
    "name": "string",
    "age": number,
    "occupation": "string",
    "foundAt": "string",
    "timeOfDeath": "string",
    "causeOfDeath": "string",
    "weapon": "string"
  },
  "guiltyId": "S1",
  "accompliceIds": ["S2"],
  "suspects": [
    {
      "id": "S1",
      "name": "string",
      "surname": "string",
      "age": number,
      "occupation": "string",
      "role": "guilty | accomplice | innocent",
      "motive": "string",
      "alibi": "string",
      "alibiTrue": boolean,
      "trueLocation": "string",
      "personality": "string",
      "voiceArchetype": "string",
      "openingMood": "string",
      "victimConnection": "string",
      "victimCallReason": "string",
      "personalIrregularity": "string",
      "hairColor": "string",
      "bloodType": "string",
      "gender": "male or female"
    }
  ],
  "witnesses": [
    {
      "id": "W1",
      "name": "string",
      "surname": "string",
      "relationship": "string",
      "personality": "string",
      "voiceArchetype": "string",
      "testimony": "2 short sentences about what they saw",
      "mentionsSuspectId": "S1",
      "gender": "male or female"
    }
  ],
  "victimEvidence": [
    {
      "id": "VE1",
      "type": "hair | blood | fiber | fingerprint | footprint",
      "description": "short string",
      "analysisResult": "short string",
      "belongsToId": "S1 or null"
    }
  ]
}

Rules:
- exactly 10 suspects
- exactly 2 or 3 witnesses
- exactly 1 guilty suspect
- 0 to 2 accomplices
- no placeholders like unknown, none, witness, subject`;

/**
 * 40 preset alibi locations with verifier info.
 * One is randomly assigned to each suspect during case patching.
 * [location, verifierName, verifierTitle]
 */
const ALIBI_PRESETS = [
  ["Marco's Italian, 5th Street", "Marco Rossi", "Restaurant Owner"],
  ["Grand Theater — Harry Potter show", "Helen Park", "Theater Manager"],
  ["Portland Grill, birthday dinner", "James Porter", "Restaurant Manager"],
  ["Blue Moon Jazz Bar", "Tony Barnes", "Bar Owner"],
  ["Hotel Crown, downtown", "Diana Wells", "Hotel Receptionist"],
  ["City Library, evening session", "Anne McBride", "Head Librarian"],
  ["24-Hour Gym on Maple Ave", "Rick Stone", "Gym Manager"],
  ["Cinema Rex — Black Panther 9 PM", "Frank Lee", "Cinema Manager"],
  ["St. Mary's Hospital, visiting hours", "Nurse Sandra Kim", "Ward Nurse"],
  ["Airport lounge, departures hall", "Colin Reed", "Customer Service"],
  ["Sunset Bowling Alley", "Dave Norton", "Alley Manager"],
  ["The Red Lantern Chinese Restaurant", "Wei Chang", "Restaurant Owner"],
  ["Riverside Bar, poker night", "Phil Waters", "Bar Manager"],
  ["Zen Studio, evening yoga class", "Lily Moore", "Studio Owner"],
  ["Belmont Hall, piano recital", "Clara Stein", "Events Manager"],
  ["O'Brien's Irish Pub", "Patrick O'Brien", "Pub Owner"],
  ["Harbor Street night market", "Grace Tan", "Market Organizer"],
  ["Ellison Gallery, opening night", "Victor Crane", "Gallery Director"],
  ["Riverside Pool, late swim", "Coach Dan Holt", "Pool Manager"],
  ["The Rooftop Bar, birthday party", "Susan Vale", "Bar Manager"],
  ["St. Joseph Shelter, volunteering", "Father Thomas", "Shelter Director"],
  ["Dr. Reid's clinic, check-up", "Dr. Ellen Reid", "Clinic Receptionist"],
  ["The Crown, chess club", "Mr. Bishop", "Club President"],
  ["Artworks Studio, photography class", "Kate Fuller", "Studio Manager"],
  ["Evening ferry to Northbank", "Captain Morris", "Ferry Captain"],
  ["Church Street flower market", "Rose Evans", "Market Manager"],
  ["The Laughing Fox, comedy show", "Tommy Bright", "Show Manager"],
  ["Ridley Bookstore, book launch", "Sarah Ridley", "Bookstore Owner"],
  ["Latin Moves Studio, salsa class", "Carlos Vega", "Dance Instructor"],
  ["Barrel and Vine, wine tasting", "Helena Cross", "Sommelier"],
  ["St. Andrews Church, funeral wake", "Reverend Cole", "Church Administrator"],
  ["The Silver Spoon, late dinner", "Chef Bernard", "Head Chef"],
  ["Metro Driving School, lesson", "Instructor Paul", "School Manager"],
  ["The Sports Depot, watching game", "Barry Finn", "Bar Manager"],
  ["Night train to Westfield", "Conductor Mills", "Station Manager"],
  ["Neon Nights Bar, karaoke", "Jessie Kim", "Bar Manager"],
  ["Oak Boulevard pharmacy, midnight", "Pharmacist Cruz", "Store Manager"],
  ["Natural History Museum, exhibition", "Dr. Pierce", "Curator"],
  ["Greenway supermarket, late shop", "Cashier Rob", "Store Manager"],
  ["The Meeting Place, speed dating", "Host Amanda", "Event Organizer"],
];

const NAME_POOLS = {
  male: [
    "Adrian",
    "Bennett",
    "Calvin",
    "Damian",
    "Elias",
    "Felix",
    "Gideon",
    "Harvey",
    "Isaac",
    "Jonah",
    "Kieran",
    "Lucian",
    "Marlon",
    "Nolan",
    "Oscar",
    "Peter",
    "Quentin",
    "Roman",
    "Silas",
    "Theo",
  ],
  female: [
    "Ada",
    "Beatrice",
    "Clara",
    "Dahlia",
    "Estelle",
    "Flora",
    "Georgia",
    "Hazel",
    "Iris",
    "June",
    "Lenora",
    "Mabel",
    "Nina",
    "Opal",
    "Pearl",
    "Rosalind",
    "Sylvia",
    "Tessa",
    "Vera",
    "Winifred",
  ],
};

const SURNAME_POOL = [
  "Ashdown",
  "Blackwell",
  "Crowley",
  "Davenport",
  "Ellison",
  "Fairchild",
  "Graves",
  "Hawthorne",
  "Iverson",
  "Kingsley",
  "Locke",
  "Marlowe",
  "Norwood",
  "Pryce",
  "Quill",
  "Redmond",
  "Sinclair",
  "Thorne",
  "Vale",
  "Whitmore",
  "Yorke",
  "Langley",
  "Mercer",
  "Sutton",
  "Rook",
  "Bennings",
];

const FACE_FILES = [
  "black1fem",
  "black1male",
  "black2fem",
  "black2male",
  "blonde1fem",
  "blonde1male",
  "blonde2fem",
  "blonde2male",
  "brown1fem",
  "brown1male",
  "brown2fem",
  "brown2male",
  "gray1fem",
  "gray1male",
  "gray2fem",
  "gray2male",
  "red1fem",
  "red1male",
  "red2fem",
  "red2male",
  "white1fem",
  "white1male",
  "white2fem",
  "white2male",
];

export class OllamaController {
  #model;
  #baseUrl;
  #provider;
  #geminiApiKey;
  #openaiApiKey;

  constructor({
    model = GEMINI_MODEL,
    baseUrl = GEMINI_CHAT_URL,
    provider = "gemini",
    geminiApiKey = "",
    openaiApiKey = "",
  } = {}) {
    this.#model = model;
    this.#baseUrl = baseUrl;
    this.#provider = provider;
    this.#geminiApiKey = geminiApiKey;
    this.#openaiApiKey = openaiApiKey;
  }

  setRuntimeConfig({
    provider = "gemini",
    geminiApiKey = "",
    openaiApiKey = "",
  } = {}) {
    this.#provider = provider === "openai" ? "openai" : "gemini";
    this.#geminiApiKey = geminiApiKey ?? "";
    this.#openaiApiKey = openaiApiKey ?? "";
    this.#model = this.#provider === "openai" ? OPENAI_MODEL : GEMINI_MODEL;
    this.#baseUrl =
      this.#provider === "openai" ? OPENAI_CHAT_URL : GEMINI_CHAT_URL;
  }

  // ─── Case Generation ─────────────────────────────────────────────────────

  /**
   * Generate a complete murder mystery case.
   * Uses multiple steps to improve reliability with smaller models:
   * Step 1: Generate full case JSON
   * Step 2: Validate + patch missing fields
   *
   * @returns {Promise<object>} Parsed case data
   */
  async generateCase(difficulty = "medium") {
    const raw = await this.#chat(
      [
        {
          role: "user",
          content:
            FAST_CASE_GENERATION_PROMPT +
            "\n\nGenerate a new original noir murder case now. Keep it vivid, short, and internally consistent.",
        },
      ],
      { temperature: 0.45, expectJson: true },
    );

    return this.#validateAndPatchCase(
      this.#parseJson(raw, "generateCase"),
      difficulty,
    );
  }

  repairVoiceAssignments(caseData) {
    if (!caseData || typeof caseData !== "object") return caseData;

    if (Array.isArray(caseData.suspects)) {
      caseData.suspects = caseData.suspects.map((suspect) =>
        this.#repairPersonVoiceProfile(suspect, "suspect"),
      );
    }

    if (Array.isArray(caseData.witnesses)) {
      caseData.witnesses = caseData.witnesses.map((witness) =>
        this.#repairPersonVoiceProfile(witness, "witness"),
      );
    }

    return caseData;
  }

  // ─── Suspect Interrogation ────────────────────────────────────────────────

  /**
   * Get suspect's response during interrogation.
   * @param {object} suspect  From case data
   * @param {object} caseData Full case data
   * @param {Array}  history  [{role, content}]
   * @param {object} context  { turn, stress }
   * @returns {Promise<{text, stressDelta, confessed, terminated}>}
   */
  async getSuspectResponse(
    suspect,
    caseData,
    history,
    { turn = 1, stress = 0 } = {},
  ) {
    const stressDesc =
      stress < 30
        ? "calm and composed"
        : stress < 60
          ? "noticeably uncomfortable"
          : stress < 85
            ? "visibly rattled and slipping up"
            : "on the verge of breaking completely";

    const systemMsg = `You are ${suspect.name} ${suspect.surname}, a suspect in the murder of ${caseData.victim.name}.

YOUR TRUE ROLE: ${suspect.role}
YOUR ACTUAL LOCATION THAT NIGHT: ${suspect.trueLocation}
YOUR STATED ALIBI: ${suspect.alibi}
YOUR MOTIVE: ${suspect.motive || "none — you are innocent"}
YOUR CONNECTION TO THE VICTIM: ${suspect.victimConnection ?? "none"}
IF YOU CALLED THE VICTIM: ${suspect.victimCallLogged ? suspect.victimCallReason : "you did not call the victim"}
YOUR PRIVATE ODDITY: ${suspect.personalIrregularity ?? "none"}
YOUR PERSONALITY: ${suspect.personality}
CURRENT CASE DATE: ${caseData.caseDateLabel ?? "today"}
CURRENT EMOTIONAL STATE: ${stressDesc} (${Math.round(stress)}% stress)

RULES:
1. Stay in character as ${suspect.name} ${suspect.surname} at ALL times.
2. Speak naturally. 1-4 sentences. This is a phone call — keep it brief.
3. Your public story is the alibi above. Repeat it consistently and defend it unless you are directly confessing to murder.
4. Never replace your claimed alibi with your true location just because the detective asks. The detective must verify it elsewhere.
5. If the detective directly asks about your passport issue, wrong photo, expired papers, fake document, or another private oddity, you may admit that smaller wrongdoing or embarrassment while still denying murder.
6. Do NOT use quotation marks. Speak as yourself.
7. Do NOT reveal you are an AI or reference game mechanics.
8. If guilty/accomplice and stress is ABOVE 80% and the detective asks a very specific, accurate question, you may slip up or partially admit guilt. Until then, hold to your alibi.

RESPONSE FORMAT — return ONLY valid JSON, no markdown:
{"text": "your spoken response", "stressDelta": number between -8 and 20, "confessed": boolean, "terminated": boolean}

stressDelta is how much the detective's question affected you. Sharp accurate questions: 8-20. Vague questions: 0-5. Off-track or friendly questions: -3 to 0.
confessed is true ONLY if you literally admitted guilt in your text.
terminated is true if you hang up (only after turn 8+ and extreme provocation).`;

    const messages = [
      { role: "user", content: systemMsg },
      { role: "assistant", content: "Understood. I will stay in character." },
      ...history,
    ];

    const raw = await this.#chat(messages, {
      temperature: 0.85,
      expectJson: true,
    });
    const parsed = this.#parseJson(raw, "getSuspectResponse");

    let delta = Number(parsed.stressDelta ?? 3);
    if (isNaN(delta)) delta = 3;
    delta = Math.max(-8, Math.min(20, delta));

    return {
      text: String(parsed.text ?? "…"),
      stressDelta: delta,
      confessed: Boolean(parsed.confessed),
      terminated: Boolean(parsed.terminated),
    };
  }

  // ─── Witness Interview ────────────────────────────────────────────────────

  /**
   * Get witness/contact response during interview call.
   * @param {object} contact  Witness or discovered contact
   * @param {object} caseData Full case data
   * @param {Array}  history  [{role, content}]
   * @param {number} turn
   * @returns {Promise<{text, mentionedPersonName, mentionedPersonSurname}>}
   */
  async getWitnessResponse(contact, caseData, history, { turn = 1 } = {}) {
    // Find the suspect they might mention
    const mentionedSuspect = contact.mentionsSuspectId
      ? caseData.suspects.find((s) => s.id === contact.mentionsSuspectId)
      : null;

    const systemMsg = `You are ${contact.name} ${contact.surname}, a ${contact.relationship} who was near the scene when ${caseData.victim.name} was murdered.

WHAT YOU SAW OR KNOW: ${contact.testimony}
${mentionedSuspect ? `PERSON YOU KNOW WHO WAS INVOLVED: ${mentionedSuspect.name} ${mentionedSuspect.surname} (you may mention them by name if relevant)` : ""}
YOUR REASON TO KNOW THE VICTIM: ${contact.victimConnection ?? "you only knew them in passing"}
YOUR PERSONALITY: ${contact.personality}

RULES:
1. You are a civilian, not a suspect. Be cooperative but sometimes vague or distressed.
2. If the detective asks about what you saw, describe it based on your testimony.
3. Keep responses to 2-4 sentences.
4. If relevant and naturally fitting, mention ${mentionedSuspect ? `${mentionedSuspect.name} ${mentionedSuspect.surname}` : "nobody specific"} by full name.
5. Do NOT use quotation marks around your speech.

RESPONSE FORMAT — return ONLY valid JSON, no markdown:
{"text": "your spoken response", "mentionedPersonName": "string or null", "mentionedPersonSurname": "string or null"}`;

    const messages = [
      { role: "user", content: systemMsg },
      { role: "assistant", content: "Understood." },
      ...history,
    ];

    const raw = await this.#chat(messages, {
      temperature: 0.8,
      expectJson: true,
    });
    const parsed = this.#parseJson(raw, "getWitnessResponse");

    return {
      text: String(parsed.text ?? "…"),
      mentionedPersonName: parsed.mentionedPersonName ?? null,
      mentionedPersonSurname: parsed.mentionedPersonSurname ?? null,
    };
  }

  // ─── Evidence Analysis ────────────────────────────────────────────────────

  /**
   * Generate lab analysis result for a collected evidence item.
   * @param {object} evidence  { type, description, analysisResult, belongsToId }
   * @param {object} caseData
   * @returns {Promise<{result: string, belongsToId: string|null}>}
   */
  async analyzeEvidence(evidence, caseData) {
    // The analysis result is pre-generated in case data — we just format it
    // But if it's a newly discovered contact's evidence, we may need to generate it
    if (evidence.analysisResult) {
      return {
        result: evidence.analysisResult,
        belongsToId: evidence.belongsToId ?? null,
      };
    }

    // Fallback: ask Gemini to generate an analysis
    const prompt = `A detective has found this evidence: "${evidence.description}" (type: ${evidence.type}).
Known suspects: ${caseData.suspects.map((s) => `${s.name} ${s.surname} (hair: ${s.hairColor}, blood: ${s.bloodType})`).join(", ")}.
Write a brief forensic lab analysis result (2-3 sentences). Return ONLY valid JSON: {"result": "analysis text", "belongsToId": "suspect id or null"}`;

    const raw = await this.#chat([{ role: "user", content: prompt }], {
      temperature: 0.5,
      expectJson: true,
    });
    const parsed = this.#parseJson(raw, "analyzeEvidence");

    return {
      result: String(parsed.result ?? "Analysis inconclusive."),
      belongsToId: parsed.belongsToId ?? null,
    };
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  /**
   * @param {Array} messages [{role, content}]
   * @param {object} opts
   * @returns {Promise<string>} raw response text
   */
  async #chat(messages, { temperature = 0.8, expectJson = false } = {}) {
    const body = {
      model: this.#model,
      messages,
      temperature,
      expectJson,
      customApiKey:
        this.#provider === "openai"
          ? this.#openaiApiKey || undefined
          : this.#geminiApiKey || undefined,
    };

    try {
      return await this.#requestChat(this.#baseUrl, this.#provider, body);
    } catch (primaryErr) {
      const shouldFallbackToOpenAi =
        this.#provider === "gemini" &&
        !this.#geminiApiKey &&
        /429|high demand|resource_exhausted|quota|rate limit|prepayment credits are depleted|503|500/i.test(
          String(primaryErr?.message ?? primaryErr ?? ""),
        );

      if (!shouldFallbackToOpenAi) {
        throw primaryErr;
      }

      const fallbackBody = {
        ...body,
        model: OPENAI_MODEL,
        customApiKey: this.#openaiApiKey || undefined,
      };

      return this.#requestChat(
        OPENAI_CHAT_URL,
        "openai",
        fallbackBody,
        primaryErr,
      );
    }
  }

  async #requestChat(baseUrl, providerLabel, body, previousError = null) {
    let response;
    try {
      response = await fetch(baseUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (networkErr) {
      if (previousError) throw previousError;
      throw new Error(
        `[OllamaController] Cannot reach the ${providerLabel} server route. ` +
          `Make sure ${baseUrl} is available and the matching API key is configured. ` +
          `Network error: ${networkErr.message}`,
      );
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => response.statusText);
      const error = new Error(
        `[OllamaController] ${providerLabel} API error ${response.status}: ${errText}`,
      );
      if (previousError) throw previousError;
      throw error;
    }

    const data = await response.json();
    const content = data?.text;

    if (!content) {
      if (previousError) throw previousError;
      throw new Error(`[OllamaController] Empty response from ${providerLabel}.`);
    }

    return content;
  }

  /**
   * Parse JSON from model output, stripping markdown fences if present.
   */
  #parseJson(raw, caller = "unknown") {
    let cleaned = raw.trim();
    // Strip ```json ... ``` or ``` ... ``` fences
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
    // Sometimes the model wraps in extra text before/after — find the JSON object
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) cleaned = match[0];

    try {
      return JSON.parse(cleaned);
    } catch (err) {
      console.error(
        `[OllamaController.${caller}] Failed to parse JSON:`,
        cleaned.slice(0, 300),
      );
      throw new Error(
        `[OllamaController.${caller}] Model returned invalid JSON. Check console.`,
      );
    }
  }

  /**
   * Validate case data and fill in any missing fields gracefully.
   */
  #validateAndPatchCase(data, difficulty = "medium") {
    if (!Array.isArray(data.suspects) || data.suspects.length < 2) {
      throw new Error(
        "[OllamaController] Case generation produced too few suspects. Try again.",
      );
    }

    const now = new Date();
    const futureExpiry = () => {
      const yr = now.getFullYear() + Math.floor(Math.random() * 8 + 2);
      const mo = String(Math.floor(Math.random() * 12) + 1).padStart(2, "0");
      return `${mo}/${yr}`;
    };
    const pastExpiry = () => {
      const yr = now.getFullYear() - Math.floor(Math.random() * 5 + 1);
      const mo = String(Math.floor(Math.random() * 12) + 1).padStart(2, "0");
      return `${mo}/${yr}`;
    };
    const recentIssue = () => {
      const yr = now.getFullYear() - Math.floor(Math.random() * 7 + 1);
      const mo = String(Math.floor(Math.random() * 12) + 1).padStart(2, "0");
      return `${mo}/${yr}`;
    };
    const randomId = (prefix) =>
      `${prefix}${String(Math.floor(100000 + Math.random() * 900000))}`;
    const randomPhone = () =>
      `(555) ${String(Math.floor(Math.random() * 900 + 100))}-${String(Math.floor(Math.random() * 9000 + 1000))}`;
    const usedPhones = new Set();
    const uniquePhone = () => {
      let phone = randomPhone();
      while (usedPhones.has(phone)) phone = randomPhone();
      usedPhones.add(phone);
      return phone;
    };
    const claimPhone = (candidate) => {
      if (candidate && !usedPhones.has(candidate)) {
        usedPhones.add(candidate);
        return candidate;
      }
      return uniquePhone();
    };

    if (!Array.isArray(data.suspects)) data.suspects = [];

    const culpritIds = Array.from(
      new Set([
        data.guiltyId,
        ...(Array.isArray(data.accompliceIds) ? data.accompliceIds : []),
        ...data.suspects
          .filter((s) => s.role === "guilty" || s.role === "accomplice")
          .map((s) => s.id),
      ].filter(Boolean)),
    ).slice(0, 3);

    if (culpritIds.length === 0) {
      culpritIds.push(data.suspects[0]?.id ?? "S1");
    }

    const usedPhotos = new Set();

    while (data.suspects.length < 10) data.suspects.push({});

    data.suspects = data.suspects.slice(0, 10).map((suspect, i) => {
      const gender = this.#normalizeGender(suspect.gender);
      const age = suspect.age ?? 35;
      const birthYear = now.getFullYear() - age;
      const birthMonth = String(Math.floor(Math.random() * 12) + 1).padStart(
        2,
        "0",
      );
      const birthDay = String(Math.floor(Math.random() * 28) + 1).padStart(
        2,
        "0",
      );
      const trueDOB = `${birthDay}/${birthMonth}/${birthYear}`;
      const hairColor = suspect.hairColor ?? "brown";
      const officialPhoto = this.#pickUniquePassportPhoto({
        hairColor,
        gender,
        usedPhotos,
      });
      const isFake = Boolean(suspect.passportFake);
      const discrepancy = suspect.passportDiscrepancy ?? null;
      const flags = this.#derivePassportFlags(discrepancy, isFake);

      const alibiPreset =
        suspect.alibiLocation &&
        !this.#looksPlaceholder(suspect.alibiLocation) &&
        suspect.alibiLocation !== "Unknown location"
          ? null
          : ALIBI_PRESETS[Math.floor(Math.random() * ALIBI_PRESETS.length)];
      const alibiVerifier = this.#deriveAlibiVerifier(suspect, alibiPreset, i);
      const claimedAlibi = this.#buildClaimedAlibi(alibiVerifier.location);

      const official = {
        id_number: suspect.passportId ?? randomId("PX"),
        address: suspect.passportAddress ?? `${i + 11} Mercer Street`,
        nationality: suspect.passportNationality ?? "American",
        issue_date: suspect.passportIssue ?? recentIssue(),
        expiry_date: futureExpiry(),
        date_of_birth: trueDOB,
        phone_number: claimPhone(suspect.phoneNumber),
        passportPhotoFile: officialPhoto,
      };

      const provided = { ...official, uvFlags: {} };
      if (flags.expired) provided.expiry_date = pastExpiry();
      if (flags.wrongDob) {
        const wrongYear = birthYear + (Math.random() > 0.5 ? 1 : -1);
        provided.date_of_birth = `${birthDay}/${birthMonth}/${wrongYear}`;
      }
      if (flags.wrongInfo) {
        provided.id_number = randomId("FD");
        provided.address = `${i + 40} Blackwater Avenue`;
        if (Math.random() > 0.45) {
          provided.phone_number = uniquePhone();
        }
      }

      provided.passportPhotoFile = flags.wrongPhoto
        ? this.#pickUniquePassportPhoto({
            hairColor,
            gender,
            usedPhotos,
            forceDifferentColor: true,
          })
        : official.passportPhotoFile;

      provided.uvFlags = {
        photo: "ok",
        id_number: flags.wrongInfo ? "fake" : "ok",
        surname: "ok",
        given_name: "ok",
        date_of_birth: flags.wrongInfo || flags.wrongDob ? "fake" : "ok",
        nationality: flags.wrongInfo ? "fake" : "ok",
        phone_number: flags.wrongInfo ? "fake" : "ok",
        address: flags.wrongInfo ? "fake" : "ok",
        issue_date: "ok",
        expiry_date: flags.wrongInfo ? "fake" : "ok",
      };

      const victimConnection =
        suspect.victimConnection ??
        this.#buildVictimConnection(suspect.occupation ?? "associate");
      const victimCallReason =
        suspect.victimCallReason ??
        this.#buildVictimCallReason(suspect.occupation ?? "associate");
      const personalIrregularity =
        suspect.personalIrregularity ??
        this.#buildPersonalIrregularity({
          occupation: suspect.occupation ?? "associate",
          flags,
          isFake,
        });

      return {
        id: suspect.id ?? `S${i + 1}`,
        name: suspect.name ?? "",
        surname: suspect.surname ?? "",
        age,
        occupation: this.#normalizeCaseText(suspect.occupation, "Private contractor"),
        role: "innocent",
        motive: suspect.motive ?? "",
        alibi: claimedAlibi,
        alibiTrue: suspect.alibiTrue ?? true,
        trueLocation:
          this.#normalizeCaseText(suspect.trueLocation, claimedAlibi) ??
          alibiVerifier.location,
        personality: suspect.personality ?? "reserved",
        victimConnection,
        victimCallReason,
        personalIrregularity,
        voiceArchetype: this.#normalizeVoiceArchetype(
          suspect.voiceArchetype,
          gender,
          "suspect",
        ),
        openingMood: suspect.openingMood ?? "guarded",
        passportId: official.id_number,
        passportAddress: official.address,
        passportNationality: official.nationality,
        passportIssue: official.issue_date,
        passportExpiry: official.expiry_date,
        passportFake: isFake,
        passportDiscrepancy: discrepancy,
        hairColor,
        bloodType: suspect.bloodType ?? "O",
        gender,
        dateOfBirth: trueDOB,
        passportPhotoFile: official.passportPhotoFile,
        providedPassport: provided,
        alibiLocation: alibiVerifier.location,
        alibiVerifierName: alibiVerifier.name,
        alibiVerifierTitle: alibiVerifier.title,
        alibiDetails: alibiVerifier.details,
        phoneNumber: official.phone_number,
        victimCallLogged: false,
        voiceId: this.#resolveVoiceId(
          this.#normalizeVoiceArchetype(
            suspect.voiceArchetype,
            gender,
            "suspect",
          ),
          gender,
        ),
        caseNotes: "",
      };
    });

    this.#uniquifyIdentities(data.suspects);

    data.guiltyId = culpritIds[0] ?? data.suspects[0].id;
    data.accompliceIds = culpritIds.slice(1);
    data.suspects = data.suspects.map((suspect) => ({
      ...suspect,
      role:
        suspect.id === data.guiltyId
          ? "guilty"
          : data.accompliceIds.includes(suspect.id)
            ? "accomplice"
            : "innocent",
    }));
    this.#forcePassportIrregularities(data.suspects);

    if (!Array.isArray(data.witnesses)) data.witnesses = [];
    const witnessTarget = Math.min(3, Math.max(2, data.witnesses.length || 2));
    while (data.witnesses.length < witnessTarget) data.witnesses.push({});

    data.witnesses = data.witnesses.slice(0, witnessTarget).map((witness, i) => {
      const gender = this.#normalizeGender(witness.gender);
      const age = witness.age ?? 34;
      const birthYear = now.getFullYear() - age;
      const birthMonth = String(Math.floor(Math.random() * 12) + 1).padStart(
        2,
        "0",
      );
      const birthDay = String(Math.floor(Math.random() * 28) + 1).padStart(
        2,
        "0",
      );
      const dob = `${birthDay}/${birthMonth}/${birthYear}`;
      const linkedSuspect =
        data.suspects.find((s) => s.id === witness.mentionsSuspectId) ??
        data.suspects[i % data.suspects.length];

      return {
        id: witness.id ?? `W${i + 1}`,
        name: witness.name ?? "",
        surname: witness.surname ?? "",
        relationship: witness.relationship ?? "witness",
        personality: witness.personality ?? "cooperative, shaken",
        voiceArchetype: this.#normalizeVoiceArchetype(
          witness.voiceArchetype,
          gender,
          "witness",
        ),
        testimony:
          witness.testimony ??
          `I saw ${linkedSuspect.name} ${linkedSuspect.surname} near ${data.victim?.foundAt ?? "the scene"} not long before ${data.victim?.timeOfDeath ?? "the murder"}. They looked tense and were moving fast.`,
        mentionsSuspectId: linkedSuspect.id,
        victimConnection:
          witness.victimConnection ??
          "The victim knew me by sight and called me once in a while.",
        phoneNumber: claimPhone(witness.phoneNumber),
        passportId: witness.passportId ?? randomId("WT"),
        passportAddress: witness.passportAddress ?? `${i + 3} Willow Lane`,
        passportNationality: witness.passportNationality ?? "American",
        passportIssue: witness.passportIssue ?? recentIssue(),
        passportExpiry: futureExpiry(),
        passportFake: false,
        passportDiscrepancy: null,
        gender,
        dateOfBirth: dob,
        passportDOB: dob,
        passportPhotoFile: this.#pickUniquePassportPhoto({
          hairColor: witness.hairColor ?? "brown",
          gender,
          usedPhotos,
        }),
        passportPhotoWrong: false,
        hairColor: witness.hairColor ?? "brown",
        voiceId: this.#resolveVoiceId(
          this.#normalizeVoiceArchetype(
            witness.voiceArchetype,
            gender,
            "witness",
          ),
          gender,
        ),
        victimCallReason:
          witness.victimCallReason ??
          "I was returning a missed call about something routine.",
        victimCallLogged: false,
      };
    });

    this.#uniquifyIdentities(data.witnesses, data.suspects);

    if (!Array.isArray(data.victimEvidence)) data.victimEvidence = [];
    data.victimEvidence = data.victimEvidence.map((e, i) => ({
      id: e.id ?? `VE${i + 1}`,
      type: e.type ?? "hair",
      description: e.description ?? "Uncatalogued trace evidence",
      analysisResult: e.analysisResult ?? "Analysis pending.",
      belongsToId: e.belongsToId ?? null,
    }));

    const victimPhone = uniquePhone();
    data.victim = {
      name: this.#normalizeCaseText(data.victim?.name, "Elaine Mercer"),
      age: data.victim?.age ?? 45,
      occupation: this.#normalizeCaseText(data.victim?.occupation, "Socialite"),
      foundAt: this.#normalizeCaseText(data.victim?.foundAt, "Riverton Heights penthouse"),
      timeOfDeath: this.#normalizeCaseText(data.victim?.timeOfDeath, "11:20 PM"),
      causeOfDeath: this.#normalizeCaseText(data.victim?.causeOfDeath, "single fatal wound"),
      weapon: this.#normalizeCaseText(data.victim?.weapon, "knife"),
      hairColor: data.victim?.hairColor ?? "brown",
      bloodType: data.victim?.bloodType ?? "O",
      phoneNumber: victimPhone,
    };

    data.phoneCalls = this.#generatePhoneCalls(data, victimPhone);
    data.caseDateISO = now.toISOString();
    data.caseDateLabel = now.toLocaleDateString("en-US", {
      day: "2-digit",
      month: "long",
      year: "numeric",
    });
    data.caseNumber =
      data.caseNumber ??
      String(Math.floor(100000 + Math.random() * 900000));
    data.difficulty = ["easy", "medium", "expert"].includes(difficulty)
      ? difficulty
      : "medium";
    data.caseTitle = data.caseTitle ?? "Untitled Case";
    data.storyBrief = data.storyBrief ?? "A murder investigation.";

    this.#applyDifficultyTuning(data);

    data.suspects = data.suspects.map((suspect) => ({
      ...suspect,
      caseNotes: this.#buildCaseNotes(suspect),
      sceneItems: this.#buildSuspectSceneItems(suspect, data),
    }));
    data.victim.sceneItems = this.#buildVictimSceneItems(data);

    return data;
  }

  #normalizeGender(gender) {
    return gender === "female" || gender === "male"
      ? gender
      : Math.random() > 0.5
        ? "male"
        : "female";
  }

  #inferStableGender(person = {}) {
    const direct = String(person.gender ?? "").toLowerCase();
    if (direct === "female" || direct === "male") return direct;

    const photo = String(
      person.passportPhotoFile ??
        person.providedPassport?.passportPhotoFile ??
        "",
    ).toLowerCase();
    if (photo.endsWith("fem")) return "female";
    if (photo.endsWith("male")) return "male";

    const name = String(person.name ?? "").trim();
    if (NAME_POOLS.female.includes(name)) return "female";
    if (NAME_POOLS.male.includes(name)) return "male";

    const archetype = String(person.voiceArchetype ?? "").toLowerCase();
    if (archetype.includes("female")) return "female";
    if (archetype.includes("male")) return "male";

    return "male";
  }

  #normalizeVoiceArchetype(archetype = "", gender = "male", role = "suspect") {
    const normalized = String(archetype ?? "").trim().toLowerCase();
    const femaleVoices = [
      "calm female",
      "nervous female",
      "cold female",
      "young female",
    ];
    const maleVoices = [
      "smooth male",
      "gruff male",
      "intimidating male",
      "weary male",
      "evasive male",
    ];
    const isFemale = String(gender ?? "male").toLowerCase() === "female";
    const fallback = isFemale
      ? role === "witness"
        ? "calm female"
        : "nervous female"
      : role === "witness"
        ? "smooth male"
        : "gruff male";

    if (!normalized) return fallback;
    if (isFemale) {
      return femaleVoices.includes(normalized) ? normalized : fallback;
    }
    return maleVoices.includes(normalized) ? normalized : fallback;
  }

  #repairPersonVoiceProfile(person, role = "suspect") {
    if (!person || typeof person !== "object") return person;
    const gender = this.#inferStableGender(person);
    const voiceArchetype = this.#normalizeVoiceArchetype(
      person.voiceArchetype,
      gender,
      role,
    );
    return {
      ...person,
      gender,
      voiceArchetype,
      voiceId: this.#resolveVoiceId(voiceArchetype, gender),
    };
  }

  #uniquifyIdentities(people, existingPeople = []) {
    const usedFirst = new Set(
      existingPeople.map((p) => String(p.name ?? "").toLowerCase()),
    );
    const usedSurname = new Set(
      existingPeople.map((p) => String(p.surname ?? "").toLowerCase()),
    );

    people.forEach((person) => {
      person.name = this.#pickUniqueFirstName(person.name, person.gender, usedFirst);
      usedFirst.add(person.name.toLowerCase());
      person.surname = this.#pickUniqueSurname(person.surname, usedSurname);
      usedSurname.add(person.surname.toLowerCase());
    });
  }

  #pickUniqueFirstName(baseName, gender, used) {
    const trimmed = String(baseName ?? "").trim();
    if (
      trimmed &&
      !used.has(trimmed.toLowerCase()) &&
      !this.#looksPlaceholder(trimmed)
    ) {
      return trimmed;
    }

    const pool = NAME_POOLS[gender === "female" ? "female" : "male"];
    const candidate =
      pool.find((name) => !used.has(name.toLowerCase())) ??
      pool[Math.floor(Math.random() * pool.length)];
    return candidate;
  }

  #pickUniqueSurname(baseSurname, used) {
    const trimmed = String(baseSurname ?? "").trim();
    if (
      trimmed &&
      !used.has(trimmed.toLowerCase()) &&
      !this.#looksPlaceholder(trimmed)
    ) {
      return trimmed;
    }

    const candidate =
      SURNAME_POOL.find((surname) => !used.has(surname.toLowerCase())) ??
      SURNAME_POOL[Math.floor(Math.random() * SURNAME_POOL.length)];
    return candidate;
  }

  #looksPlaceholder(value) {
    const text = String(value ?? "").trim().toLowerCase();
    return (
      !text ||
      text === "unknown" ||
      text === "subject" ||
      text === "witness" ||
      text === "contact" ||
      text === "unknown contact" ||
      text === "none" ||
      text === "n/a" ||
      text === "not known"
    );
  }

  #normalizeCaseText(value, fallback) {
    return this.#looksPlaceholder(value) ? fallback : String(value ?? fallback).trim();
  }

  #buildClaimedAlibi(location) {
    return `Claimed to be at ${location}.`;
  }

  #applyDifficultyTuning(data) {
    const difficulty = data.difficulty ?? "medium";
    const involvedIds = new Set([data.guiltyId, ...(data.accompliceIds ?? [])]);

    if (difficulty === "easy") {
      data.witnesses = data.witnesses.slice(0, 3);
      data.suspects = data.suspects.map((suspect, index) => {
        const involved = involvedIds.has(suspect.id);
        const keepPassportIssue = involved || index < 2;
        if (!keepPassportIssue) {
          suspect.passportFake = false;
          suspect.passportDiscrepancy = null;
          suspect.providedPassport = {
            ...suspect.providedPassport,
            id_number: suspect.passportId,
            address: suspect.passportAddress,
            nationality: suspect.passportNationality,
            issue_date: suspect.passportIssue,
            expiry_date: suspect.passportExpiry,
            date_of_birth: suspect.dateOfBirth,
            phone_number: suspect.phoneNumber,
            passportPhotoFile: suspect.passportPhotoFile,
            uvFlags: {
              photo: "ok",
              id_number: "ok",
              surname: "ok",
              given_name: "ok",
              date_of_birth: "ok",
              nationality: "ok",
              phone_number: "ok",
              address: "ok",
              issue_date: "ok",
              expiry_date: "ok",
            },
          };
        }
        if (involved) suspect.alibiTrue = false;
        return suspect;
      });
    } else if (difficulty === "expert") {
      data.witnesses = data.witnesses.slice(0, 2);
      data.suspects.forEach((suspect, index) => {
        if (!involvedIds.has(suspect.id) && index % 2 === 0) {
          suspect.passportFake = true;
        }
      });
    }
  }

  #deriveAlibiVerifier(suspect, preset, index) {
    const location =
      this.#normalizeCaseText(suspect.alibiLocation, preset?.[0] ?? "Riverton Apartments") ??
      "Riverton Apartments";
    const lowered = location.toLowerCase();
    const fallbackNames = [
      "Mason Cole",
      "Nina Holloway",
      "Victor Reed",
      "Lena Barrett",
      "Samuel Pike",
      "Evelyn Frost",
      "Derek Miles",
      "Claudia Shaw",
      "Martin Doyle",
      "Rita Vance",
    ];
    const generatedName = fallbackNames[index % fallbackNames.length];

    let title = this.#normalizeCaseText(suspect.alibiVerifierTitle, preset?.[2] ?? "");
    let name = this.#normalizeCaseText(suspect.alibiVerifierName, preset?.[1] ?? generatedName);
    let details = this.#normalizeCaseText(suspect.alibiDetails, "");

    if (!title || this.#looksPlaceholder(title)) {
      if (/(apartment|flat|residence|home|building|tower|condo)/i.test(lowered)) {
        title = "Building Superintendent";
        if (!details) details = "Can check the lobby log and elevator camera for that night.";
      } else if (/(hotel|inn)/i.test(lowered)) {
        title = "Night Receptionist";
        if (!details) details = "Can verify whether they checked in or came through the lobby.";
      } else if (/(theater|theatre|cinema|show)/i.test(lowered)) {
        title = "Venue Manager";
        if (!details) details = "Can review ticket scans and front-of-house notes.";
      } else if (/(restaurant|grill|pub|bar|club|lounge|cafe|dinner)/i.test(lowered)) {
        title = "Floor Manager";
        if (!details) details = "Can check reservations, tabs, and the staff log.";
      } else if (/(gallery|museum|library)/i.test(lowered)) {
        title = "Front Desk Supervisor";
        if (!details) details = "Can confirm the visitor sign-in sheet.";
      } else if (/(hospital|clinic)/i.test(lowered)) {
        title = "Reception Clerk";
        if (!details) details = "Can check visitor records from the desk.";
      } else if (/(gym|studio|pool)/i.test(lowered)) {
        title = "Shift Manager";
        if (!details) details = "Can confirm the entry scanner and late-night staff notes.";
      } else if (/(train|station|ferry|airport)/i.test(lowered)) {
        title = "Shift Supervisor";
        if (!details) details = "Can review departures and camera logs.";
      } else if (/(church|chapel)/i.test(lowered)) {
        title = "Caretaker";
        if (!details) details = "Can confirm whether they stayed through the service.";
      } else if (/(market|pharmacy|store|supermarket|bookstore)/i.test(lowered)) {
        title = "Store Supervisor";
        if (!details) details = "Can review the till record and security feed.";
      } else {
        title = preset?.[2] ?? "Duty Manager";
        if (!details) details = "Can check the venue notes for that evening.";
      }
    }

    if (!name || this.#looksPlaceholder(name)) {
      name = preset?.[1] ?? generatedName;
    }
    if (!details) {
      details = "Can confirm whether they were actually there that night.";
    }

    return { location, name, title, details };
  }

  #derivePassportFlags(discrepancy, isFake) {
    if (!isFake) {
      return {
        wrongPhoto: false,
        wrongDob: false,
        wrongInfo: false,
        expired: false,
      };
    }

    const text = String(discrepancy ?? "").toLowerCase();
    const flags = {
      wrongPhoto:
        text.includes("photo") ||
        text.includes("image") ||
        text.includes("picture"),
      wrongDob:
        text.includes("birth") || text.includes("dob") || text.includes("date"),
      wrongInfo:
        text.includes("address") ||
        text.includes("id") ||
        text.includes("national") ||
        text.includes("name") ||
        text.includes("document"),
      expired:
        text.includes("expir") || text.includes("out of date") || false,
    };

    if (!Object.values(flags).some(Boolean)) {
      flags.wrongInfo = true;
    }

    if (!flags.wrongPhoto && Math.random() < 0.28) flags.wrongPhoto = true;
    if (!flags.wrongDob && Math.random() < 0.33) flags.wrongDob = true;
    if (!flags.expired && Math.random() < 0.28) flags.expired = true;

    return flags;
  }

  #forcePassportIrregularities(suspects) {
    if (!Array.isArray(suspects) || suspects.length === 0) return;

    const patterns = [
      { wrongPhoto: true },
      { expired: true },
      { wrongInfo: true, wrongDob: true },
      { wrongInfo: true },
    ];

    suspects.forEach((suspect) => {
      suspect.passportFake = Boolean(suspect.passportFake);
      suspect.passportDiscrepancy = suspect.passportDiscrepancy ?? null;
    });

    const alreadyFlagged = suspects.filter(
      (suspect) =>
        suspect.passportFake ||
        suspect.providedPassport?.passportPhotoFile !== suspect.passportPhotoFile ||
        suspect.providedPassport?.expiry_date !== suspect.passportExpiry ||
        suspect.providedPassport?.id_number !== suspect.passportId ||
        suspect.providedPassport?.address !== suspect.passportAddress ||
        suspect.providedPassport?.date_of_birth !== suspect.dateOfBirth,
    );

    let patternIndex = 0;
    suspects.forEach((suspect, idx) => {
      if (alreadyFlagged.includes(suspect)) return;
      if (patternIndex >= patterns.length) return;
      if (idx % 2 !== 0 && idx > 5) return;
      this.#applyPassportFlagsToSuspect(suspect, patterns[patternIndex]);
      patternIndex += 1;
    });
  }

  #applyPassportFlagsToSuspect(suspect, flags) {
    if (!suspect?.providedPassport) return;

    suspect.passportFake = Boolean(
      flags.wrongPhoto || flags.wrongDob || flags.wrongInfo,
    );
    const provided = suspect.providedPassport;

    if (flags.expired) {
      const parts = String(suspect.passportIssue ?? "03/2018").split("/");
      const month = parts[0] ?? "03";
      const issueYear = Number(parts[1] ?? 2018);
      provided.expiry_date = `${month}/${Math.max(2019, issueYear + 4)}`;
      suspect.passportDiscrepancy ??= "expired passport";
    }

    if (flags.wrongDob) {
      const [day, month, year] = String(suspect.dateOfBirth ?? "01/01/1990").split("/");
      provided.date_of_birth = `${day}/${month}/${Number(year) + 1}`;
      suspect.passportDiscrepancy ??= "birth date altered";
    }

    if (flags.wrongInfo) {
      provided.id_number = `FD${String(Math.floor(100000 + Math.random() * 900000))}`;
      provided.address = `${Math.floor(Math.random() * 90) + 10} Harrow Street, Riverton`;
      provided.phone_number = suspect.phoneNumber;
      suspect.passportDiscrepancy ??= "document details altered";
    }

    if (flags.wrongPhoto) {
      provided.passportPhotoFile = this.#pickDifferentPassportPhoto(
        suspect.passportPhotoFile,
        suspect.gender,
      );
      suspect.passportDiscrepancy ??= "passport photo mismatch";
    }

    provided.uvFlags = {
      ...(provided.uvFlags ?? {}),
      photo: flags.wrongPhoto ? "ok" : (provided.uvFlags?.photo ?? "ok"),
      id_number: flags.wrongInfo ? "fake" : (provided.uvFlags?.id_number ?? "ok"),
      date_of_birth:
        flags.wrongDob || flags.wrongInfo
          ? "fake"
          : (provided.uvFlags?.date_of_birth ?? "ok"),
      nationality: flags.wrongInfo ? "fake" : (provided.uvFlags?.nationality ?? "ok"),
      phone_number: flags.wrongInfo ? "fake" : (provided.uvFlags?.phone_number ?? "ok"),
      address: flags.wrongInfo ? "fake" : (provided.uvFlags?.address ?? "ok"),
      expiry_date: flags.wrongInfo ? "fake" : (provided.uvFlags?.expiry_date ?? "ok"),
    };
    suspect.personalIrregularity = this.#buildPersonalIrregularity({
      occupation: suspect.occupation,
      flags: {
        wrongPhoto:
          provided.passportPhotoFile !== suspect.passportPhotoFile,
        wrongDob: provided.date_of_birth !== suspect.dateOfBirth,
        wrongInfo:
          provided.id_number !== suspect.passportId ||
          provided.address !== suspect.passportAddress ||
          provided.phone_number !== suspect.phoneNumber,
        expired: provided.expiry_date !== suspect.passportExpiry,
      },
      isFake: true,
    });
  }

  #pickUniquePassportPhoto({
    hairColor,
    gender,
    usedPhotos,
    forceDifferentColor = false,
  }) {
    const wantedColor = this.#hairCategory(hairColor);
    const wantedSuffix = gender === "female" ? "fem" : "male";

    let candidates = FACE_FILES.filter(
      (file) =>
        file.endsWith(wantedSuffix) &&
        !usedPhotos.has(file) &&
        (forceDifferentColor
          ? !file.startsWith(wantedColor)
          : file.startsWith(wantedColor)),
    );

    if (candidates.length === 0) {
      candidates = FACE_FILES.filter(
        (file) =>
          file.endsWith(wantedSuffix) &&
          !usedPhotos.has(file) &&
          (!forceDifferentColor || !file.startsWith(wantedColor)),
      );
    }

    if (candidates.length === 0) {
      candidates = FACE_FILES.filter((file) => !usedPhotos.has(file));
    }

    const choice =
      candidates[Math.floor(Math.random() * candidates.length)] ??
      FACE_FILES[Math.floor(Math.random() * FACE_FILES.length)];
    usedPhotos.add(choice);
    return choice;
  }

  #pickDifferentPassportPhoto(currentPhoto, gender) {
    const suffix = gender === "female" ? "fem" : "male";
    const candidates = FACE_FILES.filter(
      (file) => file.endsWith(suffix) && file !== currentPhoto,
    );
    return (
      candidates[Math.floor(Math.random() * candidates.length)] ??
      FACE_FILES.find((file) => file !== currentPhoto) ??
      currentPhoto
    );
  }

  #hairCategory(hairColor) {
    const h = String(hairColor ?? "brown").toLowerCase().trim();
    if (h.includes("black") || h.includes("raven") || h.includes("jet"))
      return "black";
    if (
      h.includes("blond") ||
      h.includes("golden") ||
      h.includes("fair") ||
      h.includes("light")
    )
      return "blonde";
    if (
      h.includes("red") ||
      h.includes("auburn") ||
      h.includes("ginger") ||
      h.includes("copper")
    )
      return "red";
    if (h.includes("white") || h.includes("silver")) return "white";
    if (h.includes("grey") || h.includes("gray")) return "gray";
    return "brown";
  }

  #generatePhoneCalls(data, victimPhone) {
    const durations = [
      "0 min 18 sec",
      "0 min 42 sec",
      "1 min 06 sec",
      "1 min 34 sec",
      "2 min 11 sec",
      "2 min 47 sec",
      "3 min 19 sec",
      "4 min 08 sec",
      "5 min 02 sec",
    ];
    const pick = (items) => items[Math.floor(Math.random() * items.length)];
    const formatTime = (minutes) => {
      const h24 = Math.floor(minutes / 60);
      const mins = minutes % 60;
      const suffix = h24 >= 12 ? "PM" : "AM";
      const h12 = ((h24 + 11) % 12) + 1;
      return `${h12}:${String(mins).padStart(2, "0")} ${suffix}`;
    };
    const allCallers = [...data.suspects, ...data.witnesses];
    const calls = [];
    let counter = 1;

    const addCall = (caller, start, end) => {
      const minute = start + Math.floor(Math.random() * (end - start + 1));
      caller.victimCallLogged = true;
      calls.push({
        id: `PC_${counter++}`,
        fromPersonId: caller.id,
        fromNumber: caller.phoneNumber,
        toNumber: victimPhone,
        time: formatTime(minute),
        sortMinute: minute,
        duration: pick(durations),
      });
    };

    data.suspects.forEach((suspect) => {
      const involved =
        suspect.id === data.guiltyId || data.accompliceIds.includes(suspect.id);
      const difficulty = data.difficulty ?? "medium";
      const count = involved
        ? difficulty === "easy"
          ? 2
          : difficulty === "expert"
            ? 1
            : Math.floor(Math.random() * 2) + 1
        : difficulty === "easy"
          ? Math.random() < 0.12
            ? 1
            : 0
          : difficulty === "expert"
            ? Math.random() < 0.42
              ? 1
              : 0
            : Math.random() < 0.32
              ? 1
              : 0;
      for (let i = 0; i < count; i++) {
        addCall(suspect, involved ? 20 * 60 + 20 : 18 * 60 + 10, 23 * 60 + 20);
      }
    });

    data.witnesses.forEach((witness) => {
      const count =
        data.difficulty === "easy"
          ? Math.random() < 0.25
            ? 1
            : 0
          : data.difficulty === "expert"
            ? Math.random() < 0.55
              ? 1
              : 0
            : Math.random() < 0.45
              ? 1
              : 0;
      for (let i = 0; i < count; i++) {
        addCall(witness, 18 * 60 + 30, 23 * 60 + 35);
      }
    });

    const extra =
      data.difficulty === "easy"
        ? 0
        : data.difficulty === "expert"
          ? 2
          : Math.floor(Math.random() * 2) + 1;
    for (let i = 0; i < extra; i++) {
      addCall(pick(allCallers), 18 * 60, 23 * 60 + 45);
    }

    return calls
      .sort((a, b) => a.sortMinute - b.sortMinute)
      .map(({ sortMinute, ...call }) => call);
  }

  #buildVictimConnection(occupation) {
    const role = String(occupation ?? "associate").toLowerCase();
    if (role.includes("designer") || role.includes("tailor"))
      return "The victim had been borrowing wardrobe pieces and fittings.";
    if (role.includes("journalist") || role.includes("writer"))
      return "The victim was feeding me bits of gossip and background.";
    if (role.includes("bartender") || role.includes("owner"))
      return "The victim was a regular and often handled private meetings there.";
    if (role.includes("lawyer") || role.includes("accountant"))
      return "The victim had asked for quiet advice about money.";
    if (role.includes("actor") || role.includes("musician"))
      return "We moved in the same social circuit and traded favors.";
    return "The victim knew me through business and occasional favors.";
  }

  #buildVictimCallReason(occupation) {
    const role = String(occupation ?? "associate").toLowerCase();
    if (role.includes("designer") || role.includes("tailor"))
      return "The victim was asking to borrow or alter clothing before the evening.";
    if (role.includes("driver") || role.includes("mechanic"))
      return "The victim called about transport and a last-minute pickup.";
    if (role.includes("lawyer") || role.includes("accountant"))
      return "The victim wanted to discuss papers and a problem with money.";
    if (role.includes("bartender") || role.includes("owner"))
      return "The victim was asking whether someone had shown up at the venue.";
    if (role.includes("doctor") || role.includes("nurse"))
      return "The victim wanted a discreet favor and a quick answer.";
    return "The victim called about a personal favor that sounded harmless at the time.";
  }

  #buildPersonalIrregularity({ occupation, flags, isFake }) {
    if (flags.expired) {
      return "They let the passport expire months ago after ignoring renewal notices while juggling debts and missed appointments.";
    }
    if (flags.wrongPhoto) {
      return "They swapped the photo after a panicked shoplifting arrest and kept the forged document out of fear.";
    }
    if (flags.wrongInfo || isFake) {
      const role = String(occupation ?? "associate").toLowerCase();
      if (role.includes("artist") || role.includes("gallery")) {
        return "They altered the document details after quietly selling stolen gallery stock under another name.";
      }
      if (role.includes("bartender") || role.includes("owner")) {
        return "They changed passport details to hide an off-the-books side hustle and a prior robbery complaint.";
      }
      if (role.includes("accountant") || role.includes("lawyer")) {
        return "They forged part of the document to dodge attention after skimming cash from a private client.";
      }
      return "They falsified passport details after a petty robbery and have been terrified of being identified ever since.";
    }

    const role = String(occupation ?? "associate").toLowerCase();
    if (role.includes("actor") || role.includes("musician"))
      return "They are hiding a side job and do not want it in the papers.";
    if (role.includes("lawyer") || role.includes("accountant"))
      return "They lied about where they spent part of the evening to avoid embarrassment.";
    if (role.includes("bartender") || role.includes("owner"))
      return "They quietly served someone after hours and do not want that known.";
    return "There is a small private detail they would rather not explain unless pressed.";
  }

  #buildCaseNotes(suspect) {
    return suspect.alibi ?? `Claimed to be at ${suspect.alibiLocation}.`;
  }

  #buildVictimSceneItems(data) {
    const evidence = (data.victimEvidence ?? []).map((item, index) => ({
      ...item,
      id: item.id ?? `VE${index + 1}`,
      sceneCategory: "analysis",
      label: this.#labelForEvidenceType(item.type, index),
      subtitle: this.#sceneSubtitleForType(item.type),
      spriteSrc: this.#spriteForEvidenceType(item.type),
      recoveredFromId: "VICTIM",
      recoveredFromLabel: `${data.victim?.name ?? "Victim"} scene`,
    }));

    const junk = this.#buildPaperHeavyJunk(
      "VICTIM",
      Math.max(
        0,
        (data.difficulty === "easy"
          ? 34
          : data.difficulty === "expert"
            ? 46
            : 42) - evidence.length,
      ),
      data.victim?.name ?? "victim",
    );

    return this.#layoutSceneItems([...junk, ...evidence]);
  }

  #buildSuspectSceneItems(suspect, data) {
    const isInvolved =
      suspect.id === data.guiltyId || data.accompliceIds.includes(suspect.id);
    const evidence = this.#buildSuspectEvidenceCandidates(suspect, data, isInvolved);
    const personalItems = this.#buildPersonalBelongings(
      suspect,
      Math.max(0, 3 - evidence.length),
    );
    const junk = this.#buildPaperHeavyJunk(
      suspect.id,
      Math.max(
        0,
        (data.difficulty === "easy"
          ? 32
          : data.difficulty === "expert"
            ? 46
            : 42) - evidence.length - personalItems.length,
      ),
      `${suspect.name} ${suspect.surname}`,
      suspect.alibiLocation,
    );
    return this.#layoutSceneItems([...evidence, ...personalItems, ...junk]);
  }

  #buildSuspectEvidenceCandidates(suspect, data, isInvolved) {
    const clueSeed = this.#numericIdSeed(suspect.id);
    const weaponText = `${data.victim?.weapon ?? ""} ${data.victim?.causeOfDeath ?? ""}`.toLowerCase();
    const items = [];
    const difficulty = data.difficulty ?? "medium";
    const allowAnalysis =
      difficulty === "easy"
        ? isInvolved || clueSeed % 7 === 0
        : difficulty === "expert"
          ? isInvolved || clueSeed % 2 === 0 || clueSeed % 5 === 0
          : isInvolved || clueSeed % 3 === 0 || clueSeed % 5 === 0;

    if (!allowAnalysis) {
      return items;
    }

    if (
      weaponText.includes("poison") ||
      weaponText.includes("toxin") ||
      weaponText.includes("venom")
    ) {
      items.push(
        isInvolved
          ? {
              id: `SE_${suspect.id}_1`,
              sceneCategory: "analysis",
              type: "chemical",
              label: "Violet Vial",
              subtitle: "sealed vial",
              description: "A stoppered vial wrapped in tissue and hidden among receipts.",
              analysisResult:
                "The vial contains the same toxic compound identified in the victim. Trace residue on the rim shows recent use.",
              belongsToId: suspect.id,
              spriteSrc: "./assets/evidence/vial.png",
              recoveredFromId: suspect.id,
              recoveredFromLabel: `${suspect.name} ${suspect.surname}`,
            }
          : {
              id: `SE_${suspect.id}_1`,
              sceneCategory: "analysis",
              type: "chemical",
              label: "Medicine Ampoule",
              subtitle: "glass ampoule",
              description: "A tiny glass ampoule tucked beside loose coins.",
              analysisResult:
                "The liquid is only a cough remedy diluted with water. No lethal substance was present.",
              belongsToId: null,
              spriteSrc: "./assets/evidence/vial.png",
              recoveredFromId: suspect.id,
              recoveredFromLabel: `${suspect.name} ${suspect.surname}`,
            },
      );
    } else if (
      weaponText.includes("gun") ||
      weaponText.includes("bullet") ||
      weaponText.includes("shot")
    ) {
      items.push(
        isInvolved
          ? {
              id: `SE_${suspect.id}_1`,
              sceneCategory: "analysis",
              type: "weapon",
              label: "Spent Round",
              subtitle: "metal fragment",
              description: "A single bullet slug wrapped in a handkerchief.",
              analysisResult:
                "Tool marks and metal smear match the projectile recovered from the victim's body.",
              belongsToId: suspect.id,
              spriteSrc: "./assets/evidence/bullet.png",
              recoveredFromId: suspect.id,
              recoveredFromLabel: `${suspect.name} ${suspect.surname}`,
            }
          : {
              id: `SE_${suspect.id}_1`,
              sceneCategory: "analysis",
              type: "weapon",
              label: "Souvenir Bullet",
              subtitle: "metal trinket",
              description: "A polished slug carried like a keepsake.",
              analysisResult:
                "The slug is inert display brass. It has never been fired and is unrelated to the murder.",
              belongsToId: null,
              spriteSrc: "./assets/evidence/bullet.png",
              recoveredFromId: suspect.id,
              recoveredFromLabel: `${suspect.name} ${suspect.surname}`,
            },
      );
    } else {
      items.push(
        isInvolved
          ? {
              id: `SE_${suspect.id}_1`,
              sceneCategory: "analysis",
              type: "weapon",
              label: "Pocket Blade",
              subtitle: "sharp metal",
              description: "A narrow folding blade wrapped in cloth and tucked behind papers.",
              analysisResult:
                "Microscopic traces of the victim's blood were found near the hinge. The blade was cleaned in haste.",
              belongsToId: suspect.id,
              spriteSrc: "./assets/evidence/razor_blade.png",
              recoveredFromId: suspect.id,
              recoveredFromLabel: `${suspect.name} ${suspect.surname}`,
            }
          : {
              id: `SE_${suspect.id}_1`,
              sceneCategory: "analysis",
              type: "weapon",
              label: "Razor Blade",
              subtitle: "small blade",
              description: "A fresh shaving blade inside a paper sleeve.",
              analysisResult:
                "The blade is factory-clean and has not been used on tissue or fabric. It is ordinary grooming stock.",
              belongsToId: null,
              spriteSrc: "./assets/evidence/razor_blade.png",
              recoveredFromId: suspect.id,
              recoveredFromLabel: `${suspect.name} ${suspect.surname}`,
            },
      );
    }

    if (isInvolved || clueSeed % 2 === 0) {
      items.push(
        isInvolved
          ? {
              id: `SE_${suspect.id}_2`,
              sceneCategory: "analysis",
              type: "hair",
              label: "Hair Clump",
              subtitle: "trace",
              description: "Several strands trapped inside a folded handkerchief.",
              analysisResult:
                "The hair sample matches the trace found on the victim. It was cut recently and stored deliberately.",
              belongsToId: suspect.id,
              spriteSrc: "./assets/evidence/hair.png",
              recoveredFromId: suspect.id,
              recoveredFromLabel: `${suspect.name} ${suspect.surname}`,
            }
          : {
              id: `SE_${suspect.id}_2`,
              sceneCategory: "analysis",
              type: "fiber",
              label: "Textile Sample",
              subtitle: "fabric",
              description: "A frayed piece of textile caught in a wallet seam.",
              analysisResult:
                "The fibers are common upholstery strands from public transit seating. They do not tie the suspect to the killing.",
              belongsToId: null,
              spriteSrc: "./assets/evidence/textile.png",
              recoveredFromId: suspect.id,
              recoveredFromLabel: `${suspect.name} ${suspect.surname}`,
            },
      );
    }

    const maxItems =
      difficulty === "easy"
        ? isInvolved
          ? 2
          : 0
        : difficulty === "expert"
          ? isInvolved
            ? 1
            : 1
          : isInvolved
            ? 2
            : 1;
    return items.slice(0, maxItems);
  }

  #buildPersonalBelongings(suspect, count) {
    const pool = [
      {
        label: "Wallet",
        description: `A worn wallet packed with loyalty cards and folded bills belonging to ${suspect.name} ${suspect.surname}.`,
        spriteSrc: "./assets/evidence/junk_wallet.png",
      },
      {
        label: "Old Lighter",
        description: "A scratched lighter with the paint worn off.",
        spriteSrc: "./assets/evidence/junk_lighter.png",
      },
      {
        label: "Key Ring",
        description: "A noisy ring of keys and one bent tag.",
        spriteSrc: "./assets/evidence/junk_keys.png",
      },
      {
        label: "Pods Case",
        description: "A cheap pods case with one missing earbud.",
        spriteSrc: "./assets/evidence/junk_pods1.png",
      },
      {
        label: "Pods Case",
        description: "A scuffed pods case with cracked plastic.",
        spriteSrc: "./assets/evidence/junk_pods2.png",
      },
      {
        label: "Cigarettes",
        description: "A soft pack of cigarettes with two left inside.",
        spriteSrc: "./assets/evidence/junk_cigarrets.png",
      },
      {
        label: "Charger",
        description: "A cheap charging brick with frayed cable wrapping.",
        spriteSrc: "./assets/evidence/junk_charger1.png",
      },
      {
        label: "Charger",
        description: "A knock-off charger with cracked plastic casing.",
        spriteSrc: "./assets/evidence/junk_chager2.png",
      },
    ];

    const seed = this.#numericIdSeed(suspect.id);
    const seenSprites = new Set();
    const items = [];

    for (let i = 0; i < pool.length && items.length < count; i++) {
      const candidate = pool[(seed + i) % pool.length];
      if (seenSprites.has(candidate.spriteSrc)) continue;
      seenSprites.add(candidate.spriteSrc);
      items.push({
        id: `SP_${suspect.id}_${items.length + 1}`,
        sceneCategory: "junk",
        type: "personal",
        label: candidate.label,
        subtitle: "personal item",
        description: candidate.description,
        spriteSrc: candidate.spriteSrc,
      });
    }

    return items;
  }

  #buildPaperHeavyJunk(ownerId, count, ownerLabel, alibiLocation = "") {
    const paperDescriptions = [
      `A crumpled paper scrap mentioning ${alibiLocation || "the evening"}.`,
      "A damp receipt with half the ink gone.",
      "A folded list of errands and crossed-out times.",
      "Two stuck-together napkins covered in scribbles.",
      "A torn page with numbers and initials in pencil.",
      "A wrinkled betting slip stuffed into the pile.",
      "A scribbled wardrobe note with a coffee ring.",
      "A bent bus ticket folded into a tiny square.",
    ];
    return Array.from({ length: count }, (_, index) => {
      return {
        id: `J_${ownerId}_${index + 1}`,
        sceneCategory: "junk",
        type: "document",
        label: "Paper",
        subtitle: "paper",
        description:
          paperDescriptions[(index + this.#numericIdSeed(ownerId)) % paperDescriptions.length],
        spriteSrc: `./assets/evidence/${index % 2 === 0 ? "junk_paper1.png" : "junk_paper2.png"}`,
      };
    });
  }

  #layoutSceneItems(items) {
    return items.map((item, index) => {
      const isPaper = item.type === "document";
      const isMeaningful = item.sceneCategory === "analysis" || item.type === "personal";
      const x = isPaper
        ? 24 + Math.floor(Math.random() * 700)
        : 210 + Math.floor(Math.random() * 290);
      const y = isPaper
        ? 18 + Math.floor(Math.random() * 580)
        : 150 + Math.floor(Math.random() * 210);
      const rotation = isPaper
        ? Math.floor(Math.random() * 38) - 19
        : Math.floor(Math.random() * 24) - 12;
      const width = isPaper
        ? 136 + Math.floor(Math.random() * 48)
        : 94 + Math.floor(Math.random() * 28);
      const height = isPaper
        ? 136 + Math.floor(Math.random() * 48)
        : 94 + Math.floor(Math.random() * 28);
      const stackOrder = isPaper
        ? 120 + index
        : isMeaningful
          ? 6 + index
          : 18 + index;

      return {
        ...item,
        xPx: Math.max(8, x),
        yPx: Math.max(8, y),
        rotation,
        widthPx: width,
        heightPx: height,
        stackOrder,
      };
    });
  }

  #labelForEvidenceType(type, index) {
    const normalized = String(type ?? "").toLowerCase();
    if (normalized === "blood") return "Blood Sample";
    if (normalized === "hair") return "Loose Hair";
    if (normalized === "fiber") return "Fabric Fiber";
    if (normalized === "fingerprint") return "Latent Print";
    if (normalized === "footprint") return "Shoe Mark";
    return `Evidence ${index + 1}`;
  }

  #buildJunkLabel(index) {
    const labels = [
      "Receipts",
      "Headphones",
      "Paper Scraps",
      "Old Lighter",
      "Wallet Photo",
      "Ticket Stub",
      "Transit Pass",
      "Spare Phone",
      "Keychain",
      "Crumpled Napkins",
      "Store List",
      "Dry-Clean Slip",
    ];
    return labels[index % labels.length];
  }

  #sceneSubtitleForType(type) {
    const normalized = String(type ?? "").toLowerCase();
    if (normalized === "blood") return "sample";
    if (normalized === "hair") return "trace";
    if (normalized === "fiber") return "fabric";
    if (normalized === "fingerprint") return "lift";
    if (normalized === "footprint") return "cast";
    if (normalized === "weapon") return "metal item";
    if (normalized === "chemical") return "container";
    if (normalized === "digital") return "device";
    return "item";
  }

  #spriteForEvidenceType(type) {
    const normalized = String(type ?? "").toLowerCase();
    if (normalized === "hair") return "./assets/evidence/hair.png";
    if (normalized === "fiber") return "./assets/evidence/textile.png";
    if (normalized === "weapon") return "./assets/evidence/razor_blade.png";
    if (normalized === "chemical") return "./assets/evidence/vial.png";
    if (normalized === "blood" || normalized === "fingerprint" || normalized === "footprint") {
      return "./assets/evidence/textile.png";
    }
    return "./assets/evidence/hair.png";
  }

  #numericIdSeed(id) {
    return Number(String(id ?? "").replace(/\D/g, "")) || 1;
  }

  /** Map voice archetype string to ElevenLabs voice ID */
  #resolveVoiceId(archetype = "", gender = "male") {
    const VOICES = {
      "calm female": "21m00Tcm4TlvDq8ikWAM", // Rachel
      "nervous female": "EXAVITQu4vr4xnSDxMaL", // Bella
      "cold female": "AZnzlk1XvdvUeBnXmlld", // Domi
      "young female": "FGY2WhTYpPnrIDTdsKH5", // Laura
      "smooth male": "ErXwobaYiN019PkySvjV", // Antoni
      "gruff male": "yoZ06aMxZJJ28mfd3POQ", // Sam
      "intimidating male": "VR6AewLTigWG4xSOukaG", // Arnold
      "weary male": "pNInz6obpgDQGcFmaJgB", // Adam
      "evasive male": "TxGEqnHWrfWFTfGW9XjX", // Josh
    };
    const normalized = String(archetype ?? "").toLowerCase();
    const isFemale = String(gender ?? "male").toLowerCase() === "female";
    const corrected = isFemale
      ? normalized.includes("male")
        ? "nervous female"
        : normalized || "nervous female"
      : normalized.includes("female")
        ? "gruff male"
        : normalized || "gruff male";
    return VOICES[corrected] ?? VOICES[isFemale ? "nervous female" : "gruff male"];
  }
}
