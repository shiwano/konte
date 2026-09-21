# Japanese notation

How a Japanese line must be written down so the model reads it aloud correctly — notation only, never the wording.

## Standard orthography, always

- **Write every word the way it is normally written** — 常用漢字 with ordinary okurigana (`交換`, `大昔`).
- **Never split a compound across kanji and kana** (交ぜ書き: `交かん`, `大むかし`) — the segmenter loses the word, and the damage is not local: one broken word drags the accent and phrasing of the whole line with it.
- **Kana-fying for a young audience is a screen decision** — the take is heard, never read. Keep `script[n].text` standard and put the easy notation on screen (`telop`, `<Subtitle>`).
- **現代仮名遣い, never the pre-war forms** — `ゐ`/`ゑ`/`せう` → `い`/`え`/`しょう`, the iteration marks `ゝ`/`〳〵` → the kana spelled out, large 拗促音 `ちよつと` → `ちょっと`.
- **Lengthen a vowel with `ー`** — `おーい`, `ちょうだいよー`. The literary `おオい`, `ちょうだいよオ` is read as a second vowel.
- **Use full-width punctuation** — `、。？！……` drive the pauses and intonation.

## A word whose reading won't settle

- **A low-frequency word has no stable reading** — an archaic or technical term (`和同開珎`), an irregular name (`日下部`, `十六夜`); hiragana leaves the segmenter nothing to anchor on either.
- **Pin the reading in katakana** — `ワドウカイチン`, the whole word, no spaces.
- **Respell at the take: `respell(script.<who>[n], "…")`** — it returns the spelling and files it as standing for that line, so the voiced check takes either form and `direction.ts` keeps the notation the subtitle and every review surface show. Two takes of one line may spell it differently; swapping a speech model never touches the direction.
- **Suspect the same class of word before generating** — counters and dates (`一日` ついたち/いちにち, `三本`, `一人`), words with two live readings (`人気`, `方`), personal and place names, and any numeral next to a unit.

## Verifying

- **You cannot hear the take** — a reading is confirmed only by the human at review. Name every respelled or rare word in the handoff.
- **A misread line is not fixed by a reroll** — the reading follows the notation, so change the string.
- **Editing a line leaves its respelling behind** — reread every `respell()` on a line whose words you change.
