/**
 * CaseState.js
 * ------------
 * Immutable case data container with query methods.
 * Populated from OllamaController.generateCase() output.
 */
import { personNameRoughlyMatches } from "./nameMatching.js";

export class CaseState {
  #data;

  constructor(rawData) {
    this.#data = rawData;
  }

  toJSON() {
    return structuredClone(this.#data);
  }

  get phoneCalls() {
    return this.#data.phoneCalls ?? [];
  }
  get victim() {
    return this.#data.victim;
  }
  get suspects() {
    return this.#data.suspects;
  }
  get witnesses() {
    return this.#data.witnesses;
  }
  get caseTitle() {
    return this.#data.caseTitle;
  }
  get storyBrief() {
    return this.#data.storyBrief;
  }
  get caseDateLabel() {
    return this.#data.caseDateLabel ?? null;
  }
  get caseDateISO() {
    return this.#data.caseDateISO ?? null;
  }
  get guiltyId() {
    return this.#data.guiltyId;
  }
  get guiltyIds() {
    return Array.from(
      new Set([
        this.#data.guiltyId,
        ...(Array.isArray(this.#data.accompliceIds)
          ? this.#data.accompliceIds
          : []),
      ].filter(Boolean)),
    );
  }
  get accompliceIds() {
    return this.#data.accompliceIds;
  }
  get victimEvidence() {
    return this.#data.victimEvidence;
  }
  get caseNumber() {
    return (
      this.#data.caseNumber ??
      String(Math.floor(100000 + Math.random() * 900000))
    );
  }

  /** @returns {object|null} */
  getSuspect(id) {
    return this.#data.suspects.find((s) => s.id === id) ?? null;
  }

  /** Case-insensitive full name match */
  getSuspectByName(fullName) {
    return (
      this.#data.suspects.find((suspect) =>
        personNameRoughlyMatches(fullName, suspect),
      ) ?? null
    );
  }

  /** @returns {object|null} */
  getWitness(id) {
    return this.#data.witnesses.find((w) => w.id === id) ?? null;
  }

  /** All passport records (suspects + witnesses) */
  getAllPassportRecords() {
    const suspects = this.#data.suspects.map((s) => ({
      person: `${s.name} ${s.surname}`,
      id_number: s.passportId,
      address: s.passportAddress,
      nationality: s.passportNationality,
      issue_date: s.passportIssue,
      expiry_date: s.passportExpiry,
      phone_number: s.phoneNumber ?? null,
      is_fake: false,
      discrepancy: null,
      date_of_birth: s.dateOfBirth ?? null,
      passportPhotoFile: s.passportPhotoFile ?? null,
      passportPhotoWrong: false,
      personId: s.id,
      type: "suspect",
    }));

    const witnesses = this.#data.witnesses.map((w) => ({
      person: `${w.name} ${w.surname}`,
      id_number: w.passportId,
      address: w.passportAddress,
      nationality: w.passportNationality,
      issue_date: w.passportIssue,
      expiry_date: w.passportExpiry,
      phone_number: w.phoneNumber ?? null,
      is_fake: false,
      discrepancy: null,
      date_of_birth: w.dateOfBirth ?? null,
      passportPhotoFile: w.passportPhotoFile ?? null,
      passportPhotoWrong: false,
      personId: w.id,
      type: "witness",
    }));

    return [...suspects, ...witnesses];
  }

  /**
   * Lookup passport by name (partial match) or exact ID number.
   * @param {string} query
   * @param {Array}  extraContacts  Dynamically discovered contacts
   * @returns {object|null}
   */
  lookupPassport(query, extraContacts = []) {
    if (!query?.trim()) return null;
    const q = query.toLowerCase().trim();

    const all = [
      ...this.getAllPassportRecords(),
      ...extraContacts.map((c) => ({
        person: `${c.name} ${c.surname}`,
        id_number: c.passportId,
        address: c.passportAddress,
        nationality: c.passportNationality,
        issue_date: c.passportIssue,
        expiry_date: c.passportExpiry,
        phone_number: c.phoneNumber ?? null,
        is_fake: c.passportFake ?? false,
        discrepancy: c.passportDiscrepancy ?? null,
        date_of_birth: c.dateOfBirth ?? null,
        passportPhotoFile: c.passportPhotoFile ?? null,
        passportPhotoWrong: false,
        personId: c.id,
        type: "contact",
      })),
    ];

    return (
      all.find(
        (r) =>
          r.id_number.toLowerCase() === q ||
          r.person.toLowerCase().includes(q) ||
          (r.phone_number ?? "").toLowerCase() === q,
      ) ?? null
    );
  }

  /** Check if the selected suspects exactly match all involved suspects */
  checkArrest(suspectIds) {
    const picked = Array.isArray(suspectIds) ? suspectIds : [suspectIds];
    const selected = new Set(picked.filter(Boolean));
    const actual = new Set(this.guiltyIds);

    if (selected.size !== actual.size) return false;
    for (const id of actual) {
      if (!selected.has(id)) return false;
    }
    return true;
  }

  /**
   * Legacy helper for examine mode source data.
   * Also includes the victim with their associated evidence items.
   * @returns {Array}
   */
  getExaminablePersons() {
    const suspects = this.#data.suspects.map((s) => ({
      id: s.id,
      name: `${s.name} ${s.surname}`,
      type: "suspect",
      clothingClue: s.clothingClue,
      hairColor: s.hairColor,
      bloodType: s.bloodType,
    }));

    return [
      {
        id: "VICTIM",
        name: `${this.#data.victim.name} (VICTIM)`,
        type: "victim",
        evidence: this.#data.victimEvidence,
      },
      ...suspects,
    ];
  }

  /**
   * Resolve a contact (suspect or witness) by id from either pool.
   * @param {string} id
   * @returns {object|null}
   */
  getPersonById(id) {
    return this.getSuspect(id) ?? this.getWitness(id) ?? null;
  }

  /**
   * Return a lightweight summary safe to display in the detective's case file UI.
   * @returns {object}
   */
  getCaseSummary() {
    return {
      caseTitle: this.#data.caseTitle,
      storyBrief: this.#data.storyBrief,
      caseNumber: this.caseNumber,
      caseDateLabel: this.#data.caseDateLabel ?? null,
      victim: {
        name: this.#data.victim.name,
        age: this.#data.victim.age,
        occupation: this.#data.victim.occupation,
        foundAt: this.#data.victim.foundAt,
        timeOfDeath: this.#data.victim.timeOfDeath,
        causeOfDeath: this.#data.victim.causeOfDeath,
        weapon: this.#data.victim.weapon,
      },
      suspectCount: this.#data.suspects.length,
      witnessCount: this.#data.witnesses.length,
      evidenceCount: this.#data.victimEvidence.length,
    };
  }

  /**
   * Returns suspects whose role is 'accomplice'.
   * @returns {Array}
   */
  getAccomplices() {
    return this.#data.suspects.filter((s) => s.role === "accomplice");
  }

  /**
   * Returns all suspects involved in the murder.
   * @returns {Array}
   */
  getGuiltySuspects() {
    const ids = new Set(this.guiltyIds);
    return this.#data.suspects.filter((s) => ids.has(s.id));
  }

  /**
   * Returns the guilty suspect object (not just the id).
   * @returns {object|null}
   */
  getGuiltySuspect() {
    return this.getSuspect(this.#data.guiltyId);
  }

  /**
   * Returns true if this suspect is involved (guilty or accomplice).
   * @param {string} suspectId
   * @returns {boolean}
   */
  isInvolved(suspectId) {
    return this.guiltyIds.includes(suspectId);
  }
}
