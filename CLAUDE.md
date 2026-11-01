# Language study app: guide for coding agents

A personal language-learning website. You save sentences you meet (from YouTube videos, books and so on), then study them. You can listen to them on repeat, see the nouns coloured by gender, and answer GPT-made practice questions at your CEFR level.

## The owner and how to work with them

- The owner is a **beginner programmer**. Explain changes in plain words, keep the code simple, and give step-by-step instructions when they need to do something themselves.
- They test on a Mac browser **and an iPhone**. Everything must work on touch screens (`canHover` in app.js switches hover menus to tap).
- **Every change gets a checkbox line appended** to [notes/plan20261024.md](notes/plan20261024.md) (`- [x] …`). Keep doing this.
- The code comments are written for a beginner: friendly, short, and explaining *why*. Match that style and comment density.
- After finishing, tell them which files changed so they can upload those.
- Design preferences they've stated: no background pictures (colours only), calm and eye-friendly, readable contrast, and **identical layout in every theme** (themes may only change colours and fonts, never sizes or positions).

## Hard constraints

- **Static site, no server, no build step, no npm.** Plain HTML, CSS and JS. Hosted on **GitHub Pages**, where the owner uploads files by hand through the GitHub website. The folder is not a git repo.
- **Never read, print or copy `key.txt`.** It holds the owner's OpenAI API key. The key must never appear in any website file. Users paste it into ⚙️ Settings → OpenAI, which stores it in `localStorage` only. `.gitignore` lists `key.txt`.
- Opening `index.html` as `file://` mostly works, but YouTube embeds fail there (error 153). Hosted on GitHub Pages it's fine.
- Fonts come from Google Fonts and must cover **latin-ext** (Polish ą ę ł ś ż, Turkish ğ ı ş, German ß, French accents).

## Files

| File | What it is |
|---|---|
| [index.html](index.html) | All markup. Three main tabs (`#study-tab`, `#sentences-tab`, `#settings-tab`) shown and hidden with the `hidden` attribute. A small inline script in `<head>` applies the saved theme before paint, using a whitelist `["riviera","cabana","coffee","matcha"]`. **Update that whitelist when adding or removing a theme.** |
| [app.js](app.js) | All app logic (~2300 lines, plain global functions, no modules). Sections are marked with `// ===== Name =====` headers. The start-up calls are at the very end. |
| [style.css](style.css) | Theme variables, then layout. |
| [topics.js](topics.js) | `TOPIC_EXAMPLES` (English example phrases per topic) and `TOPIC_KEYWORDS` (EN/PL/TR keywords), plus `detectTopics(text, language)` as the keyword fallback. |
| [ai-topics.js](ai-topics.js) | Topic detection by meaning with transformers.js (`@xenova/transformers@2.17.2` from jsDelivr, model `Xenova/paraphrase-multilingual-MiniLM-L12-v2`, ~118 MB, cached by the browser). Exposes `findTopics`, `scoreTopics`, `aiStatus`, and an `onAiStatusChange` hook. |
| [notes/plan20261024.md](notes/plan20261024.md) | Running plan/changelog with checkboxes. Its early sections describe a YouTube/subtitle plan that was later dropped. |

Scripts load in this order: `topics.js` → `ai-topics.js` → `app.js`. They share globals.

## Features (UI tour)

- **Header:** a language dropdown (🌐, top left) sets `myLanguage`, and the centred title shows that language.
- **Study tab**
  - *Select entry:* the sentences in the current language, grouped by audio file (`showEntries`: a list of groups, newest audio first, plus "📝 Without audio"; `openEntryGroup` = opened group, saved in `view`). Inside a group, `showGroupEntries` lists entries numbered in audio order with their part ("#2 · 1:05,500 – 1:20,250", via `timeLabel`), two-line previews, and the selected one in full. With no audio at all, entries are listed directly. Clicking one sets `selectedEntry`.
  - *Practice* subtab:
    - CEFR level picker (A1–C2, coloured per theme);
    - Practice Target (noun/verb/adjective/mix; `targetWords` turns it into prompt wording);
    - **✨ Spin Up a Challenge**, which asks GPT for questions about the selected entry.
  - *Immerse* subtab:
    - **Pure Text**: the sentence, big.
    - **Grammar Lens**: GPT finds the nouns, which are coloured by gender (`NOUN_GENDERS`; English and Turkish have none).
    - **Word Focus**: GPT lists every word of the entry once (word, base, type, form, meaning) as cards (`findWords` → `drawWordList`, `showWordFocus`). Saved on the sentence as `words: { text, list }`, like `grammar: { text, nouns }`, so each entry is asked about only once. No filtering of words seen in other entries (owner's choice). Tapping a card marks the word as known (`toggleKnown`); known words are stored per language in localStorage `knownWords` = `{ Polish: ["dzisiaj", …] }` by lower-case dictionary form, shown only as small "✓ Known" chips under that entry's cards (tap to undo; no overview page, by request), and sent to `askForQuestions` (newest 300) so questions practise other words and glossaries skip them.
    - **Audio controls**: play, plus repeat 5 / 10 / infinite. The audio plays the attached MP3 part if there is one, otherwise browser text-to-speech.
- **My sentences tab**
  - The add form: a textarea (one sentence per line), Language, Source, and an audio picker (choose or upload an MP3 and mark the start/end times).
  - The list: a filter by language, and rows with three columns:
    - left: flag and topic tags;
    - middle: the text and a source link;
    - right: the date and the Edit/Delete buttons, where Delete asks "Delete it?" with Yes/No.
    - Phones (≤600px): the same row is stacked with CSS grid (flag+topics | date, then the text full width, then the buttons); `.sentence-actions` becomes `display: contents`. These phone rules must stay **after** the normal `.sentence-*` rules in style.css.
    - Long sentences are clamped to 3 lines with a "Show all ▾" toggle (`expandedSentences`, `showTextToggles`, re-measured on tab switch and resize). Audio file names are clamped to 2 lines.
  - Pasting is tidied (`tidyText(text, oneLine)` via `tidyWhenPasted`): no empty lines, trimmed lines, single spaces. The Add box keeps one sentence per line; the Edit box joins lines with a space. Add and Save tidy the text too.
  - The Source boxes (Add and Edit) suggest earlier non-link sources in the form's language (`addSourceSuggestions`, a `<datalist>` refilled on focus and language change).
  - Topics are detected automatically and are not edited in the UI.
- **Settings tab:** Theme cards, My languages (checkboxes), Topics (status, re-check all, try a sentence), OpenAI key and model, and **Backup** (⬇️ Download / ⬆️ Restore: one JSON file with the `BACKUP_KEYS` localStorage values plus every MP3 as a data URL; the OpenAI key is deliberately left out; restore shows a "Restore this backup?" box with Replace with backup / Cancel, stores the new audio before removing old, then reloads). **When adding a new saved key, add it to `BACKUP_KEYS`.**
- **🎧 My audios tab** (`#audios-tab`): the uploaded audio files, laid out like sentence rows (flag | name, source, sentence count | date, Edit/Delete), with the same language filter (`makeLanguageFilter` is shared by both lists). Both lists show newest first via `newestFirst(items, all)`, which only changes the on-screen order; rows still use their index in the saved array. Source is required when editing.

## Data (all in the browser, per device)

Use the helpers `loadSaved(key, fallback)`, `loadSavedText(key)` and `save(key, value, quiet)`. `save` without `quiet` shows the "Saved ✓" toast, and passing `null` removes the key.

| localStorage key | Contents |
|---|---|
| `sentences` | `[{ text, language, topics[], ownTopics[], source, date: "YYYY-MM-DD", audioId?, audioStart?, audioEnd? }]`. Old formats are migrated on load (see the comment above `let sentences`). Dates are shown European-style via `europeanDate`. |
| `audioLibrary` | `[{ id, name, language, source, date }]` (date = day uploaded; older files get the date of their first sentence). The MP3 data itself lives in **IndexedDB** db `language-app`, store `audio`, keyed by id (`storeAudioFile` / `loadAudioFile` / `removeAudioFile`). One file can serve many sentences. |
| `myLanguage`, `myLanguages` | The current language, and the languages ticked in Settings. |
| `myLevel`, `practiceTarget`, `audioLoops`, `theme` | Settings that are remembered. |
| `knownWords` | Words marked known in Word Focus, per language (see Word Focus). |
| `openaiKey`, `openaiModel` | The user's key, and the model (default `DEFAULT_MODEL = "gpt-4.1"`). |
| `view` | The open tab, subtab, Immerse view, both language filters and the selected entry (`saveView` / `restoreView`). |

Languages: `LANGUAGE_FLAGS` = English, French, German, Polish, Turkish. Adding a language means updating `LANGUAGE_FLAGS`, `SPEECH_LANGUAGES` and `NOUN_GENDERS`, and the keyword lists in topics.js if wanted.

## OpenAI usage

- `askOpenai(request)` calls Chat Completions **directly from the browser** with the user's key, and returns `message.content`.
- Use non-reasoning models, and always request **strict `json_schema`** output, then validate or filter the result in JS.
- OpenAI error responses have no CORS headers. A bad key therefore usually shows up as a network failure ("Couldn't get an answer…"), not as a 401.
- **Practice questions** (`askForQuestions(entry, level, target)` → `showQuestions`):
  - Types are listed in `QUESTION_TYPES`: reading, form, order, odd, and gender.
  - `gender` is only used at `GENDER_QUESTION_LEVELS` (A1–B2), and only for languages with genders.
  - At `WORD_HELP_LEVELS` (A1–B1), each question carries a `glossary` of new words, shown as "💡 New words".
  - Each question renders as a `.quiz-card` with a number circle. The card gets `answered-right` / `answered-wrong` once answered. `markAnswer` keeps the score.
  - Word order questions use `makeOrderQuestion`. The other types use `makeChoiceQuestion`.
- **Grammar Lens:** `findNounGenders(sentence)` → `findNounPlaces` → `drawColouredSentence`. Results are requested once per sentence (`grammarBeingFound`).

## Audio and speech

- **New uploads get the link:** a web link typed in Source becomes the new file's source (`fileBox` change in `makeAudioPicker`; a link auto-filled from another file is cleared instead), and `giveAudioTheLink` copies the sentence's link to a source-less file when the sentence is added or edited.
- **MP3 parts:** `playRecording(entry)` plays from `audioStart` to `audioEnd`, checked by a 10 ms interval. start and end are typed in three number-only boxes, minutes : seconds , milliseconds (`makeTimeBoxes(title, seconds, readOnly)` → `{ element, get(), set(), clear() }`). Above them, read-only **Now** (live player position) and **Length** boxes in the same format; below, **Use the whole audio** (Start 0, End = file length; a hint beside it explains it and then shows the times it set) and **▶ Play this part** plays Start→End in the picker's player; the end-time check runs every 10 ms.
- **Text-to-speech:** `speakOnce` uses `speechSynthesis`. `voiceFor` ranks the voices with `voiceQuality` (Siri, then Premium/Enhanced, and novelty voices are excluded). Setting `utterance.voice` sits in a try/catch so playback falls back to the device voice.
- Loops: `playedOnce` repeats the playback, and `stopAudio` stops it. Changing the entry stops the audio (`stopAudioIfEntryChanged`).

## Themes

- `THEMES` in app.js: `riviera` "Velvet Dusk" (default, dark editorial: sunset gradient `--bg`, blurred light shafts in `body::before`, film grain in `body::after`, smoked glass with champagne-gold #E3B866 hairlines, cream #F3E7D0 text; Playfair Display / Noto Serif Display (reading, `.immerse-sentence`, `.quiz-passage`) / Jost, with Frank Ruhl Libre + Heebo for Hebrew and Hahmlet, Nanum Myeongjo + IBM Plex Sans KR for Korean; piña colada cream accent (#FFF3D6 / #F5DE9E / #E9C46A) on main buttons (`button:not([class])`), chosen chips, the active tab line and the selected entry's gradient border; uppercase spaced `.tab`/`.subtab`/form labels at 13px for tabs; italic h3; gold outlines via inset box-shadow; muted quiz colours), `cabana` "Orchid Cabana Club", `coffee` "Cold Brew Coffee" (dark), and `matcha` "Kyoto Iced Matcha".
- **Typography roles:** every text element belongs to one of seven roles (display, heading, subheading, reading, nav, ui, meta) listed in the "Typography roles" section of style.css (with `.type-…` classes). Fonts come only from the role variables (`--font-display`, `--font-heading`, `--font-subheading`, `--font-reading`, `--font-ui`, plus `--…-weight`, `--nav-spacing`, `--ui-spacing`, and `--ui-size` = 15px for all buttons/chips/levels/the language list — don't give a button its own font-size). Don't add `font-family` to components; add the selector to a role instead. Reading text has line-height 1.7 in every theme. A reset makes `button, input, select, textarea, option` inherit the font.
- All fonts load from **one** Google Fonts `<link>` in index.html; add new families to it.
- No decorative emojis in the UI (functional symbols like ✓ ✗ ▾ ▶ ■ and the language flags stay).
- Each theme is a `[data-theme="…"]` block in style.css, setting CSS variables. The defaults live in `:root, [data-theme]`.
- The variables are: `--bg`, `--text`, `--muted`, `--title`, `--card`, `--accent`, `--accent-text`, `--nav-*`, `--chip`, `--soft`, `--line`, `--input-bg`, `--input-border`, `--selected-bg`, `--level-a/b/c` (+`-text`), `--font`, `--heading-font`, `--radius`, …
- Reading text (`.immerse-sentence`, `.sentence-text`, `.entry-text`, quiz passage/question, word cards) has `unicode-bidi: plaintext` so Hebrew runs right to left.
- Layout must not depend on the theme. That's why line heights, button widths (`.level` 52px; `#language-button` is auto-width, max 220px, at the owner's request) and transparent borders are fixed. `#main-nav` is a fixed grid (4 columns, 2 at ≤760px) for the same reason. Tabs and buttons have no emojis (owner's request).
- To add a theme: add a CSS block, an entry in `THEMES`, and the id in the `<head>` whitelist. Check the contrast of text, buttons, level colours and the quiz right/wrong colours.
- Themes the owner has rejected or deleted: cherry, sunset/mango, leopard, mint, diamond, dusk, honey (Golden Hour Lounge).

## Testing (what has worked)

- **Syntax check:** `osascript -l JavaScript app.js`. The error "Can't find variable: window" means the file parsed fine.
- **Real behaviour:** headless Chrome with `--allow-file-access-from-files`, using a small test HTML in the scratchpad that loads `index.html` in an iframe.
  - In the test, mock `win.askOpenai` and `speechSynthesis`, log results with `console.log`, then grep the output.
  - Take screenshots with `--screenshot` and crop them with `sips`.
  - Use real-time waits, because virtual time doesn't wait for the network.
- Check every theme (especially the dark `coffee`) and a narrow phone width.
- After editing app.js, run `head -1 app.js` to make sure nothing was inserted above the first line (this happened once). Prefer the Edit tool over `perl`/`sed` for code containing `||`.
- Real GPT output can only be tested by the owner with their key. Never use `key.txt` to test it.

## Deploying

The owner uploads `index.html`, `style.css`, `app.js`, `topics.js` and `ai-topics.js` to their GitHub Pages repo through the website. Never upload `key.txt`. This file and `notes/` don't need uploading. After uploading, a hard refresh (Cmd+Shift+R, or pull to reload on iPhone) avoids cached old JS.
