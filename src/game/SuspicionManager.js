/**
 * SuspicionManager.js
 * -------------------
 * Tracks per-suspect suspicion (0–100).
 * Game can be ended when any suspect reaches >= 50.
 */
export class SuspicionManager {
  #levels = new Map();

  /** Minimum suspicion to enable arrest */
  static ARREST_THRESHOLD = 50;

  /** High-confidence threshold (visual emphasis) */
  static CONFIDENT_THRESHOLD = 75;

  constructor(suspects) {
    suspects.forEach((s) => this.#levels.set(s.id, 0));
  }

  /**
   * Adjust suspicion for a suspect by delta.
   * @param {string} suspectId
   * @param {number} delta  positive = more suspicious, negative = less
   * @returns {number} New suspicion level (0–100)
   */
  adjust(suspectId, delta) {
    const current = this.#levels.get(suspectId) ?? 0;
    const next = Math.max(0, Math.min(100, current + delta));
    this.#levels.set(suspectId, next);
    return next;
  }

  /**
   * @param {string} suspectId
   * @returns {number} Current suspicion 0–100
   */
  get(suspectId) {
    return this.#levels.get(suspectId) ?? 0;
  }

  /**
   * @returns {Record<string, number>} All suspect suspicion levels
   */
  getAll() {
    return Object.fromEntries(this.#levels);
  }

  /**
   * Reset all levels, optionally re-seeding from a new suspect list.
   * @param {Array} suspects
   */
  reset(suspects) {
    this.#levels.clear();
    suspects.forEach((s) => this.#levels.set(s.id, 0));
  }

  /**
   * Returns the first suspect at or above ARREST_THRESHOLD, or null.
   * @returns {{ id: string, level: number }|null}
   */
  getArrestCandidate() {
    for (const [id, level] of this.#levels) {
      if (level >= SuspicionManager.ARREST_THRESHOLD) return { id, level };
    }
    return null;
  }

  /**
   * Returns ALL suspects at or above ARREST_THRESHOLD.
   * @returns {Array<{ id: string, level: number }>}
   */
  getAllArrestCandidates() {
    const result = [];
    for (const [id, level] of this.#levels) {
      if (level >= SuspicionManager.ARREST_THRESHOLD)
        result.push({ id, level });
    }
    // Sort descending by level
    return result.sort((a, b) => b.level - a.level);
  }

  /**
   * True if any suspect has reached the arrest threshold.
   * @returns {boolean}
   */
  canArrest() {
    return this.getArrestCandidate() !== null;
  }

  /**
   * True if the given suspect is at or above the confident threshold.
   * @param {string} suspectId
   * @returns {boolean}
   */
  isConfident(suspectId) {
    return (
      (this.#levels.get(suspectId) ?? 0) >= SuspicionManager.CONFIDENT_THRESHOLD
    );
  }

  /**
   * Returns the suspect with the highest suspicion.
   * @returns {{ id: string, level: number }|null}
   */
  getHighest() {
    let top = null;
    for (const [id, level] of this.#levels) {
      if (!top || level > top.level) top = { id, level };
    }
    return top;
  }
}
