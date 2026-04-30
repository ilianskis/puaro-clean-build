/**
 * EvidenceManager.js
 * ------------------
 * Tracks evidence items collected by the detective.
 * Items come from:
 *   - Baseline suspect document files
 *   - Victim scene evidence
 *   - Suspect belongings sent to the lab
 *
 * Each item has a status: 'discovered' | 'analyzing' | 'analyzed'
 */
export class EvidenceManager {
  #items = new Map()  // id → evidence item
  #listeners = []

  constructor() {}

  /**
   * Add a newly discovered evidence item.
   * @returns {boolean} true if new
   */
  discover(item) {
    if (this.#items.has(item.id)) return false
    this.#items.set(item.id, {
      ...item,
      status: item.status ?? 'discovered',
      result: item.result ?? null,
      analysisDueAt: item.analysisDueAt ?? null,
      discoveredAt: item.discoveredAt ?? Date.now()
    })
    this.#emit('discovered', item)
    return true
  }

  getAll() {
    return Array.from(this.#items.values())
  }

  get(id) {
    return this.#items.get(id) ?? null
  }

  /** Mark item as being analyzed */
  startAnalysis(id, analysisDueAt = null) {
    const item = this.#items.get(id)
    if (!item) return
    item.status = 'analyzing'
    item.analysisDueAt = analysisDueAt
    this.#emit('updated', item)
  }

  /** Store analysis result */
  completeAnalysis(id, result, belongsToId = null) {
    const item = this.#items.get(id)
    if (!item) return
    item.status = 'analyzed'
    item.result = result
    item.belongsToId = belongsToId
    item.analysisDueAt = null
    this.#emit('analyzed', item)
  }

  hasItem(id) {
    return this.#items.has(id)
  }

  on(event, fn) {
    this.#listeners.push({ event, fn })
  }

  #emit(event, data) {
    this.#listeners.filter(l => l.event === event).forEach(l => l.fn(data))
  }

  reset() {
    this.#items.clear()
  }
}
