/**
 * GameController.js
 * -----------------
 * Central orchestrator for the Puaro murder mystery interrogation game.
 *
 * Responsibilities:
 *   — State machine (menu → generating → investigating → win/lose)
 *   — UI population and panel management
 *   — Per-suspect suspicion bars and arrest flow
 *   — Push-to-talk suspect / witness calls via VoiceController + Gemini-backed dialogue controller
 *   — Passport database terminal and dynamic contact list
 *   — Magnifying-glass evidence examination and forensic analysis
 *   — Music zone management via AudioController
 */

import { AudioController } from "./AudioController.js";
import { VoiceController } from "./VoiceController.js";
import { OllamaController } from "./OllamaController.js";
import { CaseState } from "./CaseState.js";
import { SuspicionManager } from "./SuspicionManager.js";
import { ContactManager } from "./ContactManager.js";
import { EvidenceManager } from "./EvidenceManager.js";
import { PassportDatabase } from "./PassportDatabase.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const STATES = ["menu", "generating", "investigating", "win", "lose"];

const MAX_CALL_TURNS = 12;
const STRESS_INITIAL = 20;
const SUSPECT_CALL_SUSPICION_PER_TURN = 3; // base suspicion bump each call turn
const TYPEWRITER_SPEED_MS = 26;
const SAVE_KEY = "puaro-save-v2";
const SETTINGS_KEY = "puaro-settings-v1";
const TRIAL_KEY = "puaro-trial-v1";
const AUTOSAVE_INTERVAL_MS = 12000;
const ANALYSIS_DELAY_MIN_MS = 60_000;
const ANALYSIS_DELAY_MAX_MS = 120_000;
const TRIAL_DURATION_MS = 10 * 60_000;
const TRIAL_BUDGET_TOTAL = 170;
const TRIAL_COST_CASE = 110;
const TRIAL_COST_CALL = 12;
const TRIAL_COST_ANALYSIS = 6;
const DISABLE_TRIAL =
  typeof __PUARO_DISABLE_TRIAL__ !== "undefined"
    ? Boolean(__PUARO_DISABLE_TRIAL__)
    : false;

const LOADING_MESSAGES = [
  "Reviewing crime scene photographs…",
  "Cross-referencing known associates…",
  "Compiling suspect dossiers…",
  "Preparing case file…",
];

// ─── GameController ───────────────────────────────────────────────────────────

export class GameController {
  // ── State ──────────────────────────────────────────────────────────────────

  /** @type {string} */
  #state = "menu";

  /** @type {string|null} Currently active music zone */
  #musicZone = null;

  /**
   * Describes an in-progress phone call.
   * { type: 'suspect'|'witness', id: string, history: Array, stress: number, turn: number }
   * null when not in a call.
   * @type {object|null}
   */
  #activeCall = null;

  /** Prevents double-firing speech end handlers */
  #isSpeaking = false;

  /** Prevents phone presses during typewriter animation */
  #isTyping = false;

  /** Increments whenever a call is started or cancelled to invalidate async work */
  #callSessionId = 0;

  /** Person selected for the next phone call, before the call actually starts */
  #pendingCallTarget = null;

  /** Prevents double-dialing while a call is being set up */
  #dialInProgress = false;

  /** Whether voice playback is muted */
  #ttsMuted = false;

  /** Global game settings kept across attempts */
  #settings = {
    difficulty: "medium",
    muteSounds: false,
    muteVoices: false,
    muteMusic: false,
    geminiApiKey: "",
    openaiApiKey: "",
    elevenLabsApiKey: "",
  };

  /** Pending confirm action for the noir confirm overlay */
  #confirmAction = null;

  /** Trial session state for keyless play */
  #trialState = null;

  // ── Case-scoped objects (reset each game) ──────────────────────────────────

  /** Per-suspect checked assessment items: Map<suspectId, Set<itemId>> */
  #assessmentState = new Map();

  /** Suspect ID whose dossier is currently open */
  #activeDossierSuspectId = null;

  /** Current sub-tab inside the dossier workspace */
  #activeDossierTab = "dossier";

  /** Toast notification timeout handle */
  #toastTimeout = null;

  /** Autosave interval handle */
  #autosaveInterval = null;

  /** Pending evidence analysis timeouts */
  #analysisTimers = new Map();

  /** Remember moved item positions inside examine scenes */
  #sceneItemPositions = new Map();

  /** Optional bonus score from exposing side fraud / lesser lies */
  #bonusPoints = 0;

  /** Suspects already rewarded for a secondary irregularity */
  #resolvedOddities = new Set();

  /** Cached save payload metadata for the menu */
  #lastSaveMeta = null;

  /** @type {CaseState|null} */
  #caseState = null;

  /** @type {SuspicionManager|null} */
  #suspicionManager = null;

  /** @type {ContactManager|null} */
  #contactManager = null;

  /** @type {EvidenceManager|null} */
  #evidenceManager = null;

  /** @type {PassportDatabase|null} */
  #passportDatabase = null;

  // ── Sub-controllers ────────────────────────────────────────────────────────

  /** @type {AudioController} */
  #audio;

  /** @type {VoiceController} */
  #voice;

  /** @type {OllamaController} */
  #ollama;

  // ── Cached DOM element references ─────────────────────────────────────────

  /** @type {Object<string, HTMLElement>} */
  #els = {};

  /** Checklist items for the Assessment tab */
  static #CHECKLIST = [
    { id: "expiredDoc", label: "Expired passport", section: "PASSPORT" },
    { id: "wrongInfo", label: "Wrong passport info", section: "PASSPORT" },
    { id: "wrongPhoto", label: "Wrong passport photo", section: "PASSPORT" },
    { id: "falsifiedDoc", label: "Falsified passport", section: "PASSPORT" },
    {
      id: "bloodVictim",
      label: "Blood on victim's clothes",
      section: "EVIDENCE",
    },
    {
      id: "hairVictim",
      label: "Hair on victim's clothes",
      section: "EVIDENCE",
    },
    { id: "wrongAlibi", label: "Wrong alibi", section: "BEHAVIOUR" },
    {
      id: "calledVictim",
      label: "Called the victim before death",
      section: "BEHAVIOUR",
    },
    { id: "liedInCall", label: "Lied in conversation", section: "BEHAVIOUR" },
    {
      id: "seenByWitness",
      label: "Was seen by a witness",
      section: "BEHAVIOUR",
    },
  ];

  // ── Misc ───────────────────────────────────────────────────────────────────

  #clockInterval = null;

  // ───────────────────────────────────────────────────────────────────────────
  // PUBLIC INIT
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Must be called once after DOMContentLoaded.
   * Caches DOM refs, wires events, instantiates sub-controllers, enters menu.
   */
  init() {
    this.#cacheDOMRefs();
    this.#initSubControllers();
    this.#loadSettings();
    this.#loadTrialState();
    this.#applyApiKeys();
    this.#applySettings();
    this.#bindEvents();
    this.#bindPersistenceEvents();
    this.#startClock();
    this.#startAutosave();
    this.#refreshSaveMenu();
    this.#renderSettingsUI();
    this.#setState("menu");

    // Expose on window for console debugging
    window.game = this;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // DOM CACHING
  // ───────────────────────────────────────────────────────────────────────────

  #cacheDOMRefs() {
    /** @param {string} id */
    const q = (id) => document.getElementById(id);

    this.#els = {
      // Root
      gameContainer: q("game-container"),

      // Screens / overlays
      menuScreen: q("menu-screen"),
      btnMenuStart: q("btn-menu-start"),
      btnMenuContinue: q("btn-menu-continue"),
      btnMenuDifficulty: q("btn-menu-difficulty"),
      btnMenuOptions: q("btn-menu-options"),
      btnMenuKeys: q("btn-menu-keys"),
      menuSaveNote: q("menu-save-note"),
      menuDifficultyNote: q("menu-difficulty-note"),
      topbarDifficultyNote: q("topbar-difficulty-note"),
      overlayLoading: q("overlay-loading"),
      loadingStatusText: q("loading-status-text"),
      overlayWin: q("overlay-win"),
      winCaseRef: q("win-case-ref"),
      winConfessionDetail: q("win-confession-detail"),
      btnWinNewCase: q("btn-win-new-case"),
      overlayLose: q("overlay-lose"),
      loseReasonText: q("lose-reason-text"),
      btnLoseNewCase: q("btn-lose-new-case"),
      gameLayout: q("game-layout"),

      // Top bar
      caseNumber: q("case-number"),
      victimDisplay: q("victim-display"),
      btnComputer: q("btn-computer"),
      btnEvidenceBoard: q("btn-evidence-board"),
      btnArrest: q("btn-arrest"),
      btnNewCase: q("btn-new-case"),
      btnOptions: q("btn-options"),
      btnKeys: q("btn-keys"),

      // Suspects sidebar
      victimCardName: q("victim-card-name"),
      victimCardFound: q("victim-card-found"),
      suspectsList: q("suspects-list"),

      // Panel: overview
      panelOverview: q("panel-overview"),
      overviewCaseTitle: q("overview-case-title"),
      overviewKillerCount: q("overview-killer-count"),
      overviewVictimSummary: q("overview-victim-summary"),
      overviewStoryBrief: q("overview-story-brief"),

      // Panel: dossier
      panelDossier: q("panel-dossier"),
      dossierSuspectName: q("dossier-suspect-name"),
      dossierSuspectSurname: q("dossier-suspect-surname"),
      dossierSuspectAge: q("dossier-suspect-age"),
      dossierSuspectDob: q("dossier-suspect-dob"),
      dossierSuspectOccupation: q("dossier-suspect-occupation"),
      dossierSuspectNationality: q("dossier-suspect-nationality"),
      dossierSuspectId: q("dossier-suspect-id"),
      dossierSuspectLocation: q("dossier-suspect-location"),
      dossierSuspectPhone: q("dossier-suspect-phone"),
      dossierSuspectPersonality: q("dossier-suspect-personality"),
      dossierNotes: q("dossier-notes"),
      dossierPassportStatus: q("dossier-passport-status"),
      dossierPhotoImg: q("dossier-photo-img"),

      // Panel: call
      callPersonName: q("call-person-name"),
      callPersonRole: q("call-person-role"),
      transcript: q("transcript"),
      transcriptEmpty: q("transcript-empty"),

      // Dossier tabs
      dossierTabDossier: q("dossier-tab-btn-dossier"),
      dossierTabPassport: q("dossier-tab-btn-passport"),
      dossierTabAssessment: q("dossier-tab-btn-assessment"),
      dossierTabEvidence: q("dossier-tab-btn-evidence"),
      dossierTabCall: q("dossier-tab-btn-call"),
      dossierDossierView: q("dossier-dossier-view"),
      dossierPassportView: q("dossier-passport-view"),
      dossierAssessmentView: q("dossier-assessment-view"),
      dossierEvidenceView: q("dossier-evidence-view"),
      dossierCallView: q("dossier-call-view"),
      dossierEvidenceHost: q("dossier-evidence-host"),
      assessSuspectName: q("assess-suspect-name"),
      assessChecklist: q("assess-checklist"),
      // given passport + UV scanner
      givenPassportCard: q("given-passport-card"),
      btnUvScanner: q("btn-uv-scanner"),

      // Computer sidebar (lives outside workspace, toggles independently)
      computerSidebar: q("computer-sidebar"),
      btnCloseComputer: q("btn-close-computer"),
      tabBtnPassports: q("tab-btn-passports"),
      tabBtnContacts: q("tab-btn-contacts"),
      compPassportView: q("comp-passport-view"),
      compContactsView: q("comp-contacts-view"),
      passportSearchInput: q("passport-search-input"),
      passportSearchBtn: q("passport-search-btn"),
      passportResultArea: q("passport-result-area"),
      passportEmptyState: q("passport-empty-state"),
      contactsList: q("contacts-list"),
      // Evidence tabs
      evTabBtnItems: q("ev-tab-btn-items"),
      evTabBtnCalls: q("ev-tab-btn-calls"),
      panelPhoneCalls: q("panel-phone-calls"),

      // Notification toast
      notificationToast: q("notification-toast"),
      notificationText: q("notification-text"),

      // Panel: evidence
      panelEvidence: q("panel-evidence"),
      evidenceItemsList: q("evidence-items-list"),
      evidenceEmptyState: q("evidence-empty-state"),

      // Bottom bar
      btnOpenComputer: q("btn-open-computer"),
      btnOpenEvidence: q("btn-open-evidence"),
      btnPhone: q("btn-phone"),
      phoneImg: q("phone-img"),
      phoneLabel: q("phone-label"),
      voiceHint: q("voice-hint"),
      recStatusText: q("rec-status-text"),
      stressFill: q("stress-fill"),

      // Settings / confirm overlays
      overlayOptions: q("overlay-options"),
      btnCloseOptions: q("btn-close-options"),
      overlayDifficulty: q("overlay-difficulty"),
      btnCloseDifficulty: q("btn-close-difficulty"),
      overlayKeys: q("overlay-keys"),
      btnCloseKeys: q("btn-close-keys"),
      btnSaveKeys: q("btn-save-keys"),
      btnClearKeys: q("btn-clear-keys"),
      inputGeminiKey: q("input-gemini-key"),
      inputOpenaiKey: q("input-openai-key"),
      inputElevenLabsKey: q("input-elevenlabs-key"),
      keysStatusText: q("keys-status-text"),
      difficultyPillRow: q("difficulty-pill-row"),
      toggleSfx: q("toggle-sfx"),
      toggleVoices: q("toggle-voices"),
      toggleMusic: q("toggle-music"),
      toggleSfxValue: q("toggle-sfx-value"),
      toggleVoicesValue: q("toggle-voices-value"),
      toggleMusicValue: q("toggle-music-value"),
      overlayConfirm: q("overlay-confirm"),
      confirmSubtitle: q("confirm-subtitle"),
      btnConfirmCancel: q("btn-confirm-cancel"),
      btnConfirmAccept: q("btn-confirm-accept"),

      // Examine overlay
      overlayExamine: q("overlay-examine"),
      examineTitle: q("examine-title"),
      examineItemsList: q("examine-items-list"),
      btnCloseExamine: q("btn-close-examine"),
      overlayUvScanner: q("overlay-uv-scanner"),
      btnCloseUvScanner: q("btn-close-uv-scanner"),
      uvScanStage: q("uv-scan-stage"),
      uvScanPassport: q("uv-scan-passport"),

      // Computer clock
      compClock: q("comp-clock"),

      // Arrest modal container (dynamic, may be null until created)
      arrestModal: null,
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // SUB-CONTROLLER INIT
  // ───────────────────────────────────────────────────────────────────────────

  #initSubControllers() {
    this.#audio = new AudioController();
    this.#ollama = new OllamaController();

    const elevenLabsKey =
      typeof import.meta !== "undefined" && import.meta.env
        ? (import.meta.env.VITE_ELEVENLABS_API_KEY ?? "")
        : "";

    this.#voice = new VoiceController({
      elevenLabsKey,
      scribeTokenUrl: "/api/elevenlabs/scribe-token",
      ttsUrl: "/api/elevenlabs/tts",
      onTranscriptChunk: (text) => this.#handleSpeechChunk(text),
      onSpeechEnd: () => this.#handleSpeechEnd(),
    });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // EVENT BINDING
  // ───────────────────────────────────────────────────────────────────────────

  #bindEvents() {
    const e = this.#els;

    document.addEventListener("click", (ev) => {
      const btn = ev.target instanceof Element ? ev.target.closest("button") : null;
      if (!btn || btn.id === "btn-phone") return;
      this.#audio?.playSFX("button");
    });

    // ── Menu / new-case triggers ─────────────────────────────────────────────
    e.btnMenuStart.addEventListener("click", () => this.#handleNewCase());
    e.btnMenuContinue?.addEventListener("click", () => this.#resumeSavedCase());
    e.btnMenuDifficulty?.addEventListener("click", () => this.#openDifficulty());
    e.btnMenuOptions?.addEventListener("click", () => this.#openOptions());
    e.btnMenuKeys?.addEventListener("click", () => this.#openKeys());
    e.btnNewCase.addEventListener("click", () => this.#handleNewCase(true));
    e.btnWinNewCase.addEventListener("click", () => this.#handleNewCase());
    e.btnLoseNewCase.addEventListener("click", () => this.#handleNewCase());
    e.btnOptions?.addEventListener("click", () => this.#openOptions());
    e.btnKeys?.addEventListener("click", () => this.#openKeys());

    // ── Top bar ──────────────────────────────────────────────────────────────
    e.btnComputer.addEventListener("click", () => this.#openComputer());
    e.btnCloseComputer.addEventListener("click", () => this.#closeComputer());
    e.btnEvidenceBoard.addEventListener("click", () =>
      this.#openEvidenceBoard(),
    );
    e.btnArrest.addEventListener("click", () => this.#handleArrest());

    // ── Dossier tabs ─────────────────────────────────────────────────────────
    e.dossierTabDossier?.addEventListener("click", () =>
      this.#switchDossierTab("dossier"),
    );
    e.dossierTabPassport?.addEventListener("click", () =>
      this.#switchDossierTab("passport"),
    );
    e.dossierTabAssessment?.addEventListener("click", () =>
      this.#switchDossierTab("assessment"),
    );
    e.dossierTabEvidence?.addEventListener("click", () =>
      this.#switchDossierTab("evidence"),
    );
    e.dossierTabCall?.addEventListener("click", () => {
      if (!this.#activeDossierSuspectId) {
        this.#showNotification("Select a suspect first");
        return;
      }
      this.#prepareSuspectCall(this.#activeDossierSuspectId);
    });

    // ── UV Scanner ───────────────────────────────────────────────────────────
    e.btnUvScanner?.addEventListener("click", () => this.#openUvScanner());

    // ── Evidence tabs ────────────────────────────────────────────────────────
    e.evTabBtnItems?.addEventListener("click", () =>
      this.#switchEvidenceTab("items"),
    );
    e.evTabBtnCalls?.addEventListener("click", () =>
      this.#switchEvidenceTab("calls"),
    );

    // ── Bottom bar ───────────────────────────────────────────────────────────
    e.btnOpenComputer.addEventListener("click", () => this.#openComputer());
    // Enter key in passport search field — search by name only
    e.passportSearchInput.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") this.#handlePassportSearch();
    });
    e.btnOpenEvidence.addEventListener("click", () =>
      this.#openEvidenceBoard(),
    );
    e.btnCloseOptions?.addEventListener("click", () => this.#closeOptions());
    e.overlayOptions?.addEventListener("click", (ev) => {
      if (ev.target === e.overlayOptions) this.#closeOptions();
    });
    e.btnCloseDifficulty?.addEventListener("click", () =>
      this.#closeDifficulty(),
    );
    e.btnCloseKeys?.addEventListener("click", () => this.#closeKeys());
    e.overlayDifficulty?.addEventListener("click", (ev) => {
      if (ev.target === e.overlayDifficulty) this.#closeDifficulty();
    });
    e.overlayKeys?.addEventListener("click", (ev) => {
      if (ev.target === e.overlayKeys) this.#closeKeys();
    });
    e.btnSaveKeys?.addEventListener("click", () => this.#saveKeysFromInputs());
    e.btnClearKeys?.addEventListener("click", () => this.#clearStoredKeys());
    e.toggleSfx?.addEventListener("click", () =>
      this.#updateSettings({ muteSounds: !this.#settings.muteSounds }),
    );
    e.toggleVoices?.addEventListener("click", () =>
      this.#updateSettings({ muteVoices: !this.#settings.muteVoices }),
    );
    e.toggleMusic?.addEventListener("click", () =>
      this.#updateSettings({ muteMusic: !this.#settings.muteMusic }),
    );
    e.difficultyPillRow?.addEventListener("click", (ev) => {
      const btn = ev.target instanceof Element ? ev.target.closest("[data-difficulty]") : null;
      const difficulty = btn?.getAttribute("data-difficulty");
      if (!difficulty) return;
      this.#updateSettings({ difficulty });
    });
    e.btnConfirmCancel?.addEventListener("click", () => this.#closeConfirmOverlay());
    e.btnConfirmAccept?.addEventListener("click", () => {
      const action = this.#confirmAction;
      this.#closeConfirmOverlay();
      action?.();
    });
    e.overlayConfirm?.addEventListener("click", (ev) => {
      if (ev.target === e.overlayConfirm) this.#closeConfirmOverlay();
    });

    // ── Push-to-talk phone ───────────────────────────────────────────────────
    e.btnPhone.addEventListener("mousedown", (ev) => {
      ev.preventDefault();
      this.#onPhoneDown();
    });
    e.btnPhone.addEventListener(
      "touchstart",
      (ev) => {
        ev.preventDefault();
        this.#onPhoneDown();
      },
      { passive: false },
    );
    e.btnPhone.addEventListener("mouseup", () => this.#onPhoneUp());
    e.btnPhone.addEventListener("touchend", () => this.#onPhoneUp());
    // Safety release if cursor drifts off the button while held
    e.btnPhone.addEventListener("mouseleave", () => {
      if (this.#voice.isCurrentlyListening()) this.#onPhoneUp();
    });

    // ── Computer terminal ────────────────────────────────────────────────────
    e.tabBtnPassports.addEventListener("click", () =>
      this.#switchComputerTab("passports"),
    );
    e.tabBtnContacts.addEventListener("click", () =>
      this.#switchComputerTab("contacts"),
    );
    e.passportSearchBtn.addEventListener("click", () =>
      this.#handlePassportSearch(),
    );
    e.passportSearchInput.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") this.#handlePassportSearch();
    });

    // ── Examine overlay ──────────────────────────────────────────────────────
    e.btnCloseExamine.addEventListener("click", () => this.#closeExamine());
    e.btnCloseUvScanner?.addEventListener("click", () =>
      this.#closeUvScanner(),
    );
    e.overlayUvScanner?.addEventListener("click", (ev) => {
      if (ev.target === e.overlayUvScanner) this.#closeUvScanner();
    });
    e.uvScanStage?.addEventListener("mousemove", (ev) =>
      this.#updateUvScannerPosition(ev),
    );

    // Allow clicking the victim card area to revisit the case overview
    const victimCard = document.getElementById("victim-card");
    if (victimCard) {
      victimCard.style.cursor = "pointer";
      victimCard.title = "Open case overview";
      victimCard.addEventListener("click", () => {
        if (!this.#caseState) return;
        if (!this.#activeCall) {
          this.#pendingCallTarget = null;
          this.#syncPhoneAvailability();
        }
        document
          .querySelectorAll(".suspect-card")
          .forEach((card) => card.classList.remove("selected"));
        this.#populateOverviewPanel();
        this.#showPanel("overview");
      });
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // STATE MACHINE
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Transition to a new game state.
   * Swaps state-* class on #game-container and fires the matching onEnter handler.
   * @param {string} state
   */
  #setState(state) {
    if (!STATES.includes(state)) {
      console.warn(`[GameController] Unknown state: "${state}"`);
      return;
    }

    this.#state = state;

    const container = this.#els.gameContainer;
    STATES.forEach((s) => container.classList.remove(`state-${s}`));
    container.classList.add(`state-${state}`);

    switch (state) {
      case "menu":
        this.#onEnterMenu();
        break;
      case "generating":
        this.#onEnterGenerating();
        break;
      case "investigating":
        this.#onEnterInvestigating();
        break;
      case "win":
        this.#onEnterWin();
        break;
      case "lose":
        this.#onEnterLose();
        break;
    }

    this.#persistProgress();
  }

  // ── State enter handlers ───────────────────────────────────────────────────

  #onEnterMenu() {
    this.#audio.play("calm");
    this.#pendingCallTarget = null;
    this.#dialInProgress = false;
    this.#setPhoneState("disabled");
    this.#activeCall = null;
    this.#refreshSaveMenu();
  }

  async #onEnterGenerating() {
    this.#activeCall = null;
    this.#pendingCallTarget = null;
    this.#setPhoneState("disabled");
    this.#clearAnalysisTimers();

    if (this.#usesSharedTextTrial()) {
      this.#ensureTrialSessionStarted();
      if (this.#isTrialExpired()) {
        this.#endTrialSession(
          "Trial ended. Add your own Gemini or OpenAI key, plus ElevenLabs, to keep playing.",
        );
        return;
      }
    }

    // Cycle loading status messages while the case generator works
    let msgIdx = 0;
    this.#setLoadingStatus(LOADING_MESSAGES[0]);
    const msgTimer = setInterval(() => {
      msgIdx = (msgIdx + 1) % LOADING_MESSAGES.length;
      this.#setLoadingStatus(LOADING_MESSAGES[msgIdx]);
    }, 2400);

    try {
      const rawCase = this.#ollama.repairVoiceAssignments(
        await this.#ollama.generateCase(this.#settings.difficulty),
      );
      clearInterval(msgTimer);
      this.#setLoadingStatus("Preparing case file…");

      // ── Instantiate all case-scoped objects ────────────────────────────────
      this.#caseState = new CaseState(rawCase);
      this.#suspicionManager = new SuspicionManager(this.#caseState.suspects);
      this.#contactManager = new ContactManager();
      this.#evidenceManager = new EvidenceManager();
      this.#passportDatabase = new PassportDatabase(
        this.#caseState,
        this.#contactManager,
      );
      this.#bonusPoints = 0;
      this.#resolvedOddities = new Set();
      if (this.#usesSharedTextTrial()) {
        this.#consumeTrialBudget(TRIAL_COST_CASE, "case");
      }

      // ── Populate all UI ────────────────────────────────────────────────────
      this.#populateTopBar();
      this.#buildSuspectsBoard();
      this.#populateOverviewPanel();
      this.#buildContactsList();
      this.#renderEvidenceItems();
      this.#renderPhoneCalls();

      // Player can accuse immediately
      this.#els.btnArrest.classList.remove("hidden");

      await this.#delay(350);
      this.#setState("investigating");
    } catch (err) {
      clearInterval(msgTimer);
      console.error("[GameController] Case generation failed:", err);
      this.#setLoadingStatus(
        this.#humanizeModelError(
          err,
          "Generation failed. Repeat the attempt in a few seconds.",
        ),
      );
      // After a pause, return to menu so the player can try again
      await this.#delay(3000);
      this.#setState("menu");
    }
  }

  #onEnterInvestigating() {
    this.#showPanel("overview");
    this.#els.btnArrest.classList.remove("hidden");
    this.#syncPhoneAvailability();
    this.#setStressFill(0);
    this.#audio.crossfadeTo("calm");
    this.#musicZone = "calm";
    if (this.#caseState) {
      const count = this.#caseState.guiltyIds.length;
      this.#showNotification(
        `Dispatch: ${count} ${count === 1 ? "killer" : "killers"} involved`,
      );
    }
  }

  #onEnterWin() {
    const e = this.#els;
    const summary = this.#caseState.getCaseSummary();
    const guilty = this.#caseState.getGuiltySuspects();
    const guiltyNames = guilty.map((s) => `${s.name} ${s.surname}`);

    e.winCaseRef.textContent = `Case #${summary.caseNumber} — ${summary.caseTitle}`;

    const motives = guilty
      .map((s) => `${s.name} ${s.surname}: ${s.motive || "motive withheld"}`)
      .join(" | ");
    let detail = `${guiltyNames.join(", ")} ${
      guiltyNames.length > 1 ? "have" : "has"
    } been charged in the murder of ${summary.victim.name}.`;
    detail += ` Motives: ${motives}.`;

    e.winConfessionDetail.textContent = detail;

    this.#audio.playSFX("win");
    this.#pendingCallTarget = null;
    this.#setPhoneState("disabled");
    this.#activeCall = null;
    this.#closeArrestModal();
    this.#clearAnalysisTimers();
  }

  #onEnterLose() {
    this.#audio.playSFX("lose");
    this.#pendingCallTarget = null;
    this.#setPhoneState("disabled");
    this.#activeCall = null;
    this.#closeArrestModal();
    this.#clearAnalysisTimers();
  }

  // ───────────────────────────────────────────────────────────────────────────
  // CASE LIFECYCLE
  // ───────────────────────────────────────────────────────────────────────────

  #handleNewCase(confirmLoss = false, skipTrialPrompt = false) {
    if (confirmLoss && this.#state === "investigating" && this.#caseState) {
      this.#openConfirmOverlay(
        "Current progress will be lost if you open another case file.",
        () => this.#handleNewCase(false, skipTrialPrompt),
      );
      return;
    }

    if (!skipTrialPrompt && this.#shouldUseTrialMode()) {
      if (this.#isTrialExpired()) {
        this.#showNotification(
          "Trial ended. Add your own Gemini or OpenAI key, plus ElevenLabs, in Keys.",
        );
        this.#openKeys();
        return;
      }
      this.#openConfirmOverlay(
        "For better experience, add an ElevenLabs key and either a Gemini key or an OpenAI key. You can still play on a limited shared trial for about 5 to 10 minutes. This trial is one-time and will not reset after reload.",
        () => this.#handleNewCase(confirmLoss, true),
      );
      return;
    }

    this.#clearSavedCase();
    this.#clearAnalysisTimers();
    this.#activeDossierSuspectId = null;
    this.#activeDossierTab = "dossier";
    this.#pendingCallTarget = null;
    this.#dialInProgress = false;
    // Tear down any in-progress interaction
    if (this.#voice.isCurrentlyListening()) this.#voice.stopListening();
    if (this.#voice.isCurrentlySpeaking()) this.#voice.stopSpeaking();
    this.#audio.stopStatic();
    this.#activeCall = null;
    this.#closeArrestModal();
    this.#closeExamine();
    this.#closeUvScanner();
    this.#setState("generating");
  }

  #resumeSavedCase() {
    if (this.#shouldUseTrialMode() && this.#isTrialExpired()) {
      this.#showNotification(
        "Trial ended. Add your own Gemini or OpenAI key, plus ElevenLabs, in Keys.",
      );
      this.#clearSavedCase();
      this.#openKeys();
      return;
    }
    const payload = this.#readSavedCase();
    if (!payload?.snapshot) return;
    this.#restoreSavedCase(payload.snapshot);
  }

  #restoreSavedCase(snapshot) {
    if (!snapshot?.caseData) return;

    this.#clearAnalysisTimers();
    if (this.#voice.isCurrentlyListening()) this.#voice.stopListening();
    if (this.#voice.isCurrentlySpeaking()) this.#voice.stopSpeaking();
    this.#audio.stopStatic();
    this.#closeArrestModal();
    this.#closeExamine();
    this.#closeUvScanner();
    this.#activeCall = null;
    this.#callSessionId += 1;

    this.#ollama.repairVoiceAssignments(snapshot.caseData);
    this.#caseState = new CaseState(snapshot.caseData);
    this.#suspicionManager = new SuspicionManager(this.#caseState.suspects);
    this.#contactManager = new ContactManager(snapshot.contacts ?? []);
    this.#evidenceManager = new EvidenceManager();
    this.#passportDatabase = new PassportDatabase(
      this.#caseState,
      this.#contactManager,
    );

    this.#assessmentState = new Map(
      Object.entries(snapshot.assessmentState ?? {}).map(([id, items]) => [
        id,
        new Set(items),
      ]),
    );
    this.#activeDossierSuspectId = snapshot.activeDossierSuspectId ?? null;
    this.#activeDossierTab = snapshot.dossierTab ?? "dossier";
    this.#pendingCallTarget = null;
    this.#dialInProgress = false;
    this.#bonusPoints = Number(snapshot.bonusPoints ?? 0) || 0;
    this.#resolvedOddities = new Set(snapshot.resolvedOddities ?? []);

    (snapshot.evidenceItems ?? []).forEach((item) => {
      this.#evidenceManager.discover(item);
      if (item.status === "analyzing") {
        this.#evidenceManager.startAnalysis(item.id, item.analysisDueAt ?? null);
      } else if (item.status === "analyzed") {
        this.#evidenceManager.completeAnalysis(
          item.id,
          item.result ?? item.analysisResult ?? "Analysis complete.",
          item.belongsToId ?? null,
        );
      }
    });
    this.#resumePendingAnalyses();

    this.#populateTopBar();
    this.#buildSuspectsBoard();
    this.#populateOverviewPanel();
    this.#buildContactsList();
    this.#renderEvidenceItems();
    this.#renderPhoneCalls();

    const suspicionLevels = snapshot.suspicionLevels ?? {};
    Object.entries(suspicionLevels).forEach(([id, value]) => {
      const current = this.#suspicionManager.get(id);
      this.#updateSuspicion(id, Number(value) - current);
    });

    const savedState = ["investigating", "win", "lose"].includes(
      snapshot.gameState,
    )
      ? snapshot.gameState
      : "investigating";

    this.#setState(savedState);

    if (savedState === "investigating") {
      if (snapshot.activePanel === "dossier" && snapshot.activeDossierSuspectId) {
        const savedTab =
          snapshot.dossierTab === "file" ||
          snapshot.dossierTab === "assess" ||
          snapshot.dossierTab === "call"
            ? "dossier"
            : snapshot.dossierTab;
        this.#showDossier(snapshot.activeDossierSuspectId, savedTab);
      } else if (
        snapshot.activePanel === "call" &&
        snapshot.activeDossierSuspectId
      ) {
        this.#showDossier(snapshot.activeDossierSuspectId, "dossier");
      } else if (snapshot.activePanel === "evidence") {
        this.#openEvidenceBoard();
      } else {
        this.#showPanel("overview");
      }

      if (snapshot.computerOpen) {
        this.#openComputer();
      }
    }

    this.#showNotification("Last attempt restored");
  }

  #clearAnalysisTimers() {
    this.#analysisTimers.forEach((timerId) => window.clearTimeout(timerId));
    this.#analysisTimers.clear();
  }

  #resumePendingAnalyses() {
    if (!this.#evidenceManager) return;
    this.#evidenceManager.getAll().forEach((item) => {
      if (item.status !== "analyzing") return;
      const remaining = Math.max(250, (item.analysisDueAt ?? Date.now()) - Date.now());
      this.#queueEvidenceAnalysis(item.id, remaining, true);
    });
  }

  #queueEvidenceAnalysis(evidenceId, delayMs = null, keepExistingDueAt = false) {
    if (!this.#evidenceManager) return;
    const item = this.#evidenceManager.get(evidenceId);
    if (!item) return;

    const alreadyQueued = this.#analysisTimers.get(evidenceId);
    if (alreadyQueued) window.clearTimeout(alreadyQueued);

    const effectiveDelay =
      delayMs ??
      ANALYSIS_DELAY_MIN_MS +
        Math.floor(
          Math.random() * (ANALYSIS_DELAY_MAX_MS - ANALYSIS_DELAY_MIN_MS + 1),
        );
    const dueAt =
      keepExistingDueAt && item.analysisDueAt
        ? item.analysisDueAt
        : Date.now() + effectiveDelay;

    this.#evidenceManager.startAnalysis(evidenceId, dueAt);
    this.#analysisTimers.set(
      evidenceId,
      window.setTimeout(() => {
        this.#analysisTimers.delete(evidenceId);
        void this.#completeQueuedAnalysis(evidenceId);
      }, Math.max(250, dueAt - Date.now())),
    );
    this.#renderEvidenceItems();
    this.#persistProgress();
  }

  async #completeQueuedAnalysis(evidenceId) {
    if (!this.#evidenceManager || !this.#caseState) return;
    const item = this.#evidenceManager.get(evidenceId);
    if (!item) return;

    try {
      const result = await this.#ollama.analyzeEvidence(item, this.#caseState);
      this.#evidenceManager.completeAnalysis(
        evidenceId,
        result.result,
        result.belongsToId,
      );
      if (this.#usesSharedTextTrial()) {
        const stillActive = this.#consumeTrialBudget(
          TRIAL_COST_ANALYSIS,
          "analysis",
        );
        if (!stillActive) {
          this.#endTrialSession(
            "Trial ended. Add your own Gemini or OpenAI key, plus ElevenLabs, to continue the investigation.",
          );
          return;
        }
      }
      this.#renderEvidenceItems();
      this.#persistProgress();
      this.#showNotification("Lab report returned");
    } catch (err) {
      console.error("[GameController] Evidence analysis failed:", err);
      item.status = "discovered";
      item.analysisDueAt = null;
      this.#renderEvidenceItems();
      this.#persistProgress();
      this.#showNotification(
        this.#humanizeModelError(
          err,
          "Analysis paused. Repeat the attempt in a few seconds.",
        ),
      );
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // UI POPULATION HELPERS
  // ───────────────────────────────────────────────────────────────────────────

  #populateTopBar() {
    const summary = this.#caseState.getCaseSummary();
    this.#els.caseNumber.textContent = `CASE #${summary.caseNumber} | BONUS ${this.#bonusPoints}`;
    this.#els.victimDisplay.textContent =
      `VICTIM: ${summary.victim.name.toUpperCase()} | ${summary.caseDateLabel ?? "CURRENT CASE"}`;
  }

  #populateOverviewPanel() {
    const summary = this.#caseState.getCaseSummary();
    const v = summary.victim;
    const killerCount = this.#caseState.guiltyIds.length;

    this.#els.overviewCaseTitle.textContent = this.#caseState.caseTitle;

    this.#els.overviewVictimSummary.textContent =
      `${summary.caseDateLabel ? `Date: ${summary.caseDateLabel}. ` : ""}` +
      `${v.name}, ${v.age} — ${v.occupation}. ` +
      `Found at ${v.foundAt}. ` +
      `Time of death: ${v.timeOfDeath}. ` +
      `Cause: ${v.causeOfDeath}.` +
      (v.weapon ? ` Weapon: ${v.weapon}.` : "");

    if (this.#els.overviewKillerCount) {
      this.#els.overviewKillerCount.textContent = `${killerCount} ${
        killerCount === 1 ? "KILLER" : "KILLERS"
      } IN THIS CASE`;
    }

    this.#els.overviewStoryBrief.textContent = this.#caseState.storyBrief;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // SUSPECTS SIDEBAR — #buildSuspectsBoard()
  // ───────────────────────────────────────────────────────────────────────────

  #buildSuspectsBoard() {
    const victim = this.#caseState.victim;

    this.#els.victimCardName.textContent = victim.name;
    this.#els.victimCardFound.textContent =
      `Found at: ${victim.foundAt}\nTime of death: ${victim.timeOfDeath}`;

    // Clear previous run
    this.#els.suspectsList.innerHTML = "";

    this.#caseState.suspects.forEach((s) => {
      const card = document.createElement("div");
      card.className = "suspect-card";
      card.dataset.suspectId = s.id;
      card.title = "Open suspect file";
      card.addEventListener("click", () => this.#showDossier(s.id));

      const nameDiv = document.createElement("div");
      nameDiv.className = "suspect-card-name";
      const dot = document.createElement("span");
      dot.className = "suspect-status-dot";
      nameDiv.appendChild(dot);
      nameDiv.appendChild(document.createTextNode(`${s.name} ${s.surname}`));
      card.appendChild(nameDiv);

      const infoDiv = document.createElement("div");
      infoDiv.style.cssText = [
        "font-size:9px",
        "letter-spacing:2px",
        "color:var(--paper-dark)",
        "opacity:0.55",
        "text-transform:uppercase",
        "margin-bottom:4px",
        "line-height:1.7",
      ].join(";");
      infoDiv.textContent = `${s.occupation} | ${s.phoneNumber ?? "NO PHONE"}`;
      card.appendChild(infoDiv);

      this.#els.suspectsList.appendChild(card);
    });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // SUSPICION SYSTEM
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Adjust a suspect's suspicion bar and check for arrest threshold.
   * @param {string} suspectId
   * @param {number} delta  Can be negative (exonerating evidence)
   */
  #updateSuspicion(suspectId, delta) {
    if (!this.#suspicionManager) return;
    const value = this.#suspicionManager.adjust(suspectId, delta);

    // ── Bar fill ──────────────────────────────────────────────────────────────
    const fill = document.querySelector(
      `.suspect-bar-fill[data-suspect-id="${suspectId}"]`,
    );
    if (fill) {
      fill.style.width = `${value}%`;
      if (value >= 75) {
        fill.style.backgroundColor = "#8b1c1c";
      } else if (value >= 60) {
        fill.style.backgroundColor = "#d4440a";
      } else if (value >= 30) {
        fill.style.backgroundColor = "#c8941a";
      } else {
        fill.style.backgroundColor = "#8b7355";
      }
    }

    // ── Percentage label ──────────────────────────────────────────────────────
    const pctEl = document.querySelector(
      `.suspect-bar-pct[data-suspect-id="${suspectId}"]`,
    );
    if (pctEl) pctEl.textContent = `${Math.round(value)}%`;

    // Player can accuse at any time, suspicion only feeds atmosphere.
    this.#els.btnArrest.classList.remove("hidden");

    // ── Music zone ────────────────────────────────────────────────────────────
    this.#updateMusicZone();
  }

  // ───────────────────────────────────────────────────────────────────────────
  // DOSSIER PANEL
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Populate and show the dossier panel for the given suspect.
   * @param {string} suspectId
   */
  #showDossier(suspectId, initialTab = "dossier") {
    const s = this.#caseState?.getSuspect(suspectId);
    if (!s) return;
    this.#closeUvScanner();
    if (
      !this.#activeCall &&
      this.#pendingCallTarget?.type === "suspect" &&
      this.#pendingCallTarget.id !== suspectId
    ) {
      this.#pendingCallTarget = null;
    }

    this.#activeDossierSuspectId = suspectId;
    if (!["dossier", "passport", "assessment", "evidence"].includes(initialTab)) {
      initialTab = "dossier";
    }

    document.querySelectorAll(".suspect-card").forEach((card) => {
      card.classList.toggle("selected", card.dataset.suspectId === suspectId);
    });

    const e = this.#els;

    e.dossierSuspectName.textContent = s.name.toUpperCase();
    e.dossierSuspectSurname.textContent = s.surname.toUpperCase();
    e.dossierSuspectAge.textContent = s.age ?? "—";
    if (e.dossierSuspectDob)
      e.dossierSuspectDob.textContent = s.dateOfBirth ?? "—";
    e.dossierSuspectOccupation.textContent = s.occupation;
    if (e.dossierSuspectNationality)
      e.dossierSuspectNationality.textContent = s.passportNationality ?? "—";
    if (e.dossierSuspectId)
      e.dossierSuspectId.textContent = s.passportId ?? "—";
    e.dossierSuspectLocation.textContent = s.passportAddress ?? "—";
    if (e.dossierSuspectPhone)
      e.dossierSuspectPhone.textContent = s.phoneNumber ?? "—";
    e.dossierSuspectPersonality.textContent = s.personality;
    e.dossierNotes.textContent = s.alibi ?? "No alibi recorded.";

    // Passport status stamp
    const stamp = e.dossierPassportStatus;
    stamp.textContent = "VERIFY DOCUMENT";
    stamp.className = "verify";

    document
      .querySelectorAll(".btn-verify-alibi")
      .forEach((btn) => btn.remove());

    // Alibi verify button — add once per suspect
    const verifyBtnId = `btn-verify-alibi-${suspectId}`;
    if (
      !document.getElementById(verifyBtnId) &&
      s.alibiLocation &&
      s.alibiVerifierName
    ) {
      const verifyBtn = document.createElement("button");
      verifyBtn.id = verifyBtnId;
      verifyBtn.className = "btn-verify-alibi";
      verifyBtn.textContent = `Verify alibi: ${s.alibiLocation}`;
      verifyBtn.addEventListener("click", () =>
        this.#addAlibiVerifier(suspectId),
      );
      if (e.dossierNotes?.parentNode) {
        e.dossierNotes.parentNode.insertBefore(
          verifyBtn,
          e.dossierNotes.nextSibling,
        );
      }
    }

    this.#renderGivenPassport(s);
    this.#showPanel("dossier");
    this.#switchDossierTab(initialTab);
    if (!this.#activeCall) this.#syncPhoneAvailability();
  }

  #prepareSuspectCall(suspectId) {
    const suspect = this.#caseState?.getSuspect(suspectId);
    if (!suspect) return;
    if (this.#activeCall) this.#endCurrentCall();

    this.#voice.setRecognitionContext({
      keyterms: this.#buildRecognitionKeyterms(suspect),
    });
    this.#pendingCallTarget = { type: "suspect", id: suspectId };
    this.#populateCallPanel(
      `${suspect.name} ${suspect.surname}`,
      `Suspect | ${suspect.occupation}`,
      "Press the phone button below to place the call.",
    );
    this.#showPanel("call");
    this.#syncPhoneAvailability();
    this.#persistProgress();
  }

  #prepareContactCall(contactId) {
    const contact = this.#getCallableContact(contactId);
    if (!contact) return;
    if (this.#activeCall) this.#endCurrentCall();

    this.#voice.setRecognitionContext({
      keyterms: this.#buildRecognitionKeyterms(contact),
    });
    const relationship =
      contact.relationship &&
      !["none", "unknown", "contact"].includes(
        String(contact.relationship).trim().toLowerCase(),
      )
        ? contact.relationship
        : contact.isAlibiVerifier
          ? "Alibi witness"
          : "Witness";

    this.#pendingCallTarget = { type: "witness", id: contactId };
    this.#populateCallPanel(
      `${contact.name} ${contact.surname}`,
      contact.isAlibiVerifier
        ? `Alibi witness | ${relationship}${contact.forSuspectName ? ` for ${contact.forSuspectName}` : ""}`
        : `Witness | ${relationship}`,
      "Press the phone button below to place the call.",
    );
    this.#showPanel("call");
    this.#syncPhoneAvailability();
    this.#persistProgress();
  }

  #populateCallPanel(name, role, placeholder) {
    const e = this.#els;
    e.callPersonName.textContent = name;
    e.callPersonRole.textContent = role;
    this.#clearTranscript();
    if (e.transcriptEmpty) e.transcriptEmpty.textContent = placeholder;
    this.#setRecStatus("Ready to call");
  }

  /**
   * Switch between the dossier sub-views.
   * @param {'dossier'|'passport'|'assessment'|'evidence'} tab
   */
  #switchDossierTab(tab) {
    const e = this.#els;
    const nextTab = ["dossier", "passport", "assessment", "evidence"].includes(tab)
      ? tab
      : "dossier";
    if (nextTab !== "passport") {
      this.#closeUvScanner();
    }

    const buttons = {
      dossier: e.dossierTabDossier,
      passport: e.dossierTabPassport,
      assessment: e.dossierTabAssessment,
      evidence: e.dossierTabEvidence,
    };
    const views = {
      dossier: e.dossierDossierView,
      passport: e.dossierPassportView,
      assessment: e.dossierAssessmentView,
      evidence: e.dossierEvidenceView,
    };

    Object.entries(buttons).forEach(([key, btn]) => {
      btn?.classList.toggle("active", key === nextTab);
    });
    Object.entries(views).forEach(([key, view]) => {
      view?.classList.toggle("active", key === nextTab);
    });

    this.#activeDossierTab = nextTab;

    if (nextTab === "assessment") {
      this.#renderAssessment(this.#activeDossierSuspectId);
    }

    if (nextTab === "evidence") {
      this.#renderDossierEvidenceView(this.#activeDossierSuspectId);
    }
  }

  /**
   * Render the per-suspect assessment checklist.
   * @param {string} suspectId
   */
  #renderAssessment(suspectId) {
    const e = this.#els;
    if (!e.assessChecklist || !e.assessSuspectName) return;

    const suspect = this.#caseState?.getSuspect(suspectId);
    if (!suspect) return;

    e.assessSuspectName.textContent = `Assessment — ${suspect.name} ${suspect.surname}`;

    if (!this.#assessmentState.has(suspectId)) {
      this.#assessmentState.set(suspectId, new Set());
    }
    const checked = this.#assessmentState.get(suspectId);

    e.assessChecklist.innerHTML = "";

    const sections = ["PASSPORT", "EVIDENCE", "BEHAVIOUR"];
    sections.forEach((section) => {
      const items = GameController.#CHECKLIST.filter(
        (i) => i.section === section,
      );
      if (!items.length) return;

      const sectionLabel = document.createElement("div");
      sectionLabel.className = "assess-section-label";
      sectionLabel.textContent = section;
      e.assessChecklist.appendChild(sectionLabel);

      items.forEach((item) => {
        const row = document.createElement("div");
        row.className = `assess-item${checked.has(item.id) ? " checked" : ""}`;
        row.dataset.itemId = item.id;

        const box = document.createElement("div");
        box.className = "assess-checkbox";

        const lbl = document.createElement("div");
        lbl.className = "assess-label";
        lbl.textContent = item.label;

        row.appendChild(box);
        row.appendChild(lbl);

        row.addEventListener("click", () => {
          const wasChecked = checked.has(item.id);
          if (wasChecked) {
            checked.delete(item.id);
            row.classList.remove("checked");
          } else {
            checked.add(item.id);
            row.classList.add("checked");
          }
          this.#persistProgress();
        });

        e.assessChecklist.appendChild(row);
      });
    });
  }

  /**
   * Add an alibi verifier to the New Contacts list so the player can call them.
   * @param {string} suspectId
   */
  #addAlibiVerifier(suspectId) {
    if (!this.#caseState || !this.#contactManager) return;
    const suspect = this.#caseState.getSuspect(suspectId);
    if (!suspect?.alibiVerifierName) return;

    const alibiVerifierId = `AV_${suspectId}`;
    if (this.#contactManager.hasContact(alibiVerifierId)) {
      this.#showNotification(
        `${suspect.alibiVerifierName} is already in your contacts`,
      );
      return;
    }

    const verifierName = this.#splitContactName(suspect.alibiVerifierName);
    const firstName = verifierName.firstName;
    const surname = verifierName.surname;
    const willConfirm = suspect.alibiTrue;
    const verifierGender = this.#inferContactGender(firstName);
    const verifierVoice = this.#voiceProfileForGender(
      verifierGender,
      "alibi",
    );

    const contact = {
      id: alibiVerifierId,
      name: firstName,
      surname,
      relationship: suspect.alibiVerifierTitle ?? "Alibi witness",
      personality: "straightforward, professional",
      voiceArchetype: verifierVoice.archetype,
      testimony: willConfirm
        ? `Yes, ${suspect.name} ${suspect.surname} was here. ${suspect.alibiDetails ?? "I remember them clearly."}`
        : `No, I have no record of ${suspect.name} ${suspect.surname} here that night. ${suspect.alibiDetails ?? "No booking under that name."}`,
      mentionsSuspectId: null,
      passportId: `AV${String(Math.floor(Math.random() * 900000 + 100000))}`,
      passportAddress: suspect.alibiLocation ?? "Riverton",
      passportNationality: "US",
      passportIssue: "03/2018",
      passportExpiry: "03/2033",
      dateOfBirth: "12/09/1987",
      phoneNumber: `(555) ${String(Math.floor(Math.random() * 900 + 100))}-${String(Math.floor(Math.random() * 9000 + 1000))}`,
      passportFake: false,
      passportDiscrepancy: null,
      gender: verifierGender,
      passportPhotoFile: verifierVoice.photo,
      passportPhotoWrong: false,
      hairColor: "brown",
      voiceId: verifierVoice.id,
      isDiscovered: true,
      isAlibiVerifier: true,
      directoryType: "alibi witness",
      forSuspectId: suspectId,
      forSuspectName: `${suspect.name} ${suspect.surname}`,
    };

    this.#contactManager.discover(contact);
    this.#passportDatabase.rebuild(this.#caseState, this.#contactManager);
    this.#addContactToUI(contact);
    this.#persistProgress();
    this.#showNotification(
      `Alibi contact added: ${suspect.alibiVerifierName} (${suspect.alibiVerifierTitle})`,
    );
  }

  #inferContactGender(firstName = "") {
    const normalized = String(firstName ?? "").trim().toLowerCase();
    const femaleNames = new Set([
      "amanda",
      "anne",
      "clara",
      "diana",
      "ellen",
      "grace",
      "helen",
      "helena",
      "jessie",
      "kate",
      "lily",
      "rose",
      "sandra",
      "sarah",
      "susan",
    ]);
    return femaleNames.has(normalized) ? "female" : "male";
  }

  #splitContactName(fullName = "") {
    const honorifics = new Set([
      "mr",
      "mr.",
      "mrs",
      "mrs.",
      "ms",
      "ms.",
      "dr",
      "dr.",
      "father",
      "coach",
      "captain",
      "host",
      "cashier",
      "chef",
      "nurse",
      "reverend",
      "instructor",
      "pharmacist",
    ]);
    const parts = String(fullName ?? "")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    const cleaned = parts.filter(
      (part, index) => !(index === 0 && honorifics.has(part.toLowerCase())),
    );
    return {
      firstName: cleaned[0] ?? parts[0] ?? "Contact",
      surname: cleaned.slice(1).join(" ") || "Contact",
    };
  }

  #voiceProfileForGender(gender = "male", role = "default") {
    const isFemale = String(gender ?? "male").toLowerCase() === "female";
    if (isFemale) {
      return {
        archetype:
          role === "alibi"
            ? "calm female"
            : role === "mentioned"
              ? "calm female"
              : "nervous female",
        id:
          role === "alibi" || role === "mentioned"
            ? "21m00Tcm4TlvDq8ikWAM"
            : "EXAVITQu4vr4xnSDxMaL",
        photo: "brown1fem",
      };
    }

    return {
      archetype:
        role === "alibi"
          ? "smooth male"
          : role === "mentioned"
            ? "smooth male"
            : "gruff male",
      id:
        role === "alibi" || role === "mentioned"
          ? "ErXwobaYiN019PkySvjV"
          : "yoZ06aMxZJJ28mfd3POQ",
      photo: "brown1male",
    };
  }

  #resolveSpeakerVoice(person, role = "contact") {
    if (!person) return null;

    const archetype = String(person.voiceArchetype ?? "").toLowerCase();
    const explicitGender = String(person.gender ?? "").toLowerCase();
    const photo = String(person.passportPhotoFile ?? "").toLowerCase();
    let inferredGender =
      explicitGender === "female" || explicitGender === "male"
        ? explicitGender
        : "";

    if (!inferredGender) {
      if (photo.endsWith("fem")) inferredGender = "female";
      else if (photo.endsWith("male")) inferredGender = "male";
      else inferredGender = this.#inferContactGender(person.name ?? "");
    }

    const femaleIds = new Set([
      "21m00Tcm4TlvDq8ikWAM",
      "EXAVITQu4vr4xnSDxMaL",
      "AZnzlk1XvdvUeBnXmlld",
      "FGY2WhTYpPnrIDTdsKH5",
    ]);
    const maleIds = new Set([
      "ErXwobaYiN019PkySvjV",
      "yoZ06aMxZJJ28mfd3POQ",
      "VR6AewLTigWG4xSOukaG",
      "pNInz6obpgDQGcFmaJgB",
      "TxGEqnHWrfWFTfGW9XjX",
    ]);
    const currentVoiceId = String(person.voiceId ?? "").trim();
    const currentMatchesGender =
      (inferredGender === "female" && femaleIds.has(currentVoiceId)) ||
      (inferredGender === "male" && maleIds.has(currentVoiceId));

    if (currentVoiceId && currentMatchesGender) {
      return currentVoiceId;
    }

    if (inferredGender === "female") {
      if (archetype.includes("cold")) return "AZnzlk1XvdvUeBnXmlld";
      if (archetype.includes("young")) return "FGY2WhTYpPnrIDTdsKH5";
      if (archetype.includes("calm")) return "21m00Tcm4TlvDq8ikWAM";
      return role === "suspect" ? "EXAVITQu4vr4xnSDxMaL" : "21m00Tcm4TlvDq8ikWAM";
    }

    if (archetype.includes("intimidating")) return "VR6AewLTigWG4xSOukaG";
    if (archetype.includes("weary")) return "pNInz6obpgDQGcFmaJgB";
    if (archetype.includes("evasive")) return "TxGEqnHWrfWFTfGW9XjX";
    if (archetype.includes("smooth")) return "ErXwobaYiN019PkySvjV";
    return role === "suspect" ? "yoZ06aMxZJJ28mfd3POQ" : "ErXwobaYiN019PkySvjV";
  }

  // ───────────────────────────────────────────────────────────────────────────
  // CALL: SUSPECT
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Initiate a phone call to a suspect.
   * Generates an opening line from the dialogue model, then enables push-to-talk.
   * @param {string} suspectId
   */
  async #startSuspectCall(suspectId) {
    if (!this.#caseState) return;
    const suspect = this.#caseState.getSuspect(suspectId);
    if (!suspect) return;

    this.#endCurrentCall();

    const e = this.#els;
    e.callPersonName.textContent = `${suspect.name} ${suspect.surname}`;
    e.callPersonRole.textContent = `Suspect | ${suspect.occupation}`;
    this.#clearTranscript();
    this.#showPanel("call");

    this.#activeCall = {
      type: "suspect",
      id: suspectId,
      history: [],
      stress: STRESS_INITIAL,
      turn: 0,
      sessionId: ++this.#callSessionId,
    };

    this.#setPhoneState("muted");
    this.#setRecStatus("Calling…");

    try {
      await this.#playCallLeadIn();
      if (!this.#activeCall || this.#activeCall.id !== suspectId) return;

      const openingPrompt = [
        {
          role: "user",
          content: "[The detective calls. You pick up the phone. You answer.]",
        },
      ];

      const opening = await this.#ollama.getSuspectResponse(
        suspect,
        this.#caseState,
        openingPrompt,
        { turn: 0, stress: STRESS_INITIAL },
      );

      // Guard: call may have been cancelled while awaiting
      if (!this.#activeCall || this.#activeCall.id !== suspectId) return;

      // Seed history with the opening exchange
      this.#activeCall.history.push(
        { role: "user", content: openingPrompt[0].content },
        { role: "assistant", content: opening.text },
      );

      await this.#deliverResponse(
        opening.text,
        this.#resolveSpeakerVoice(suspect, "suspect"),
        this.#activeCall.sessionId,
      );
      if (!this.#activeCall) return;

      this.#setPhoneState("ready");
      this.#setRecStatus("Standby");
    } catch (err) {
      console.error("[GameController] Suspect call opening failed:", err);
      this.#setRecStatus(`Error: ${err.message}`);
      if (this.#activeCall) this.#setPhoneState("ready");
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // CALL: WITNESS / CONTACT
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Initiate a phone call to a witness or dynamically-discovered contact.
   * @param {string} contactId
   */
  async #startContactCall(contactId) {
    const contact = this.#getCallableContact(contactId);
    if (!contact) return;

    this.#endCurrentCall();

    const e = this.#els;
    const relationship =
      contact.relationship &&
      !["none", "unknown", "contact"].includes(
        String(contact.relationship).trim().toLowerCase(),
      )
        ? contact.relationship
        : contact.isAlibiVerifier
          ? "Alibi witness"
          : "Witness";
    e.callPersonName.textContent = `${contact.name} ${contact.surname}`;
    e.callPersonRole.textContent = contact.isAlibiVerifier
      ? `Alibi witness | ${relationship}${contact.forSuspectName ? ` for ${contact.forSuspectName}` : ""}`
      : `Witness | ${relationship}`;
    this.#clearTranscript();
    this.#showPanel("call");

    this.#activeCall = {
      type: "witness",
      id: contactId,
      history: [],
      turn: 0,
      sessionId: ++this.#callSessionId,
    };

    this.#setPhoneState("muted");
    this.#setRecStatus("Calling…");

    try {
      await this.#playCallLeadIn();
      if (!this.#activeCall || this.#activeCall.id !== contactId) return;

      const openingPrompt = [
        { role: "user", content: "[The detective calls]" },
      ];

      const opening = await this.#ollama.getWitnessResponse(
        contact,
        this.#caseState,
        openingPrompt,
        { turn: 0 },
      );

      if (!this.#activeCall || this.#activeCall.id !== contactId) return;

      this.#activeCall.history.push(
        { role: "user", content: openingPrompt[0].content },
        { role: "assistant", content: opening.text },
      );

      // Handle any person mentioned in the opening
      if (opening.mentionedPersonName) {
        await this.#handleMentionedPerson(
          opening.mentionedPersonName,
          opening.mentionedPersonSurname,
        );
      }

      await this.#deliverResponse(
        opening.text,
        this.#resolveSpeakerVoice(contact, "contact"),
        this.#activeCall.sessionId,
      );
      if (!this.#activeCall) return;

      this.#setPhoneState("ready");
      this.#setRecStatus("Standby");
    } catch (err) {
      console.error("[GameController] Witness call opening failed:", err);
      this.#setRecStatus(`Error: ${err.message}`);
      if (this.#activeCall) this.#setPhoneState("ready");
    }
  }

  /**
   * Cleanly tear down any active call without triggering game-over logic.
   * @private
   */
  #endCurrentCall() {
    if (!this.#activeCall) return;
    this.#callSessionId += 1;
    this.#voice.setRecognitionContext({ keyterms: [] });
    this.#voice.stopListening();
    this.#voice.stopSpeaking();
    this.#audio.stopStatic();
    this.#activeCall = null;
    this.#dialInProgress = false;
    this.#syncPhoneAvailability();
    this.#setRecStatus("Call ended");
  }

  async #playCallLeadIn() {
    this.#audio.playSFX("phone");
    await this.#delay(1350);
  }

  async #beginPendingCall() {
    if (this.#dialInProgress || this.#activeCall || !this.#pendingCallTarget) {
      return;
    }

    this.#dialInProgress = true;
    try {
      if (this.#pendingCallTarget.type === "suspect") {
        await this.#startSuspectCall(this.#pendingCallTarget.id);
      } else {
        await this.#startContactCall(this.#pendingCallTarget.id);
      }
    } finally {
      this.#dialInProgress = false;
      if (!this.#activeCall) this.#syncPhoneAvailability();
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // PUSH-TO-TALK FLOW
  // ───────────────────────────────────────────────────────────────────────────

  #onPhoneDown() {
    if (!this.#activeCall) {
      if (this.#pendingCallTarget && !this.#els.btnPhone.disabled) {
        this.#beginPendingCall();
      }
      return;
    }
    if (this.#els.btnPhone.disabled) return;
    if (this.#isSpeaking || this.#isTyping) return;

    this.#setPhoneState("speaking");
    this.#setRecStatus("Listening…");
    this.#els.voiceHint.textContent = "…";
    this.#voice.startListening().catch((err) => {
      if (!this.#activeCall) return;
      this.#setPhoneState("ready");
      this.#setRecStatus(err.message);
      this.#els.voiceHint.textContent = "";
    });
  }

  #onPhoneUp() {
    if (!this.#voice.isCurrentlyListening()) return;
    this.#voice.stopListening();
    this.#setPhoneState("muted");
    this.#setRecStatus("Processing…");
  }

  /** Called by VoiceController with interim recognition text. */
  #handleSpeechChunk(text) {
    this.#els.voiceHint.textContent = text || "…";
  }

  /**
   * Called by VoiceController when the player has finished speaking.
   * Retrieves the transcript and dispatches the AI response.
   */
  async #handleSpeechEnd() {
    if (!this.#activeCall) return;

    const playerText = this.#voice.getLastTranscript()?.trim() ?? "";
    this.#els.voiceHint.textContent = "";

    if (!playerText) {
      this.#setPhoneState("ready");
      this.#setRecStatus("Standby");
      return;
    }

    // Add player line to transcript UI and history
    this.#addToTranscript("player", playerText);
    this.#activeCall.history.push({ role: "user", content: playerText });
    this.#activeCall.turn = (this.#activeCall.turn ?? 0) + 1;

    // Enforce turn cap
    if (this.#activeCall.turn > MAX_CALL_TURNS) {
      this.#addToTranscript(
        "system",
        "[Call ended — maximum questioning time reached]",
      );
      this.#activeCall = null;
      this.#syncPhoneAvailability();
      this.#setRecStatus("Call ended");
      this.#audio.stopStatic();
      return;
    }

    this.#setPhoneState("muted");
    this.#setRecStatus("Thinking…");

    try {
      if (this.#activeCall.type === "suspect") {
        await this.#handleSuspectTurn();
      } else {
        await this.#handleWitnessTurn();
      }
      if (this.#usesSharedTextTrial() || this.#usesSharedVoiceTrial()) {
        const stillActive = this.#consumeTrialBudget(TRIAL_COST_CALL, "call");
        if (!stillActive) {
          this.#endTrialSession(
            "Trial ended. Add your own Gemini or OpenAI key, plus ElevenLabs, to continue the investigation.",
          );
          return;
        }
      }
    } catch (err) {
      console.error("[GameController] handleSpeechEnd error:", err);
      this.#setRecStatus(
        this.#humanizeModelError(
          err,
          "Repeat the attempt in a few seconds.",
        ),
      );
      if (this.#activeCall) this.#setPhoneState("ready");
    }
  }

  // ── Suspect turn processing ────────────────────────────────────────────────

  async #handleSuspectTurn() {
    if (!this.#activeCall) return;
    const { id, history, turn } = this.#activeCall;
    const stress = this.#activeCall.stress ?? STRESS_INITIAL;
    const suspect = this.#caseState.getSuspect(id);
    if (!suspect) return;
    const lastPlayerText = history[history.length - 1]?.content ?? "";

    const response = await this.#ollama.getSuspectResponse(
      suspect,
      this.#caseState,
      history,
      { turn, stress },
    );

    // Guard against concurrent cancellation
    if (!this.#activeCall || this.#activeCall.id !== id) return;

    // ── Apply stress delta ─────────────────────────────────────────────────
    const newStress = Math.max(0, Math.min(100, stress + response.stressDelta));
    this.#activeCall.stress = newStress;
    this.#setStressFill(newStress);

    // Stress directly correlates with suspicion
    // Append to history
    this.#activeCall.history.push({
      role: "assistant",
      content: response.text,
    });

    // ── Confession → immediate win ─────────────────────────────────────────
    if (response.confessed) {
      await this.#deliverResponse(
        response.text,
        this.#resolveSpeakerVoice(suspect, "suspect"),
        this.#activeCall.sessionId,
      );
      await this.#delay(900);
      this.#setState("win");
      return;
    }

    // ── Hang-up ────────────────────────────────────────────────────────────
    if (response.terminated) {
      await this.#deliverResponse(
        response.text,
        this.#resolveSpeakerVoice(suspect, "suspect"),
        this.#activeCall.sessionId,
      );
      this.#addToTranscript("system", "[Call disconnected]");
      this.#activeCall = null;
      this.#syncPhoneAvailability();
      this.#setRecStatus("Call ended");
      this.#audio.stopStatic();
      return;
    }

    await this.#deliverResponse(
      response.text,
      this.#resolveSpeakerVoice(suspect, "suspect"),
      this.#activeCall.sessionId,
    );
    if (!this.#activeCall) return;
    this.#maybeAwardOddityBonus(suspect, lastPlayerText, response.text);
    this.#setPhoneState("ready");
    this.#setRecStatus("Standby");
  }

  // ── Witness turn processing ────────────────────────────────────────────────

  async #handleWitnessTurn() {
    if (!this.#activeCall) return;
    const { id, history, turn } = this.#activeCall;
    const contact = this.#getCallableContact(id);
    if (!contact) return;

    const response = await this.#ollama.getWitnessResponse(
      contact,
      this.#caseState,
      history,
      { turn },
    );

    if (!this.#activeCall || this.#activeCall.id !== id) return;

    this.#activeCall.history.push({
      role: "assistant",
      content: response.text,
    });

    // Handle newly mentioned person
    if (response.mentionedPersonName) {
      await this.#handleMentionedPerson(
        response.mentionedPersonName,
        response.mentionedPersonSurname,
      );
    }

    await this.#deliverResponse(
      response.text,
      this.#resolveSpeakerVoice(contact, "contact"),
      this.#activeCall.sessionId,
    );
    if (!this.#activeCall) return;
    this.#setPhoneState("ready");
    this.#setRecStatus("Standby");
  }

  // ── AI response delivery: typewrite + TTS concurrently ─────────────────────

  /**
   * Typewrite the AI response text and play TTS simultaneously.
   * @param {string} text
   * @param {string|null} voiceId  ElevenLabs voice ID
   * @param {number} sessionId
   */
  async #deliverResponse(text, voiceId, sessionId) {
    this.#isSpeaking = true;
    this.#audio.startStatic();

    try {
      await Promise.all([
        this.#typewriteSuspectLine(text, sessionId),
        this.#settings.muteVoices
          ? Promise.resolve()
          : this.#voice.speak(text, voiceId).catch((err) => {
              console.warn(
                "[GameController] TTS failed (non-fatal):",
                err.message,
              );
            }),
      ]);
    } finally {
      this.#isSpeaking = false;
      this.#audio.stopStatic();
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // MENTIONED PERSON HANDLING
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * When a witness mentions someone new by name, add them to the contact list.
   * @param {string}      firstName
   * @param {string|null} surname
   */
  async #handleMentionedPerson(firstName, surname) {
    if (!firstName?.trim()) return;

    const surnameSafe = (surname ?? "").trim();
    const fullName = `${firstName} ${surnameSafe}`.trim();

    // Skip if already a known suspect
    if (this.#caseState.getSuspectByName(fullName)) return;

    // Skip if already in contact list
    if (this.#contactManager.findByName(fullName)) return;

    const mentionedGender = this.#inferContactGender(firstName);
    const mentionedVoice = this.#voiceProfileForGender(
      mentionedGender,
      "mentioned",
    );
    const newContact = ContactManager.createFromMention(
      firstName,
      surnameSafe,
      {
        gender: mentionedGender,
        voiceArchetype: mentionedVoice.archetype,
        voiceId: mentionedVoice.id,
        passportPhotoFile: mentionedVoice.photo,
      },
    );
    const added = this.#contactManager.discover(newContact);
    if (!added) return;

    // Keep passport database fresh
    this.#passportDatabase.rebuild(this.#caseState, this.#contactManager);

    // Update contacts list UI
    this.#addContactToUI(newContact);

    this.#showNotification(`New contact added: ${fullName}`);
    console.info(`[GameController] Discovered contact: ${fullName}`);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // COMPUTER TERMINAL
  // ───────────────────────────────────────────────────────────────────────────

  #openComputer() {
    const sidebar = this.#els.computerSidebar;
    if (!sidebar) return;
    if (this.#activeCall) this.#endCurrentCall();

    const isOpen = sidebar.classList.contains("open");
    if (isOpen) {
      // Toggle off — close it
      this.#closeComputer();
      return;
    }

    sidebar.classList.add("open");
    this.#els.btnOpenComputer?.classList.add("active");
    this.#els.btnComputer?.classList.add("active");

    // Default to passports tab and rebuild contacts list
    this.#switchComputerTab("passports");
  }

  #closeComputer() {
    const sidebar = this.#els.computerSidebar;
    if (!sidebar) return;
    sidebar.classList.remove("open");
    this.#els.btnOpenComputer?.classList.remove("active");
    this.#els.btnComputer?.classList.remove("active");
  }

  /**
   * Switch between the Passports and Contacts tabs.
   * @param {'passports'|'contacts'|'witnesses'} tab
   */
  #switchComputerTab(tab) {
    const e = this.#els;

    e.tabBtnPassports?.classList.remove("active");
    e.tabBtnContacts?.classList.remove("active");

    if (e.compPassportView) e.compPassportView.style.display = "none";
    e.compContactsView?.classList.remove("active");

    if (tab === "passports") {
      e.tabBtnPassports?.classList.add("active");
      if (e.compPassportView) e.compPassportView.style.display = "";
    } else if (tab === "contacts") {
      e.tabBtnContacts?.classList.add("active");
      e.compContactsView?.classList.add("active");
      this.#buildContactsList();
    }
  }

  /**
   * Switch between Physical Evidence and Phone Records tabs.
   * @param {'items'|'calls'} tab
   */
  #switchEvidenceTab(tab) {
    const e = this.#els;
    const isItems = tab === "items";
    e.evTabBtnItems?.classList.toggle("active", isItems);
    e.evTabBtnCalls?.classList.toggle("active", !isItems);
    if (e.evidenceItemsList)
      e.evidenceItemsList.style.display = isItems ? "" : "none";
    if (e.panelPhoneCalls)
      e.panelPhoneCalls.classList.toggle("active", !isItems);
  }

  /**
   * Render the phone call records for all suspects.
   */
  #renderPhoneCalls() {
    const container = this.#els.panelPhoneCalls;
    if (!container || !this.#caseState) return;
    container.innerHTML = "";

    const calls = this.#caseState.phoneCalls ?? [];
    if (!calls.length) {
      container.innerHTML = `<p style="font-size:10px;color:rgba(201,186,160,0.3);letter-spacing:2px;font-family:'Courier New',monospace;padding:16px;">No call records available.</p>`;
      return;
    }

    // Header row
    const header = document.createElement("div");
    header.style.cssText =
      "display:grid;grid-template-columns:70px 1fr 1fr 80px;gap:6px;padding:6px 10px;font-size:8px;letter-spacing:3px;color:rgba(201,186,160,0.35);font-family:'Courier New',monospace;border-bottom:1px solid rgba(201,186,160,0.08)";
    header.innerHTML =
      "<span>TIME</span><span>TO</span><span>FROM</span><span>DURATION</span>";
    container.appendChild(header);

    calls.forEach((call) => {
      const row = document.createElement("div");
      row.className = "phone-call-record";

      row.innerHTML = `
        <span class="call-time">${this.#escapeHtml(call.time)}</span>
        <span class="call-to">${this.#escapeHtml(call.toNumber)}</span>
        <span class="call-from">${this.#escapeHtml(call.fromNumber)}</span>
        <span class="call-dur">${this.#escapeHtml(call.duration)}</span>`;

      container.appendChild(row);
    });
  }

  #handlePassportSearch() {
    if (!this.#passportDatabase) return;
    const query = this.#els.passportSearchInput.value.trim();
    const area = this.#els.passportResultArea;
    if (!query) return;

    const records = this.#passportDatabase.lookupAll(query);

    if (records.length > 0) {
      area.innerHTML = records
        .map((record) =>
          this.#renderPassportCard(record, {
            title: "PASSPORT",
          }),
        )
        .join("");
    } else {
      area.innerHTML = `
        <p style="
          font-size:11px;
          color:rgba(57,255,20,0.4);
          letter-spacing:2px;
          font-family:'Courier New',monospace;
          line-height:2;
        ">NO RECORDS FOUND FOR: ${this.#escapeHtml(query.toUpperCase())}</p>`;
    }
  }

  #buildPassportRecordForSuspect(suspect, source = "official") {
    const provided = suspect.providedPassport ?? {};

    if (source === "provided") {
      return {
        person: `${suspect.name} ${suspect.surname}`,
        id_number: provided.id_number ?? suspect.passportId,
        address: provided.address ?? suspect.passportAddress,
        nationality: provided.nationality ?? suspect.passportNationality,
        issue_date: provided.issue_date ?? suspect.passportIssue,
        expiry_date: provided.expiry_date ?? suspect.passportExpiry,
        date_of_birth: provided.date_of_birth ?? suspect.dateOfBirth ?? null,
        phone_number: provided.phone_number ?? suspect.phoneNumber ?? null,
        passportPhotoFile:
          provided.passportPhotoFile ?? suspect.passportPhotoFile ?? null,
        is_fake: suspect.passportFake ?? false,
        discrepancy: suspect.passportDiscrepancy ?? null,
        uvFlags: provided.uvFlags ?? {},
      };
    }

    return {
      person: `${suspect.name} ${suspect.surname}`,
      id_number: suspect.passportId,
      address: suspect.passportAddress,
      nationality: suspect.passportNationality,
      issue_date: suspect.passportIssue,
      expiry_date: suspect.passportExpiry,
      date_of_birth: suspect.dateOfBirth ?? null,
      phone_number: suspect.phoneNumber ?? null,
      passportPhotoFile: suspect.passportPhotoFile ?? null,
      is_fake: false,
      discrepancy: null,
      uvFlags: {},
    };
  }

  /**
   * Render a passport record as an HTML string.
   * @param {object} record
   * @param {object} [opts]
   * @returns {string}
   */
  #renderPassportCard(record, opts = {}) {
    const {
      title = "PASSPORT",
      rootClass = "",
      showAlert = false,
    } = opts;

    const nameParts = (record.person ?? "").split(" ");
    const initials =
      nameParts.length >= 2
        ? `${nameParts[0][0] ?? "?"}${nameParts[nameParts.length - 1][0] ?? "?"}`
        : (nameParts[0]?.[0] ?? "?");
    const givenName = (nameParts[0] ?? "").toUpperCase();
    const surname = nameParts.slice(1).join(" ").toUpperCase() || givenName;
    const uvFlags = record.uvFlags ?? {};

    let expired = false;
    if (record.expiry_date) {
      try {
        const parts = String(record.expiry_date).split("/");
        const d =
          parts.length === 2
            ? new Date(`${parts[1]}-${parts[0].padStart(2, "0")}-01`)
            : new Date(record.expiry_date);
        const referenceDate = this.#caseState?.caseDateISO
          ? new Date(this.#caseState.caseDateISO)
          : new Date();
        if (!isNaN(d.getTime()) && d < referenceDate) expired = true;
      } catch {
        /* ignore malformed date */
      }
    }

    let alertBanner = "";
    if (showAlert && record.is_fake) {
      alertBanner = `<div class="passport-alert fake">DISCREPANCY DETECTED — ${this.#escapeHtml(record.discrepancy ?? "Document flagged as irregular")}</div>`;
    } else if (showAlert && expired) {
      alertBanner = `<div class="passport-alert expired">DOCUMENT EXPIRED</div>`;
    }

    const uvAttr = (key) =>
      uvFlags[key] ? ` data-uv="${this.#escapeHtml(uvFlags[key])}"` : "";
    const field = (label, value, uvKey = null) => `
      <div class="passport-field"${uvKey ? uvAttr(uvKey) : ""}>
        <span>${this.#escapeHtml(label)}</span>
        <strong>${this.#escapeHtml(String(value ?? "—"))}</strong>
      </div>`;

    const photoFile = record.passportPhotoFile;
    const photoSrc = photoFile
      ? `/assets/faces/${this.#escapeHtml(photoFile)}.jpg`
      : null;

    return `
      <div class="passport-card ${this.#escapeHtml(rootClass)}">
        <div class="passport-header">${this.#escapeHtml(title)}</div>
        <div class="passport-body">
          <div class="passport-photo-frame"${uvAttr("photo")}>
            ${
              photoSrc
                ? `<img class="passport-photo-img"
                      src="${photoSrc}"
                      alt="ID Photo"
                      onerror="this.style.display='none';if(this.nextElementSibling)this.nextElementSibling.style.display='flex'">`
                : ""
            }
            <div class="passport-photo-fallback"
                 style="${photoSrc ? "display:none" : ""}">${this.#escapeHtml(initials.toUpperCase())}</div>
          </div>
          <div class="passport-fields">
            <div class="passport-id-box"${uvAttr("id_number")}>
              <span class="passport-id-label">ID NUMBER</span>
              <span class="passport-id-value"${uvAttr("id_number")}>${this.#escapeHtml(record.id_number ?? "—")}</span>
            </div>
            ${field("SURNAME", surname, "surname")}
            ${field("GIVEN NAME", givenName, "given_name")}
            ${field("DATE OF BIRTH", record.date_of_birth, "date_of_birth")}
            ${field("NATIONALITY", record.nationality, "nationality")}
            ${field("PHONE", record.phone_number, "phone_number")}
            ${field("ADDRESS", record.address, "address")}
            <div class="passport-dates-row">
              ${field("ISSUED", record.issue_date, "issue_date")}
              ${field("EXPIRES", record.expiry_date, "expiry_date")}
            </div>
          </div>
        </div>
        ${alertBanner}
      </div>`;
  }

  // ── Contacts list ──────────────────────────────────────────────────────────

  #getDirectoryEntries() {
    const suspects = (this.#caseState?.suspects ?? [])
      .filter((suspect) => !suspect.contactClosed)
      .map((suspect) => ({
        id: suspect.id,
        name: suspect.name,
        surname: suspect.surname,
        phoneNumber: suspect.phoneNumber ?? "—",
        relationship: suspect.occupation ?? "suspect",
        directoryType: "suspect",
      }));

    const witnesses = (this.#caseState?.witnesses ?? []).map((witness) => ({
      id: witness.id,
      name: witness.name,
      surname: witness.surname,
      phoneNumber: witness.phoneNumber ?? "—",
      relationship: witness.relationship ?? "witness",
      directoryType: "witness",
    }));

    const discovered = (this.#contactManager?.getAll() ?? []).map((contact) => ({
      ...contact,
      directoryType: contact.directoryType ?? "contact",
    }));

    return [...witnesses, ...suspects, ...discovered];
  }

  #buildRecognitionKeyterms(person = null) {
    if (!this.#caseState) return [];

    const rawTerms = [];
    const push = (...values) => {
      values.forEach((value) => {
        if (value == null) return;
        rawTerms.push(String(value));
      });
    };

    const splitPhrase = (value) => {
      String(value ?? "")
        .split(/[\s,./\-|()]+/)
        .map((part) => part.trim())
        .filter(Boolean)
        .forEach((part) => rawTerms.push(part));
    };

    const victim = this.#caseState.victim;
    push(victim?.name, victim?.surname, victim?.foundAt, victim?.occupation);
    splitPhrase(victim?.name);
    splitPhrase(victim?.foundAt);

    if (person) {
      push(
        person.name,
        person.surname,
        `${person.name ?? ""} ${person.surname ?? ""}`.trim(),
        person.occupation,
        person.relationship,
        person.alibiLocation,
        person.forSuspectName,
      );
      splitPhrase(person.name);
      splitPhrase(person.surname);
      splitPhrase(person.alibiLocation);
      splitPhrase(person.forSuspectName);
    }

    this.#caseState.suspects.slice(0, 10).forEach((suspect) => {
      push(suspect.name, suspect.surname, suspect.alibiLocation);
      splitPhrase(suspect.name);
      splitPhrase(suspect.surname);
    });

    this.#caseState.witnesses.slice(0, 4).forEach((witness) => {
      push(witness.name, witness.surname, witness.relationship);
      splitPhrase(witness.name);
      splitPhrase(witness.surname);
    });

    const cleaned = rawTerms
      .map((term) => term.replace(/[^\p{L}\p{N}'& ]+/gu, " ").trim())
      .filter((term) => term.length >= 2 && term.length <= 20);

    return Array.from(new Set(cleaned)).slice(0, 50);
  }

  /** Rebuild the contacts list — includes witnesses, suspects, and discovered contacts. */
  #buildContactsList() {
    const list = this.#els.contactsList;
    list.innerHTML = "";

    const entries = this.#getDirectoryEntries();
    if (entries.length === 0) {
      list.innerHTML = `
        <p style="
          font-size:11px;
          color:rgba(57,255,20,0.3);
          letter-spacing:2px;
          font-family:'Courier New',monospace;
          padding:16px;
        ">No contacts discovered yet.</p>`;
      return;
    }

    entries.forEach((entry) => list.appendChild(this.#makeContactCard(entry)));
  }

  #updateUvScannerPosition(ev) {
    const stage = this.#els.uvScanStage;
    const passport = this.#els.uvScanPassport;
    if (!stage || !passport) return;
    const rect = stage.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const y = ev.clientY - rect.top;
    passport.style.setProperty("--uv-x", `${x}px`);
    passport.style.setProperty("--uv-y", `${y}px`);
  }

  #openUvScanner() {
    if (!this.#activeDossierSuspectId || !this.#caseState) return;
    const suspect = this.#caseState.getSuspect(this.#activeDossierSuspectId);
    if (!suspect) return;

    const record = this.#buildPassportRecordForSuspect(suspect, "provided");
    const markup = this.#renderPassportCard(record, {
      title: "PRESENTED PASSPORT",
      rootClass: "uv-passport-card",
      showAlert: false,
    });

    this.#els.uvScanPassport.innerHTML = `
      <div class="uv-passport-layer uv-passport-shadow">${markup}</div>
      <div class="uv-passport-layer uv-passport-reveal">${markup}</div>`;

    this.#els.overlayUvScanner?.classList.add("open");
  }

  #closeUvScanner() {
    this.#els.overlayUvScanner?.classList.remove("open");
  }

  /**
   * Render the suspect's given (physical) passport into #given-passport-card.
   * @param {object} suspect
   */
  #renderGivenPassport(suspect) {
    const card = this.#els.givenPassportCard;
    if (!card) return;

    const record = this.#buildPassportRecordForSuspect(suspect, "provided");
    card.innerHTML = this.#renderPassportCard(record, {
      title: "PRESENTED PASSPORT",
      rootClass: "passport-card-given",
      showAlert: false,
    });
  }

  /**
   * Create a contact card DOM element.
   * @param {object} contact
   * @returns {HTMLElement}
   */
  #makeContactCard(contact) {
    const card = document.createElement("div");
    card.className = "contact-card";
    card.dataset.contactId = contact.id;
    const relationship =
      contact.relationship &&
      !["none", "unknown", "contact"].includes(
        String(contact.relationship).trim().toLowerCase(),
      )
        ? contact.relationship
        : contact.isAlibiVerifier
          ? "Alibi witness"
          : "Contact";
    const directoryType =
      contact.directoryType &&
      !["none", "unknown"].includes(
        String(contact.directoryType).trim().toLowerCase(),
      )
        ? contact.directoryType
        : contact.isAlibiVerifier
          ? "alibi witness"
          : "contact";

    const nameEl = document.createElement("div");
    nameEl.className = "contact-card-name";
    nameEl.textContent = `${contact.name} ${contact.surname}`;

    const phoneEl = document.createElement("div");
    phoneEl.className = "contact-card-phone";
    phoneEl.textContent = contact.phoneNumber ?? "—";

    const roleEl = document.createElement("div");
    roleEl.className = "contact-card-role";
    roleEl.textContent = relationship;
    if (contact.isAlibiVerifier && contact.forSuspectName) {
      roleEl.textContent += ` | for ${contact.forSuspectName}`;
    }

    const kindEl = document.createElement("div");
    kindEl.className = "contact-card-kind";
    kindEl.textContent = directoryType;

    const callBtn = document.createElement("button");
    callBtn.style.cssText = [
      "margin-top:6px",
      "padding:4px 12px",
      "font-size:9px",
      "letter-spacing:2px",
      "background:rgba(57,255,20,0.1)",
      "border:1px solid rgba(57,255,20,0.3)",
      "color:var(--comp-green)",
      "cursor:pointer",
      "font-family:'Courier New',monospace",
      "transition:background 0.15s",
    ].join(";");
    callBtn.textContent = "Call";
    callBtn.addEventListener("click", () => {
      if (contact.directoryType === "suspect") {
        this.#prepareSuspectCall(contact.id);
      } else {
        this.#prepareContactCall(contact.id);
      }
    });
    callBtn.addEventListener("mouseenter", () => {
      callBtn.style.background = "rgba(57,255,20,0.2)";
    });
    callBtn.addEventListener("mouseleave", () => {
      callBtn.style.background = "rgba(57,255,20,0.1)";
    });

    card.appendChild(nameEl);
    card.appendChild(phoneEl);
    card.appendChild(roleEl);
    card.appendChild(kindEl);
    card.appendChild(callBtn);
    return card;
  }

  /**
   * Append a single newly-discovered contact to the contacts list UI.
   * Removes the "no contacts" placeholder if present.
   * @param {object} contact
   */
  #addContactToUI(contact) {
    this.#buildContactsList();
  }

  // ───────────────────────────────────────────────────────────────────────────
  // EVIDENCE BOARD
  // ───────────────────────────────────────────────────────────────────────────

  #openEvidenceBoard() {
    this.#renderEvidenceItems();
    this.#showPanel("evidence");
  }

  /** Re-render all evidence items from the evidence manager. */
  #renderEvidenceItems() {
    if (!this.#evidenceManager) return;
    const list = this.#els.evidenceItemsList;
    const empty = this.#els.evidenceEmptyState;
    const items = this.#evidenceManager.getAll();

    // Remove all children except the empty-state placeholder
    Array.from(list.children).forEach((child) => {
      if (child !== empty) child.remove();
    });

    if (items.length === 0) {
      if (empty) empty.style.display = "";
      return;
    }
    if (empty) empty.style.display = "none";

    items.forEach((item) => list.appendChild(this.#makeEvidenceItemEl(item)));
  }

  /**
   * Build a DOM element for a single evidence item.
   * @param {object} item
   * @returns {HTMLElement}
   */
  #makeEvidenceItemEl(item) {
    const div = document.createElement("div");
    div.className = "evidence-item";
    div.dataset.evidenceId = item.id;

    // Type tag
    const tag = document.createElement("div");
    tag.className = "evidence-item-tag";
    tag.textContent = (item.type ?? "UNKNOWN").toUpperCase();

    // Description
    const label = document.createElement("div");
    label.className = "evidence-item-label";
    label.textContent = item.description ?? "—";

    // Status badge
    const badge = document.createElement("span");
    badge.className = "evidence-status-badge";
    if (item.status === "discovered") {
      badge.classList.add("unanalyzed");
      badge.textContent = "COLLECTED";
    } else if (item.status === "analyzing") {
      badge.classList.add("pending");
      badge.textContent = "ANALYZING";
    } else {
      badge.classList.add("analyzed");
      badge.textContent = "ANALYZED";
    }

    div.appendChild(tag);
    div.appendChild(label);
    div.appendChild(badge);

    const meta = document.createElement("div");
    meta.style.cssText =
      "margin-top:8px;font-size:11px;color:rgba(34,24,14,0.72);letter-spacing:0.6px;line-height:1.55;font-weight:700;";

    const recoveredFrom = item.recoveredFromLabel ?? null;
    const linkedPerson = item.belongsToId
      ? this.#caseState?.getPersonById(item.belongsToId)
      : null;
    const metaParts = [];

    if (recoveredFrom) metaParts.push(`Taken from ${recoveredFrom}`);
    if (item.status === "analyzing" && item.analysisDueAt) {
      metaParts.push(`Lab ETA: ${this.#formatEta(item.analysisDueAt - Date.now())}`);
    } else if (item.sceneCategory === "document") {
      metaParts.push("Manual verification item");
    } else if (item.status === "discovered") {
      metaParts.push("Awaiting lab dispatch");
    } else if (linkedPerson) {
      metaParts.push(`Belonged to ${linkedPerson.name} ${linkedPerson.surname}`);
    } else if (item.status === "analyzed") {
      metaParts.push("Belonged to nobody relevant");
    }

    meta.textContent = metaParts.join(" | ");
    if (meta.textContent) div.appendChild(meta);

    // Analysis result text
    if (item.status === "analyzed" && item.result) {
      const resultEl = document.createElement("div");
      resultEl.style.cssText =
        "margin-top:8px;font-size:12px;color:#1d4d23;letter-spacing:0.4px;line-height:1.65;font-weight:700;text-shadow:none;";
      resultEl.textContent = item.result;
      div.appendChild(resultEl);
    }

    return div;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // EXAMINE OVERLAY
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Open the magnifying-glass examine overlay for a suspect or the victim.
   * @param {string} suspectIdOrVictim  Suspect ID, or 'VICTIM'
   */
  #openExamine(suspectIdOrVictim) {
    if (!this.#caseState) return;
    if (this.#activeCall) this.#endCurrentCall();
    const e = this.#els;
    e.overlayExamine.dataset.targetId = suspectIdOrVictim;

    if (suspectIdOrVictim === "VICTIM") {
      const victim = this.#caseState.victim;
      e.examineTitle.textContent = `Examining: ${victim.name} — Victim`;
    } else {
      const suspect = this.#caseState.getSuspect(suspectIdOrVictim);
      if (!suspect) return;
      e.examineTitle.textContent = `Examining: ${suspect.name} ${suspect.surname}`;
    }

    this.#renderExamineScene(this.#buildSceneItemsForTarget(suspectIdOrVictim));
    e.overlayExamine.classList.add("open");
  }

  #buildSceneItemsForTarget(targetId) {
    if (!this.#caseState) return [];

    if (targetId === "VICTIM") {
      const sceneItems = this.#caseState.victim.sceneItems;
      if (Array.isArray(sceneItems) && sceneItems.length > 0) return sceneItems;
      return (this.#caseState.victimEvidence ?? []).map((item, index) => ({
        ...item,
        sceneCategory: "analysis",
        label: item.label ?? `Evidence ${index + 1}`,
        subtitle: item.subtitle ?? "item",
        spriteSrc: item.spriteSrc ?? "/assets/evidence/hair.png",
        xPercent: 10 + (index % 4) * 20,
        yPercent: 12 + Math.floor(index / 4) * 24,
        rotation: 0,
      }));
    }

    const suspect = this.#caseState.getSuspect(targetId);
    if (!suspect) return [];
    if (Array.isArray(suspect.sceneItems) && suspect.sceneItems.length > 0) {
      return suspect.sceneItems;
    }

    return [
      {
        id: `J_${suspect.id}_1`,
        sceneCategory: "junk",
        type: "document",
        label: "Paper",
        subtitle: "paper",
        description: "A messy stack of paper scraps and receipts.",
        spriteSrc: "/assets/evidence/junk_paper1.png",
        xPercent: 8,
        yPercent: 12,
        rotation: -3,
      },
      {
        id: `J_${suspect.id}_2`,
        sceneCategory: "junk",
        type: "document",
        label: "Paper",
        subtitle: "paper",
        description: "A messy stack of receipts and paper scraps.",
        spriteSrc: "/assets/evidence/junk_paper2.png",
        xPercent: 31,
        yPercent: 18,
        rotation: 4,
      },
    ];
  }

  #renderSceneIntoHost(host, items, targetId, noteText = "") {
    if (!host) return;
    host.innerHTML = "";
    const board = document.createElement("div");
    board.className = "examine-scene-board";
    const maxXPx = items.reduce(
      (max, item) =>
        Math.max(max, Number(item.xPx ?? 0) + Number(item.widthPx ?? 112)),
      0,
    );
    const maxYPx = items.reduce(
      (max, item) =>
        Math.max(max, Number(item.yPx ?? 0) + Number(item.heightPx ?? 112)),
      0,
    );
    board.style.minWidth = `${Math.max(860, host.clientWidth || 860, maxXPx + 120)}px`;
    board.style.minHeight = `${Math.max(640, host.clientHeight || 640, maxYPx + 80)}px`;

    items.forEach((item) =>
      board.appendChild(this.#makeSceneItemEl(item, targetId)),
    );

    host.appendChild(board);
    if (noteText) {
      const note = document.createElement("div");
      note.className = "examine-scene-note";
      note.textContent = noteText;
      host.appendChild(note);
    }
  }

  #renderExamineScene(items) {
    const host = this.#els.examineItemsList;
    const targetId = this.#els.overlayExamine?.dataset?.targetId ?? "SCENE";
    this.#renderSceneIntoHost(
      host,
      items,
      targetId,
      "Shift the clutter around and tag anything that feels worth keeping.",
    );
  }

  #renderDossierEvidenceView(suspectId) {
    const host = this.#els.dossierEvidenceHost;
    if (!host) return;
    const suspect = this.#caseState?.getSuspect(suspectId);
    if (!suspect) {
      host.innerHTML =
        '<p class="examine-scene-note">Select a suspect to review seized belongings.</p>';
      return;
    }
    this.#renderSceneIntoHost(
      host,
      this.#buildSceneItemsForTarget(suspectId),
      suspectId,
    );
  }

  #makeSceneItemEl(item, targetId) {
    const el = document.createElement("div");
    const actionable = item.sceneCategory === "analysis";
    const documentItem = item.sceneCategory === "document";
    const savedPosition = this.#getSceneItemPosition(targetId, item.id);
    el.className = "scene-item";
    if (actionable) el.classList.add("actionable");
    if (documentItem) el.classList.add("document");
    el.style.left = savedPosition?.left ?? `${item.xPx ?? 8}px`;
    el.style.top = savedPosition?.top ?? `${item.yPx ?? 12}px`;
    el.style.setProperty("--rot", `${item.rotation ?? 0}deg`);
    el.style.setProperty("--scene-w", `${item.widthPx ?? 112}px`);
    el.style.setProperty("--scene-h", `${item.heightPx ?? 112}px`);
    el.style.zIndex = String(item.stackOrder ?? 10);

    const sprite = document.createElement("div");
    sprite.className = "scene-item-sprite";
    sprite.style.backgroundImage = `url('${item.spriteSrc ?? "/assets/evidence/junk_paper1.png"}')`;

    el.appendChild(sprite);
    this.#enableSceneDrag(el, targetId, item.id, item);

    return el;
  }

  #handleSceneItemAction(item) {
    if (!this.#evidenceManager) return;
    const existing = this.#evidenceManager.get(item.id);

    if (item.sceneCategory === "document") {
      if (!existing) {
        this.#evidenceManager.discover({
          ...item,
          status: "analyzed",
          result: item.analysisResult ?? "Filed into evidence.",
        });
        this.#evidenceManager.completeAnalysis(
          item.id,
          item.analysisResult ?? "Filed into evidence.",
          item.belongsToId ?? null,
        );
        this.#renderEvidenceItems();
        this.#persistProgress();
      }
      this.#showNotification("Document filed in evidence");
      return;
    }

    if (existing?.status === "analyzing") {
      this.#showNotification("This item is already with the lab");
      return;
    }
    if (existing?.status === "analyzed") {
      this.#showNotification("Lab report already returned");
      return;
    }

    if (!existing) {
      this.#evidenceManager.discover({
        ...item,
        status: "discovered",
      });
    }
    this.#queueEvidenceAnalysis(item.id);
    this.#renderEvidenceItems();
    this.#persistProgress();
    this.#showNotification("Sent to the lab");
  }

  #refreshOpenExamineScene() {
    const targetId = this.#els.overlayExamine?.dataset?.targetId;
    if (!targetId || !this.#els.overlayExamine?.classList.contains("open")) return;
    this.#renderExamineScene(this.#buildSceneItemsForTarget(targetId));
  }

  #enableSceneDrag(el, targetId, itemId, item = null) {
    let pointerId = null;
    let startX = 0;
    let startY = 0;
    let baseLeft = 0;
    let baseTop = 0;
    let moved = false;

    el.addEventListener("pointerdown", (ev) => {
      pointerId = ev.pointerId;
      startX = ev.clientX;
      startY = ev.clientY;
      baseLeft = el.offsetLeft;
      baseTop = el.offsetTop;
      moved = false;
      el.classList.add("dragging");
      el.setPointerCapture(pointerId);
    });

    el.addEventListener("pointermove", (ev) => {
      if (pointerId !== ev.pointerId) return;
      const parent = el.parentElement;
      if (!parent) return;
      const nextLeft = Math.max(
        0,
        Math.min(parent.clientWidth - el.offsetWidth, baseLeft + (ev.clientX - startX)),
      );
      const nextTop = Math.max(
        0,
        Math.min(parent.clientHeight - el.offsetHeight, baseTop + (ev.clientY - startY)),
      );
      if (
        Math.abs(ev.clientX - startX) > 6 ||
        Math.abs(ev.clientY - startY) > 6
      ) {
        moved = true;
      }
      el.style.left = `${nextLeft}px`;
      el.style.top = `${nextTop}px`;
    });

    const finishDrag = (ev) => {
      if (pointerId !== ev.pointerId) return;
      el.classList.remove("dragging");
      el.releasePointerCapture(pointerId);
      this.#setSceneItemPosition(targetId, itemId, {
        left: el.style.left,
        top: el.style.top,
      });
      const shouldTriggerAction =
        !moved &&
        item &&
        (item.sceneCategory === "analysis" || item.sceneCategory === "document");
      pointerId = null;
      if (shouldTriggerAction) {
        this.#handleSceneItemAction(item);
      }
    };

    el.addEventListener("pointerup", finishDrag);
    el.addEventListener("pointercancel", finishDrag);
  }

  #closeExamine() {
    if (this.#els.overlayExamine) delete this.#els.overlayExamine.dataset.targetId;
    this.#els.overlayExamine.classList.remove("open");
  }

  #getSceneItemPosition(targetId, itemId) {
    return this.#sceneItemPositions.get(`${targetId}:${itemId}`) ?? null;
  }

  #setSceneItemPosition(targetId, itemId, position) {
    this.#sceneItemPositions.set(`${targetId}:${itemId}`, position);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // ARREST FLOW
  // ───────────────────────────────────────────────────────────────────────────

  #handleArrest() {
    if (!this.#caseState || !this.#suspicionManager) return;
    this.#showArrestModal();
  }

  /** Dynamically create and display the arrest confirmation modal. */
  #showArrestModal() {
    this.#closeArrestModal();
    const selected = new Set();

    const overlay = document.createElement("div");
    overlay.id = "arrest-modal";
    overlay.style.cssText = [
      "position:fixed",
      "inset:0",
      "z-index:200",
      "background:rgba(13,12,11,0.93)",
      "backdrop-filter:blur(4px)",
      "display:flex",
      "align-items:center",
      "justify-content:center",
    ].join(";");

    const card = document.createElement("div");
    card.style.cssText = [
      "background:#100e0c",
      "border:2px solid var(--accent-red)",
      "padding:32px 40px",
      "max-width:480px",
      "width:90%",
      "box-shadow:0 0 60px rgba(139,28,28,0.4)",
      "font-family:var(--font-main)",
    ].join(";");

    const title = document.createElement("h2");
    title.style.cssText =
      "font-size:14px;letter-spacing:6px;text-transform:uppercase;color:var(--accent-red);margin-bottom:6px;";
    title.textContent = "Make Arrest";

    const subtitle = document.createElement("p");
    subtitle.style.cssText =
      "font-size:11px;letter-spacing:2px;color:var(--paper-dark);opacity:0.6;margin-bottom:24px;";
    subtitle.textContent =
      "Select every suspect you believe was involved. You can choose up to three.";

    card.appendChild(title);
    card.appendChild(subtitle);

    const confirmBtn = document.createElement("button");
    confirmBtn.style.cssText = [
      "margin-top:20px",
      "padding:8px 22px",
      "font-size:10px",
      "letter-spacing:4px",
      "text-transform:uppercase",
      "color:#fff",
      "background:var(--accent-red)",
      "border:1px solid #a02020",
      "cursor:pointer",
      "font-family:var(--font-main)",
      "opacity:0.45",
    ].join(";");
    confirmBtn.textContent = "Confirm Arrest";
    confirmBtn.disabled = true;

    const refreshConfirmState = () => {
      confirmBtn.disabled = selected.size === 0;
      confirmBtn.style.opacity = selected.size === 0 ? "0.45" : "1";
    };

    // List every suspect with a toggle for accusation
    this.#caseState.suspects.forEach((s) => {
      const row = document.createElement("div");
      row.style.cssText =
        "display:flex;align-items:center;gap:14px;padding:10px 0;border-bottom:1px solid rgba(58,46,30,0.5);";

      const info = document.createElement("div");
      info.style.flex = "1";
      info.innerHTML = `
        <div style="font-size:12px;letter-spacing:2px;color:var(--paper);">
          ${this.#escapeHtml(`${s.name} ${s.surname}`)}
        </div>
        <div style="font-size:9px;letter-spacing:2px;color:var(--paper-dark);opacity:0.55;text-transform:uppercase;margin-top:2px;">
          ${this.#escapeHtml(s.occupation)} — ${this.#escapeHtml(s.phoneNumber ?? "NO NUMBER")}
        </div>`;

      const btn = document.createElement("button");
      btn.style.cssText = [
        "padding:7px 16px",
        "font-size:10px",
        "letter-spacing:3px",
        "text-transform:uppercase",
        "color:var(--paper-dark)",
        "background:transparent",
        "border:1px solid var(--border)",
        "cursor:pointer",
        "font-family:var(--font-main)",
        "transition:opacity 0.15s, background 0.15s, color 0.15s",
        "white-space:nowrap",
      ].join(";");
      btn.textContent = "SELECT";
      btn.addEventListener("click", () => {
        const isSelected = selected.has(s.id);
        if (!isSelected && selected.size >= 3) {
          this.#showNotification("You can select up to three suspects");
          return;
        }

        if (isSelected) {
          selected.delete(s.id);
          btn.textContent = "SELECT";
          btn.style.background = "transparent";
          btn.style.color = "var(--paper-dark)";
          btn.style.borderColor = "var(--border)";
        } else {
          selected.add(s.id);
          btn.textContent = "SELECTED";
          btn.style.background = "var(--accent-red)";
          btn.style.color = "#fff";
          btn.style.borderColor = "#a02020";
        }
        refreshConfirmState();
      });
      btn.addEventListener("mouseenter", () => {
        btn.style.opacity = "0.8";
      });
      btn.addEventListener("mouseleave", () => {
        btn.style.opacity = "1";
      });

      row.appendChild(info);
      row.appendChild(btn);
      card.appendChild(row);
    });

    confirmBtn.addEventListener("click", () => {
      this.#closeArrestModal();
      this.#confirmArrest(Array.from(selected));
    });
    card.appendChild(confirmBtn);

    // Cancel button
    const cancelBtn = document.createElement("button");
    cancelBtn.style.cssText = [
      "margin-top:20px",
      "padding:8px 22px",
      "font-size:10px",
      "letter-spacing:4px",
      "text-transform:uppercase",
      "color:var(--paper-dark)",
      "background:transparent",
      "border:1px solid var(--border)",
      "cursor:pointer",
      "font-family:var(--font-main)",
      "transition:color 0.15s,border-color 0.15s",
    ].join(";");
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", () => this.#closeArrestModal());
    cancelBtn.addEventListener("mouseenter", () => {
      cancelBtn.style.color = "var(--paper)";
      cancelBtn.style.borderColor = "var(--paper-dark)";
    });
    cancelBtn.addEventListener("mouseleave", () => {
      cancelBtn.style.color = "var(--paper-dark)";
      cancelBtn.style.borderColor = "var(--border)";
    });
    card.appendChild(cancelBtn);

    overlay.appendChild(card);
    // Click outside the card to dismiss
    overlay.addEventListener("click", (ev) => {
      if (ev.target === overlay) this.#closeArrestModal();
    });

    this.#els.gameLayout.appendChild(overlay);
  }

  #closeArrestModal() {
    document.getElementById("arrest-modal")?.remove();
  }

  /**
   * Evaluate the arrest and transition to win or lose.
   * @param {string[]|string} suspectIds
   */
  #confirmArrest(suspectIds) {
    if (!this.#caseState) return;

    const picked = Array.isArray(suspectIds) ? suspectIds : [suspectIds];
    const correct = this.#caseState.checkArrest(picked);

    if (correct) {
      this.#setState("win");
    } else {
      const guiltyNames = this.#caseState
        .getGuiltySuspects()
        .map((suspect) => `${suspect.name} ${suspect.surname}`)
        .join(", ");
      const pickedNames = picked
        .map((id) => this.#caseState.getSuspect(id))
        .filter(Boolean)
        .map((suspect) => `${suspect.name} ${suspect.surname}`)
        .join(", ");
      this.#els.loseReasonText.textContent = `Wrong arrest. You chose ${pickedNames || "nobody"}, but the real culprits were ${guiltyNames}.`;
      this.#setState("lose");
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // PANEL MANAGEMENT
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Activate the named workspace panel, deactivate all others.
   * @param {'overview'|'dossier'|'call'|'computer'|'evidence'} name
   */
  #showPanel(name) {
    // 'computer' is now a sidebar, not a workspace panel — ignore it here
    if (name === "computer") {
      this.#openComputer();
      return;
    }

    if (name !== "call" && this.#activeCall) {
      this.#endCurrentCall();
    }

    if (name !== "dossier" || this.#activeDossierTab !== "passport") {
      this.#closeUvScanner();
    }

    document
      .querySelectorAll(".content-panel")
      .forEach((p) => p.classList.remove("active"));
    document.getElementById(`panel-${name}`)?.classList.add("active");

    // Reflect active panel in bottom bar buttons
    this.#els.btnOpenEvidence.classList.toggle("active", name === "evidence");
  }

  // ───────────────────────────────────────────────────────────────────────────
  // PHONE STATE
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Set the visual and interactive state of the phone button.
   *
   * Modes:
   *   'dial'     — Target selected, press once to place a call
   *   'ready'    — In call, waiting for player to press (enabled)
   *   'active'   — In call, mid-interaction (enabled)
   *   'speaking' — Player is speaking (recording active, pulse rings)
   *   'muted'    — Suspect is speaking / loading (disabled, muted sprite)
   *   'disabled' — No call in progress (disabled, muted sprite)
   *   'idle'     — No call in progress (disabled, active sprite)
   *
   * @param {'dial'|'ready'|'active'|'speaking'|'muted'|'disabled'|'idle'} mode
   */
  #setPhoneState(mode) {
    const btn = this.#els.btnPhone;
    const img = this.#els.phoneImg;
    const label = this.#els.phoneLabel;
    const PHONE_SRC = "/assets/buttons/phone.png";

    btn.classList.remove("is-active", "is-muted", "is-speaking", "is-dial");

    switch (mode) {
      case "dial":
        btn.disabled = false;
        btn.classList.add("is-dial");
        img.src = PHONE_SRC;
        label.textContent = "Call";
        this.#els.voiceHint.textContent = "";
        break;

      case "ready":
        btn.disabled = false;
        btn.classList.add("is-active");
        img.src = PHONE_SRC;
        label.textContent = "Hold to speak";
        this.#els.voiceHint.textContent = "";
        break;

      case "active":
        btn.disabled = false;
        btn.classList.add("is-active");
        img.src = PHONE_SRC;
        label.textContent = "Hold to speak";
        break;

      case "speaking":
        btn.disabled = false;
        btn.classList.add("is-speaking");
        img.src = PHONE_SRC;
        label.textContent = "Listening…";
        break;

      case "muted":
        btn.disabled = true;
        btn.classList.add("is-muted");
        img.src = PHONE_SRC;
        label.textContent = "Connecting";
        break;

      case "disabled":
        btn.disabled = true;
        btn.classList.add("is-muted");
        img.src = PHONE_SRC;
        label.textContent = "No call";
        this.#els.voiceHint.textContent = "";
        break;

      case "idle":
      default:
        btn.disabled = true;
        img.src = PHONE_SRC;
        label.textContent = "Standby";
        this.#els.voiceHint.textContent = "";
        break;
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // MUSIC ZONE
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Determine the music zone from the highest suspicion level across all
   * suspects, and crossfade if it has changed.
   *
   * Thresholds:
   *   0–30  → 'calm'
   *   30–70 → 'tense'
   *   70+   → 'critical'
   */
  #updateMusicZone() {
    if (!this.#suspicionManager) return;

    const levels = Object.values(this.#suspicionManager.getAll());
    const highest = levels.length > 0 ? Math.max(...levels) : 0;

    const zone = highest >= 70 ? "critical" : highest >= 30 ? "tense" : "calm";

    if (zone !== this.#musicZone) {
      this.#musicZone = zone;
      this.#audio.crossfadeTo(zone);
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // TRANSCRIPT HELPERS
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Append a completed message bubble to the transcript immediately.
   * @param {'player'|'suspect'|'system'} role
   * @param {string} text
   */
  #addToTranscript(role, text) {
    const transcript = this.#els.transcript;
    const emptyEl = this.#els.transcriptEmpty;
    if (emptyEl) emptyEl.style.display = "none";

    const mergeTarget = this.#getTranscriptMergeTarget(role);
    if (mergeTarget) {
      mergeTarget.textContent = `${mergeTarget.textContent} ${text}`.trim();
      this.#scrollTranscript();
      return;
    }

    const entry = document.createElement("div");
    const speaker = document.createElement("div");
    const line = document.createElement("div");

    if (role === "player") {
      entry.className = "transcript-entry player-entry";
      entry.dataset.role = "player";
      speaker.className = "transcript-speaker player";
      speaker.textContent = "Detective";
      line.className = "transcript-text player-text";
    } else if (role === "system") {
      entry.className = "transcript-entry";
      entry.dataset.role = "system";
      entry.style.cssText = "align-self:center;opacity:0.4;";
      speaker.className = "transcript-speaker";
      speaker.textContent = "— System";
      line.className = "transcript-text";
      line.style.cssText =
        "font-size:10px;letter-spacing:2px;color:var(--paper-dark);text-align:center;background:transparent;border:none;padding:2px 0;";
    } else {
      entry.className = "transcript-entry suspect-entry";
      entry.dataset.role = "suspect";
      speaker.className = "transcript-speaker suspect";
      speaker.textContent = this.#resolveCallerName();
      line.className = "transcript-text suspect-text";
    }

    line.textContent = text;
    entry.appendChild(speaker);
    entry.appendChild(line);
    transcript.appendChild(entry);
    this.#scrollTranscript();
  }

  /**
   * Append a suspect/witness response line with a typewriter animation.
   * Returns a Promise that resolves when typing is complete.
   * @param {string} text
   * @param {number} sessionId
   * @returns {Promise<void>}
   */
  async #typewriteSuspectLine(text, sessionId) {
    const transcript = this.#els.transcript;
    const emptyEl = this.#els.transcriptEmpty;
    if (emptyEl) emptyEl.style.display = "none";

    const mergeTarget = this.#getTranscriptMergeTarget("suspect");
    if (mergeTarget) {
      mergeTarget.textContent = `${mergeTarget.textContent} `;
      mergeTarget.classList.add("typing-cursor");
      this.#isTyping = true;
      const chars = Array.from(text);
      for (const ch of chars) {
        if (sessionId !== this.#callSessionId) {
          mergeTarget.classList.remove("typing-cursor");
          this.#isTyping = false;
          return;
        }
        mergeTarget.textContent += ch;
        this.#scrollTranscript();
        await this.#delay(TYPEWRITER_SPEED_MS);
      }
      mergeTarget.classList.remove("typing-cursor");
      this.#isTyping = false;
      return;
    }

    const entry = document.createElement("div");
    const speaker = document.createElement("div");
    const line = document.createElement("div");

    entry.className = "transcript-entry suspect-entry";
    entry.dataset.role = "suspect";
    speaker.className = "transcript-speaker suspect";
    speaker.textContent = this.#resolveCallerName();
    line.className = "transcript-text suspect-text typing-cursor";
    line.textContent = "";

    entry.appendChild(speaker);
    entry.appendChild(line);
    transcript.appendChild(entry);
    this.#scrollTranscript();

    this.#isTyping = true;
    const chars = Array.from(text); // Unicode-safe split
    for (const ch of chars) {
      if (sessionId !== this.#callSessionId) {
        line.classList.remove("typing-cursor");
        this.#isTyping = false;
        return;
      }
      line.textContent += ch;
      this.#scrollTranscript();
      await this.#delay(TYPEWRITER_SPEED_MS);
    }
    line.classList.remove("typing-cursor");
    this.#isTyping = false;
  }

  /** Resolve the display name for the current caller. */
  #resolveCallerName() {
    if (!this.#activeCall) return "Unknown";
    if (this.#activeCall.type === "suspect") {
      const s = this.#caseState?.getSuspect(this.#activeCall.id);
      return s ? s.name : "Suspect";
    }
    const c = this.#getCallableContact(this.#activeCall.id);
    return c ? c.name : "Witness";
  }

  /** Remove all message bubbles from the transcript area. */
  #clearTranscript() {
    const t = this.#els.transcript;
    const empty = this.#els.transcriptEmpty;
    Array.from(t.children).forEach((child) => {
      if (child !== empty) child.remove();
    });
    if (empty) empty.style.display = "";
  }

  #scrollTranscript() {
    const t = this.#els.transcript;
    if (t) t.scrollTop = t.scrollHeight;
  }

  #getTranscriptMergeTarget(role) {
    const transcript = this.#els.transcript;
    const lastEntry = Array.from(transcript.children)
      .reverse()
      .find((child) => child !== this.#els.transcriptEmpty);
    if (!(lastEntry instanceof HTMLElement)) return null;
    if (lastEntry.dataset.role !== role) return null;
    return lastEntry.querySelector(".transcript-text");
  }

  #getCallableContact(contactId) {
    const witness = (this.#caseState?.witnesses ?? []).find(
      (entry) => entry.id === contactId,
    );
    if (witness) return { ...witness, directoryType: "witness" };
    return this.#contactManager?.getContact(contactId) ?? null;
  }

  #syncPhoneAvailability() {
    if (this.#state !== "investigating") {
      this.#setPhoneState("disabled");
      return;
    }
    if (this.#activeCall) return;
    if (this.#pendingCallTarget) {
      this.#setPhoneState("dial");
      this.#setRecStatus("Ready to call");
      return;
    }
    this.#setPhoneState("idle");
    this.#setRecStatus("Standby");
  }

  #loadSettings() {
    try {
      const raw = window.localStorage.getItem(SETTINGS_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      this.#settings = {
        ...this.#settings,
        ...parsed,
      };
    } catch {
      /* ignore */
    }
  }

  #saveSettings() {
    try {
      window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.#settings));
    } catch {
      /* ignore */
    }
  }

  #applySettings() {
    this.#audio.setMusicMuted(Boolean(this.#settings.muteMusic));
    this.#audio.setSfxMuted(Boolean(this.#settings.muteSounds));
    if (this.#settings.muteVoices) {
      this.#voice.stopSpeaking();
    }
  }

  #renderSettingsUI() {
    const e = this.#els;
    const labels = { easy: "Easy", medium: "Medium", expert: "Expert" };
    const difficultyLabel = labels[this.#settings.difficulty] ?? "Medium";

    e.menuDifficultyNote.textContent = difficultyLabel;
    if (e.topbarDifficultyNote) {
      e.topbarDifficultyNote.textContent = difficultyLabel;
    }
    e.toggleSfxValue.textContent = this.#settings.muteSounds ? "On" : "Off";
    e.toggleVoicesValue.textContent = this.#settings.muteVoices ? "On" : "Off";
    e.toggleMusicValue.textContent = this.#settings.muteMusic ? "On" : "Off";

    e.difficultyPillRow
      ?.querySelectorAll("[data-difficulty]")
      .forEach((btn) => {
        btn.classList.toggle(
          "active",
          btn.getAttribute("data-difficulty") === this.#settings.difficulty,
        );
      });
  }

  #renderKeysUI(statusMessage = "") {
    const e = this.#els;
    if (e.inputGeminiKey) {
      e.inputGeminiKey.value = this.#settings.geminiApiKey ?? "";
    }
    if (e.inputOpenaiKey) {
      e.inputOpenaiKey.value = this.#settings.openaiApiKey ?? "";
    }
    if (e.inputElevenLabsKey) {
      e.inputElevenLabsKey.value = this.#settings.elevenLabsApiKey ?? "";
    }
    if (e.keysStatusText) {
      e.keysStatusText.textContent = statusMessage;
    }
  }

  #applyApiKeys() {
    const geminiApiKey = (this.#settings.geminiApiKey ?? "").trim();
    const openaiApiKey = (this.#settings.openaiApiKey ?? "").trim();
    const provider = geminiApiKey ? "gemini" : openaiApiKey ? "openai" : "gemini";
    this.#ollama?.setRuntimeConfig?.({
      provider,
      geminiApiKey,
      openaiApiKey,
    });
    this.#voice?.setApiConfig?.({
      elevenLabsKey: (this.#settings.elevenLabsApiKey ?? "").trim(),
    });
  }

  #loadTrialState() {
    try {
      const raw = window.localStorage.getItem(TRIAL_KEY);
      this.#trialState = raw ? JSON.parse(raw) : null;
    } catch {
      this.#trialState = null;
    }
  }

  #saveTrialState() {
    try {
      if (!this.#trialState) {
        window.localStorage.removeItem(TRIAL_KEY);
        return;
      }
      window.localStorage.setItem(TRIAL_KEY, JSON.stringify(this.#trialState));
    } catch {
      /* ignore */
    }
  }

  #hasUserGeminiKey() {
    return Boolean((this.#settings.geminiApiKey ?? "").trim());
  }

  #hasUserOpenAiKey() {
    return Boolean((this.#settings.openaiApiKey ?? "").trim());
  }

  #hasUserTextKey() {
    return this.#hasUserGeminiKey() || this.#hasUserOpenAiKey();
  }

  #hasUserElevenLabsKey() {
    return Boolean((this.#settings.elevenLabsApiKey ?? "").trim());
  }

  #usesSharedTextTrial() {
    return !this.#hasUserTextKey();
  }

  #usesSharedVoiceTrial() {
    return !this.#hasUserElevenLabsKey();
  }

  #shouldUseTrialMode() {
    if (DISABLE_TRIAL) return false;
    return this.#usesSharedTextTrial() || this.#usesSharedVoiceTrial();
  }

  #getTrialState() {
    if (!this.#trialState || typeof this.#trialState !== "object") {
      this.#trialState = {
        startedAt: null,
        expiresAt: null,
        budgetRemaining: TRIAL_BUDGET_TOTAL,
        exhausted: false,
        caseGenerations: 0,
        callTurns: 0,
        analysisRuns: 0,
      };
    }
    return this.#trialState;
  }

  #ensureTrialSessionStarted() {
    const trial = this.#getTrialState();
    if (!trial.startedAt) {
      const now = Date.now();
      trial.startedAt = now;
      trial.expiresAt = now + TRIAL_DURATION_MS;
      this.#saveTrialState();
    }
    return trial;
  }

  #isTrialExpired() {
    if (DISABLE_TRIAL) return false;
    const trial = this.#getTrialState();
    return Boolean(
      trial.exhausted ||
        (trial.expiresAt && Date.now() >= Number(trial.expiresAt)) ||
        Number(trial.budgetRemaining ?? 0) <= 0,
    );
  }

  #consumeTrialBudget(amount, kind = "usage") {
    const trial = this.#ensureTrialSessionStarted();
    if (this.#isTrialExpired()) return false;

    trial.budgetRemaining = Math.max(
      0,
      Number(trial.budgetRemaining ?? TRIAL_BUDGET_TOTAL) - amount,
    );
    if (kind === "case") trial.caseGenerations = (trial.caseGenerations ?? 0) + 1;
    if (kind === "call") trial.callTurns = (trial.callTurns ?? 0) + 1;
    if (kind === "analysis") trial.analysisRuns = (trial.analysisRuns ?? 0) + 1;

    if (trial.budgetRemaining <= 0) {
      trial.exhausted = true;
    }

    this.#saveTrialState();
    return !trial.exhausted;
  }

  #endTrialSession(message) {
    const trial = this.#getTrialState();
    trial.exhausted = true;
    trial.budgetRemaining = 0;
    this.#saveTrialState();
    this.#clearSavedCase();
    this.#activeCall = null;
    this.#pendingCallTarget = null;
    this.#dialInProgress = false;
    this.#setPhoneState("disabled");
    this.#showNotification(message);
    this.#setState("menu");
  }

  #humanizeModelError(error, fallback) {
    const raw = String(error?.message ?? error ?? "");
    if (this.#shouldUseTrialMode() && this.#isTrialExpired()) {
      return "Trial ended. Add your own Gemini or OpenAI key, plus ElevenLabs, in Keys.";
    }
    if (/prepayment credits are depleted/i.test(raw)) {
      return "The shared trial has been exhausted for now. Add your own Gemini or OpenAI key in Keys, or try again later.";
    }
    if (
      /429|high demand|resource_exhausted|quota|rate limit|retry/i.test(raw)
    ) {
      return "Free trial is busy right now. Repeat the attempt in a few seconds. While you wait, inspect passports or evidence.";
    }
    return fallback;
  }

  #updateSettings(patch) {
    this.#settings = {
      ...this.#settings,
      ...patch,
    };
    this.#applySettings();
    this.#renderSettingsUI();
    this.#saveSettings();
  }

  #openOptions() {
    this.#renderSettingsUI();
    this.#els.overlayOptions?.classList.add("open");
  }

  #closeOptions() {
    this.#els.overlayOptions?.classList.remove("open");
  }

  #openDifficulty() {
    this.#renderSettingsUI();
    this.#els.overlayDifficulty?.classList.add("open");
  }

  #closeDifficulty() {
    this.#els.overlayDifficulty?.classList.remove("open");
  }

  #openKeys() {
    this.#renderKeysUI();
    this.#els.overlayKeys?.classList.add("open");
  }

  #closeKeys() {
    this.#els.overlayKeys?.classList.remove("open");
  }

  #saveKeysFromInputs() {
    const geminiApiKey = this.#els.inputGeminiKey?.value?.trim() ?? "";
    const openaiApiKey = this.#els.inputOpenaiKey?.value?.trim() ?? "";
    const elevenLabsApiKey =
      this.#els.inputElevenLabsKey?.value?.trim() ?? "";

    this.#settings = {
      ...this.#settings,
      geminiApiKey,
      openaiApiKey,
      elevenLabsApiKey,
    };
    this.#applyApiKeys();
    this.#saveSettings();
    const activeTextProvider = geminiApiKey
      ? "Gemini active"
      : openaiApiKey
        ? "OpenAI active"
        : "Shared text trial active";
    this.#renderKeysUI(activeTextProvider);
  }

  #clearStoredKeys() {
    this.#settings = {
      ...this.#settings,
      geminiApiKey: "",
      openaiApiKey: "",
      elevenLabsApiKey: "",
    };
    this.#applyApiKeys();
    this.#saveSettings();
    this.#renderKeysUI("Keys cleared");
  }

  #openConfirmOverlay(message, onAccept) {
    this.#confirmAction = onAccept ?? null;
    if (this.#els.confirmSubtitle) {
      this.#els.confirmSubtitle.textContent = message;
    }
    this.#els.overlayConfirm?.classList.add("open");
  }

  #closeConfirmOverlay() {
    this.#confirmAction = null;
    this.#els.overlayConfirm?.classList.remove("open");
  }

  // ───────────────────────────────────────────────────────────────────────────
  // STRESS BAR
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Update the per-call stress bar (0–100).
   * The wrapper element is kept invisible (opacity:0) in CSS but the fill
   * still advances so it can be faded in if desired later.
   * @param {number} value
   */
  #setStressFill(value) {
    const fill = this.#els.stressFill;
    if (fill) fill.style.width = `${Math.max(0, Math.min(100, value))}%`;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // NOTIFICATION TOAST
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Display a transient notification toast using the #notification-toast DOM element.
   * Uses CSS class transitions for smooth show/hide. Auto-dismisses after 3.5 s.
   * @param {string} message
   */
  #showNotification(message) {
    const e = this.#els;

    // Fallback: if the DOM toast isn't cached yet, use a simple console log
    if (!e.notificationToast || !e.notificationText) {
      console.info("[Notification]", message);
      return;
    }

    e.notificationText.textContent = message;
    e.notificationToast.classList.add("show");

    if (this.#toastTimeout) {
      clearTimeout(this.#toastTimeout);
      this.#toastTimeout = null;
    }

    this.#toastTimeout = setTimeout(() => {
      e.notificationToast.classList.remove("show");
      this.#toastTimeout = null;
    }, 3500);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // CLOCK
  // ───────────────────────────────────────────────────────────────────────────

  /** Update the computer terminal clock every 30 s. */
  #startClock() {
    const tick = () => {
      const clockEl = this.#els.compClock;
      if (!clockEl) return;
      const now = new Date();
      const date = now.toLocaleDateString("en-US", {
        day: "2-digit",
        month: "short",
        year: "numeric",
      });
      const time = now.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      });
      clockEl.textContent = `${date} | ${time}`;
    };
    tick();
    this.#clockInterval = setInterval(tick, 30_000);
  }

  #bindPersistenceEvents() {
    window.addEventListener("beforeunload", () => this.#persistProgress());
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible") this.#persistProgress();
    });
  }

  #startAutosave() {
    if (this.#autosaveInterval) clearInterval(this.#autosaveInterval);
    this.#autosaveInterval = setInterval(
      () => this.#persistProgress(),
      AUTOSAVE_INTERVAL_MS,
    );
  }

  #readSavedCase() {
    try {
      const raw = window.localStorage.getItem(SAVE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed?.snapshot?.caseData) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  #clearSavedCase() {
    try {
      window.localStorage.removeItem(SAVE_KEY);
    } catch {
      /* ignore */
    }
    this.#lastSaveMeta = null;
    this.#refreshSaveMenu();
  }

  #refreshSaveMenu() {
    const payload = this.#readSavedCase();
    this.#lastSaveMeta = payload;

    if (!this.#els.btnMenuContinue || !this.#els.menuSaveNote) return;

    if (!payload?.snapshot?.caseData) {
      this.#els.btnMenuContinue.style.display = "none";
      this.#els.menuSaveNote.textContent = "";
      return;
    }

    const caseNumber =
      payload.snapshot.caseData.caseNumber ??
      payload.snapshot.caseData.guiltyId ??
      "Saved Case";
    const savedAt = new Date(payload.savedAt);
    const label = Number.isNaN(savedAt.getTime())
      ? "Saved case available"
      : `Saved ${savedAt.toLocaleDateString()} ${savedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;

    this.#els.btnMenuContinue.style.display = "";
    this.#els.menuSaveNote.textContent = `${label} — CASE #${caseNumber}`;
  }

  #getActivePanelName() {
    const panel = document.querySelector(".content-panel.active");
    if (!panel?.id) return "overview";
    return panel.id.replace(/^panel-/, "");
  }

  #buildSavePayload() {
    if (!this.#caseState || !["investigating", "win", "lose"].includes(this.#state)) {
      return null;
    }

    const assessmentState = Object.fromEntries(
      Array.from(this.#assessmentState.entries()).map(([id, items]) => [
        id,
        Array.from(items),
      ]),
    );

    return {
      version: 2,
      savedAt: new Date().toISOString(),
      snapshot: {
        gameState: this.#state,
        caseData: this.#caseState.toJSON(),
        suspicionLevels: this.#suspicionManager?.getAll() ?? {},
        contacts: this.#contactManager?.getAll() ?? [],
        evidenceItems: this.#evidenceManager?.getAll() ?? [],
        assessmentState,
        bonusPoints: this.#bonusPoints,
        resolvedOddities: Array.from(this.#resolvedOddities),
        activeDossierSuspectId: this.#activeDossierSuspectId,
        activePanel: this.#getActivePanelName(),
        dossierTab: this.#activeDossierTab,
        computerOpen:
          this.#els.computerSidebar?.classList.contains("open") ?? false,
      },
    };
  }

  #persistProgress() {
    const payload = this.#buildSavePayload();
    if (!payload) return;

    try {
      window.localStorage.setItem(SAVE_KEY, JSON.stringify(payload));
      this.#lastSaveMeta = payload;
    } catch {
      /* ignore */
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // UTILITY
  // ───────────────────────────────────────────────────────────────────────────

  /** Set the text of the loading status element during case generation. */
  #setLoadingStatus(text) {
    const el = this.#els.loadingStatusText;
    if (el) el.textContent = text;
  }

  /** Set the recording/status text in the bottom bar. */
  #setRecStatus(text) {
    const el = this.#els.recStatusText;
    if (el) el.textContent = text;
  }

  /**
   * Simple promisified setTimeout.
   * @param {number} ms
   * @returns {Promise<void>}
   */
  #delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  #formatEta(ms) {
    const safe = Math.max(0, Number(ms) || 0);
    const totalSeconds = Math.ceil(safe / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes <= 0) return `${seconds}s`;
    return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  }

  #maybeAwardOddityBonus(suspect, playerText, responseText) {
    if (!suspect || this.#resolvedOddities.has(suspect.id)) return;

    const asked = String(playerText ?? "").toLowerCase();
    const replied = String(responseText ?? "").toLowerCase();
    const discrepancy = String(suspect.passportDiscrepancy ?? "").toLowerCase();
    const oddity = String(suspect.personalIrregularity ?? "").toLowerCase();
    const aboutPassport =
      /(passport|photo|document|id|address|fake|expired|expiry|number|phone record|called|паспорт|фото|документ|поддел|просроч|адрес|номер|звонил)/i.test(
        asked,
      ) &&
      (suspect.passportFake || discrepancy || oddity.includes("passport"));
    const aboutSideIssue =
      /(why|what is that|what happened|fraud|forg|alibi|called|record|explain|почему|что это|что за|мошенн|алиби|объясни|запись)/i.test(
        asked,
      ) && oddity;
    const soundedLikeAdmission =
      /(just|only|fine|look|all right|alright|wasn't murder|not murder|nothing to do with the murder|i lied|i changed|i borrowed)/i.test(
        replied,
      );

    if (!(soundedLikeAdmission && (aboutPassport || aboutSideIssue))) return;

    this.#resolvedOddities.add(suspect.id);
    this.#bonusPoints += 5;
    if (suspect.role === "innocent" && suspect.passportFake) {
      suspect.contactClosed = true;
      this.#buildContactsList();
      this.#showNotification(
        "+5 bonus — side fraud exposed, contact closed from the murder case",
      );
    } else {
      this.#showNotification("+5 bonus — secondary irregularity exposed");
    }
    this.#populateTopBar();
    this.#persistProgress();
  }

  /**
   * Escape a string for safe insertion into innerHTML.
   * @param {string|any} str
   * @returns {string}
   */
  #escapeHtml(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // ───────────────────────────────────────────────────────────────────────────
  // PUBLIC GETTERS
  // ───────────────────────────────────────────────────────────────────────────

  /** @returns {string} Current state name */
  get state() {
    return this.#state;
  }

  /** @returns {CaseState|null} */
  get caseData() {
    return this.#caseState;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // DEBUG HELPERS  (exposed via window.game)
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Force a suspect's suspicion to an exact value.
   * Usage: game.debugSetSuspicion('S1', 80)
   * @param {string} id
   * @param {number} val  0–100
   */
  debugSetSuspicion(id, val) {
    if (!this.#suspicionManager) {
      console.warn("[debug] No active case");
      return;
    }
    const current = this.#suspicionManager.get(id);
    this.#updateSuspicion(id, val - current);
    console.info(`[debug] Suspicion for ${id} set to ${val}`);
  }

  /**
   * Jump to any game state.
   * Usage: game.debugState('win')
   * @param {string} state
   */
  debugState(state) {
    this.#setState(state);
  }
}
