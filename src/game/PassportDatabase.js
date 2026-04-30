/**
 * PassportDatabase.js
 * -------------------
 * Centralized passport lookup system.
 * Aggregates only the official passport records that belong to the case.
 */
export class PassportDatabase {
  #records = []

  constructor(caseState, contactManager = null) {
    this.rebuild(caseState, contactManager)
  }

  rebuild(caseState, contactManager = null) {
    this.#records = caseState.getAllPassportRecords()
  }

  /**
   * Lookup by name (partial) or exact ID number.
   * @param {string} query
   * @returns {object|null}
   */
  lookup(query) {
    if (!query?.trim()) return null
    const q = query.toLowerCase().trim()
    return this.#records.find(r =>
      r.id_number.toLowerCase() === q ||
      r.person.toLowerCase().includes(q) ||
      (r.phone_number ?? '').toLowerCase() === q
    ) ?? null
  }

  lookupAll(query) {
    if (!query?.trim()) return []
    const q = query.toLowerCase().trim()
    const exact = []
    const partial = []

    this.#records.forEach((record) => {
      const byId = record.id_number.toLowerCase() === q
      const byPhone = (record.phone_number ?? '').toLowerCase() === q
      const byName = record.person.toLowerCase().includes(q)
      if (!byId && !byPhone && !byName) return

      if (byId || byPhone || record.person.toLowerCase() === q) {
        exact.push(record)
      } else {
        partial.push(record)
      }
    })

    return [...exact, ...partial]
  }

  getAll() {
    return [...this.#records]
  }
}
