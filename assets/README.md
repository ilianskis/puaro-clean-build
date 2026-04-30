# Soundective — Assets Directory

This directory contains all static media assets required by the game.
Place the actual files here before running the project.

---

## Images

### `phone-active.png`
The phone button displayed when the **player can speak**.
- Style: old-fashioned telephone handset, lit up / glowing
- Recommended size: 240×240px (displayed at 120×120px via CSS)
- Format: PNG with transparency

### `phone-muted.png`
The phone button displayed when the **player cannot speak** (suspect is talking or mic is disabled).
- Style: same handset but with an X overlay or dimmed/greyed out appearance
- Recommended size: 240×240px (displayed at 120×120px via CSS)
- Format: PNG with transparency

### `paper-dossier.png`
Torn/aged paper background used as the dossier panel backdrop.
- Style: yellowed, stained, torn-edge paper — noir detective file aesthetic
- Recommended size: 900×1100px or larger
- Format: PNG (can have transparent torn edges)
- Used as CSS `background-image` on the dossier panel

---

## Music — `music/`

All tracks should loop seamlessly. Recommended format: MP3 (128–192kbps).

### `music/calm.mp3`
- Played when **stress level is 0–30%**
- Style: slow, brooding jazz / ambient noir piano
- Tempo: slow, minimal percussion
- Duration: 2–4 minutes (looped)

### `music/tense.mp3`
- Played when **stress level is 30–70%**
- Style: building tension — muted brass, walking bass, snare brushes
- Tempo: mid-tempo, more rhythmic urgency
- Duration: 2–4 minutes (looped)

### `music/critical.mp3`
- Played when **stress level is 70–100%**
- Style: high tension — dissonant strings, heavy percussion, stabs
- Tempo: faster, erratic, oppressive
- Duration: 2–4 minutes (looped)

---

## SFX — `sfx/`

### `sfx/static.mp3`
- Short radio static / white noise burst looped under the **suspect's voice**
- Style: AM radio crackle, telephone line noise
- Duration: 2–5 seconds (looped seamlessly)
- Volume: kept low (mixed under TTS voice)

---

## Notes for Developers

- All audio paths are referenced in `src/game/AudioController.js`
- All image paths are referenced directly in `index.html` and `src/game/UIController.js`
- Do **not** commit large audio files to git — add them to `.gitignore` if needed
- The stress bar (`#stress-bar`) is hidden from the player (`opacity: 0`) but drives music transitions via JS
- ElevenLabs TTS audio is streamed/played dynamically and is not stored in this directory