/**
 * ContactManager.js
 * -----------------
 * Manages the dynamic contact list (witnesses + people discovered during calls).
 * Contacts are added when suspects/witnesses mention someone by name.
 */
import { personNameRoughlyMatches } from "./nameMatching.js";

export class ContactManager {
  #contacts = new Map()  // id → contact object

  constructor(initialContacts = []) {
    initialContacts.forEach(contact => this.#contacts.set(contact.id, contact))
  }

  /**
   * Add a newly discovered contact (mentioned during a call).
   * @returns {boolean} true if newly added (not already in list)
   */
  discover(contact) {
    if (this.#contacts.has(contact.id)) return false
    this.#contacts.set(contact.id, contact)
    return true
  }

  getAll() {
    return Array.from(this.#contacts.values())
  }

  getContact(id) {
    return this.#contacts.get(id) ?? null
  }

  hasContact(id) {
    return this.#contacts.has(id)
  }

  /** Find contact by full name (case-insensitive) */
  findByName(name) {
    for (const c of this.#contacts.values()) {
      if (personNameRoughlyMatches(name, c)) return c
    }
    return null
  }

  /**
   * Create a procedurally-generated contact from a name mention.
   * Used when a witness mentions someone not in the original witness list.
   */
  static createFromMention(firstName, surname, profile = {}) {
    const id = `DC_${firstName}_${surname}`.replace(/\s+/g, '_')
    const randomId = () => {
      const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
      const nums = '0123456789'
      return Array.from({length: 2}, () => letters[Math.floor(Math.random() * letters.length)]).join('') +
             Array.from({length: 6}, () => nums[Math.floor(Math.random() * nums.length)]).join('')
    }
    const randomPhone = () =>
      `(555) ${String(Math.floor(Math.random() * 900 + 100))}-${String(Math.floor(Math.random() * 9000 + 1000))}`

    return {
      id,
      name: firstName,
      surname: surname,
      relationship: 'mentioned contact',
      personality: 'guarded, uncertain',
      voiceArchetype: profile.voiceArchetype ?? 'gruff male',
      testimony: 'No information — contacted based on mention.',
      mentionsSuspectId: null,
      passportId: randomId(),
      passportAddress: 'Riverton',
      passportNationality: 'US',
      passportIssue: '01/2020',
      passportExpiry: '01/2030',
      dateOfBirth: '01/01/1990',
      phoneNumber: randomPhone(),
      passportFake: false,
      passportDiscrepancy: null,
      gender: profile.gender ?? 'male',
      voiceId: profile.voiceId ?? 'yoZ06aMxZJJ28mfd3POQ',
      passportPhotoFile: profile.passportPhotoFile ?? null,
      directoryType: 'contact',
      isDiscovered: true  // flag to show it was added dynamically
    }
  }
}
