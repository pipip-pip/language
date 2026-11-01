// true on a computer with a mouse, false on a touch screen like an iPhone
// (a touch screen has no cursor, so things that open "on hover" open on tap instead)
const canHover = window.matchMedia("(hover: hover)").matches;

// Small helpers for the browser's own storage, so things are remembered next time.
// (It lives in this browser only: your Mac and your iPhone each keep their own.)
function loadSaved(key, fallback) {
  try {
    const saved = localStorage.getItem(key);
    return saved === null ? fallback : JSON.parse(saved);
  } catch {
    return fallback;
  }
}

// Save something. Entries and settings show a "Saved ✓" message;
// small things like which tab is open are saved quietly (quiet = true).
function save(key, value, quiet) {
  try {
    if (value === null || value === undefined) {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key, JSON.stringify(value));
    }
    if (!quiet) showSaveMessage(true);
  } catch {
    // Saving isn't possible (e.g. private browsing, or storage is full)
    showSaveMessage(false);
  }
}

// ----- Sound files (MP3s) -----
// Sound files are too big for the normal storage, so they go in the browser's bigger
// storage for files (called IndexedDB). Like everything else, they stay on this device only.
let audioDatabase = null;

function openAudioDatabase() {
  if (!audioDatabase) {
    audioDatabase = new Promise(function (resolve, reject) {
      const request = indexedDB.open("language-app", 1);
      request.onupgradeneeded = function () {
        request.result.createObjectStore("audio");
      };
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error); };
    });
  }
  return audioDatabase;
}

// Do one thing with the sound files ("readonly" to read, "readwrite" to change)
async function withAudioStore(mode, action) {
  const database = await openAudioDatabase();
  return new Promise(function (resolve, reject) {
    const store = database.transaction("audio", mode).objectStore("audio");
    const request = action(store);
    request.onsuccess = function () { resolve(request.result); };
    request.onerror = function () { reject(request.error); };
  });
}

function storeAudioFile(id, file) {
  return withAudioStore("readwrite", function (store) { return store.put(file, id); });
}

function loadAudioFile(id) {
  return withAudioStore("readonly", function (store) { return store.get(id); });
}

function removeAudioFile(id) {
  return withAudioStore("readwrite", function (store) { return store.delete(id); })
    .catch(function () { /* Already gone: nothing to do */ });
}

// A new, unique name for a stored sound file
function newAudioId() {
  return "audio-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
}

// The audio library: every sound file uploaded, stored once. Many sentences can use the same
// file, each with its own part (start and end time). Looks like: [{ id: "audio-...", name: "lesson.mp3" }]
let audioLibrary = loadSaved("audioLibrary", []);

function saveAudioLibrary() {
  save("audioLibrary", audioLibrary, true);
}

function audioFileName(id) {
  const item = audioLibrary.find(function (entry) { return entry.id === id; });
  return item ? item.name : "";
}

// Store a new sound file in the library. Returns its id, or null if it couldn't be kept.
async function addToAudioLibrary(file, language, source) {
  const id = newAudioId();
  try {
    await storeAudioFile(id, file);
  } catch {
    showSaveMessage(false); // Couldn't keep the file (e.g. storage full)
    return null;
  }
  // Labelled with its language, where it came from (e.g. a YouTube link) and the day it was added
  audioLibrary.push({ id: id, name: file.name, language: language || "", source: source, date: todayForDateBox() });
  saveAudioLibrary();
  showSaveMessage(true);
  return id;
}

// A time as three number boxes: minutes : seconds , milliseconds  →  [1] : [23] , [250]
// Only numbers can be typed. Returns { element, get(), set(seconds), clear() }:
// get() gives the time in seconds (83.25), or null if all three boxes are empty.
// 65.25 seconds → "1:05,250" (the same m : s , ms as the boxes below, as plain text)
function timeLabel(seconds) {
  const total = Math.round(seconds * 1000);
  return Math.floor(total / 60000) + ":" + String(Math.floor(total / 1000) % 60).padStart(2, "0") +
    "," + String(total % 1000).padStart(3, "0");
}

// With readOnly = true the boxes only show a time (e.g. where the player is now).
function makeTimeBoxes(title, seconds, readOnly) {
  const field = document.createElement("div");
  field.className = "time-field" + (readOnly ? " time-readout" : "");
  const name = document.createElement("span");
  name.textContent = title;
  const row = document.createElement("div");
  row.className = "time-boxes";
  field.append(name, row);

  function numberBox(placeholder, digits, label) {
    const box = document.createElement("input");
    box.type = "text";
    box.inputMode = "numeric"; // The number keypad on iPhone
    box.maxLength = digits;
    box.placeholder = placeholder;
    box.setAttribute("aria-label", title + " " + label);
    box.className = "time-box time-box-" + digits;
    box.readOnly = Boolean(readOnly);
    box.tabIndex = readOnly ? -1 : 0;
    // Anything that isn't a number is removed straight away
    box.addEventListener("input", function () {
      box.value = box.value.replace(/\D/g, "");
    });
    return box;
  }
  function separator(text) {
    const mark = document.createElement("span");
    mark.className = "time-separator";
    mark.textContent = text;
    return mark;
  }

  const minutesBox = numberBox("m", 3, "minutes");
  const secondsBox = numberBox("s", 2, "seconds");
  const millisecondsBox = numberBox("ms", 3, "milliseconds");
  row.append(minutesBox, separator(":"), secondsBox, separator(","), millisecondsBox);

  function set(value) {
    if (value === null || value === undefined) {
      minutesBox.value = secondsBox.value = millisecondsBox.value = "";
      return;
    }
    const total = Math.round(value * 1000); // In milliseconds
    minutesBox.value = String(Math.floor(total / 60000));
    secondsBox.value = String(Math.floor(total / 1000) % 60).padStart(2, "0");
    millisecondsBox.value = String(total % 1000).padStart(3, "0");
  }
  set(seconds);

  return {
    element: field,
    get: function () {
      if (!minutesBox.value && !secondsBox.value && !millisecondsBox.value) return null;
      return Number(minutesBox.value || 0) * 60 + Number(secondsBox.value || 0) +
        Number(millisecondsBox.value || 0) / 1000;
    },
    set: set,
    clear: function () { set(null); },
  };
}

// If a source is a web address (like "https://www.youtube.com/watch?v=..."), return it; otherwise null.
// "www.youtube.com/..." without https:// counts too.
function webAddress(source) {
  const text = (source || "").trim();
  if (!text || /\s/.test(text)) return null;
  const withScheme = /^https?:\/\//i.test(text) ? text : (/^www\./i.test(text) ? "https://" + text : null);
  if (!withScheme) return null;
  try {
    return new URL(withScheme).href;
  } catch {
    return null;
  }
}

// A short name for a link, instead of the address itself:
// YouTube links show "▶ YouTube", others show the site's name, e.g. "🔗 example.com"
function sourceLabel(url) {
  const site = new URL(url).hostname.replace(/^(www|m)\./i, "");
  if (site === "youtube.com" || site === "youtu.be" || site.endsWith(".youtube.com")) {
    return "▶ YouTube";
  }
  return "🔗 " + site;
}

// The audio picker, used in the Add and Edit forms:
//   a list of saved files (or upload a new one), a small player to listen,
//   and Start / End boxes with buttons that copy the player's current time.
// "current" is { audioId, audioStart, audioEnd }. "languageSelect" is the form's Language box:
// only files labelled with that language are listed, and new uploads get that label.
// "sourceBox" is the form's Source box: choosing a saved file puts that file's source (link) in it.
// Returns { element, value(), reset(), refresh() }.
function makeAudioPicker(current, languageSelect, sourceBox) {
  const picker = document.createElement("div");
  picker.className = "audio-picker";

  const label = document.createElement("label");
  label.textContent = "Audio (optional)";
  const choice = document.createElement("select");
  label.append(choice);

  // Hidden: opened when "Upload a new file…" is chosen
  const fileBox = document.createElement("input");
  fileBox.type = "file";
  fileBox.accept = "audio/*,.mp3";
  fileBox.hidden = true;

  // Shown when a file is chosen: the player and the times
  const part = document.createElement("div");
  part.className = "audio-part";

  const player = document.createElement("audio");
  player.controls = true;
  player.preload = "metadata";

  // Start and end: minutes, seconds and milliseconds (end left empty = to the end of the file)
  const startTime = makeTimeBoxes("Start", current.audioStart);
  const endTime = makeTimeBoxes("End", current.audioEnd);

  // The typed times are saved with the sentence when Add or Save is pressed
  const times = document.createElement("div");
  times.className = "audio-times";
  times.append(startTime.element, endTime.element);

  // Where the player is now, and how long the file is, in the same m : s , ms boxes,
  // so a time can be read off exactly and typed into Start or End
  const nowTime = makeTimeBoxes("Now", 0, true);
  const lengthTime = makeTimeBoxes("Length", null, true);
  const clock = document.createElement("div");
  clock.className = "audio-times";
  clock.append(nowTime.element, lengthTime.element);

  function showClock() {
    nowTime.set(player.currentTime || 0);
    lengthTime.set(isFinite(player.duration) ? player.duration : null);
  }
  ["timeupdate", "seeked", "loadedmetadata", "emptied"].forEach(function (event) {
    player.addEventListener(event, showClock);
  });
  // While playing, update many times a second so the milliseconds move smoothly
  player.addEventListener("play", function tick() {
    showClock();
    if (!player.paused) requestAnimationFrame(tick);
  });

  // ▶ Play this part: plays from Start to End, to check the times are right
  let partWatch = null;
  function stopPart() {
    clearInterval(partWatch);
    partWatch = null;
    playPart.textContent = "▶ Play this part";
  }
  const playPart = makeButton("▶ Play this part", "small-button", function () {
    if (partWatch) {
      player.pause();
      stopPart();
      return;
    }
    const start = startTime.get() || 0;
    const end = endTime.get();
    player.currentTime = start;
    player.play().catch(stopPart); // If it can't play, the button goes back
    playPart.textContent = "■ Stop";
    partWatch = setInterval(function () {
      if (player.paused || (end !== null && end > start && player.currentTime >= end)) {
        player.pause();
        stopPart();
      }
    }, 10);
  });

  part.append(player, clock, times, playPart);

  picker.append(label, fileBox, part);

  let selected = current.audioId && audioFileName(current.audioId) ? current.audioId : "";
  let playerUrl = null;
  let filledSource = null; // The source put in the Source box from a saved file (not typed)

  // Load the chosen file into the small player
  async function loadPlayer() {
    if (playerUrl) {
      URL.revokeObjectURL(playerUrl);
      playerUrl = null;
    }
    player.removeAttribute("src");
    if (partWatch) stopPart();
    part.hidden = !selected;
    if (!selected) return;
    try {
      const file = await loadAudioFile(selected);
      if (file) {
        playerUrl = URL.createObjectURL(file);
        player.src = playerUrl;
      }
    } catch {
      // The file can't be read: the times can still be typed
    }
  }

  // Fill the list: No audio, the saved files in the form's language, and Upload a new file…
  // (files with no language label are shown for every language)
  function refresh() {
    const language = languageSelect.value;
    const matching = audioLibrary.filter(function (item) {
      return !item.language || item.language === language;
    });

    // The chosen file is in another language now: clear the choice
    if (selected && !matching.some(function (item) { return item.id === selected; })) {
      selected = "";
      loadPlayer();
    }

    choice.innerHTML = "";
    choice.append(new Option("No audio", ""));
    matching.forEach(function (item) {
      choice.append(new Option("🎵 " + item.name, item.id));
    });
    choice.append(new Option("＋ Upload a new file…", "__new__"));
    choice.value = selected;
  }

  // A different language in the form: show only that language's files
  languageSelect.addEventListener("change", refresh);

  choice.addEventListener("change", function () {
    if (choice.value === "__new__") {
      choice.value = selected; // Stay on the old choice until a file is picked
      fileBox.click();
      return;
    }
    selected = choice.value;
    loadPlayer();

    // A saved file with a source: fill the form's Source box with it
    const item = audioLibrary.find(function (entry) { return entry.id === selected; });
    if (item && item.source) {
      sourceBox.value = item.source;
      filledSource = item.source;
    }
  });

  fileBox.addEventListener("change", async function () {
    const file = fileBox.files[0];
    fileBox.value = "";
    if (!file) return;
    // A link typed in the Source box becomes the new file's source.
    // A link that came from another saved file belongs to that file, so it's cleared instead.
    let source = "";
    if (sourceBox.value.trim() === filledSource) {
      sourceBox.value = "";
    } else if (webAddress(sourceBox.value)) {
      source = sourceBox.value.trim();
    }
    filledSource = null;
    // Saved straight away, labelled with the form's language.
    // Without a link, the source is added when the sentence is added, or in 🎧 My audios → Edit.
    const id = await addToAudioLibrary(file, languageSelect.value, source);
    if (id) {
      selected = id;
      refreshAudioPickers(); // The new file appears in every picker's list
      showAudioLibrary(); // And in My audios
      loadPlayer();
    }
  });

  refresh();
  loadPlayer();

  return {
    element: picker,
    value: function () {
      const start = startTime.get();
      let end = endTime.get();
      if (end !== null && start !== null && end <= start) end = null; // An end before the start is ignored
      return { audioId: selected, audioStart: selected ? start : null, audioEnd: selected ? end : null };
    },
    // Back to "No audio" with empty times (after a sentence is added)
    reset: function () {
      selected = "";
      filledSource = null;
      startTime.clear();
      endTime.clear();
      choice.value = "";
      loadPlayer();
    },
    refresh: refresh,
  };
}

// The pickers on the page (the Add form's, and the Edit form's while one is open),
// so both can show a newly uploaded file
let addAudioPicker = null;
let editAudioPicker = null;

function refreshAudioPickers() {
  if (addAudioPicker) addAudioPicker.refresh();
  if (editAudioPicker) editAudioPicker.refresh();
}

// A sentence saved with a link in Source and an audio file that has no source yet
// (e.g. a new upload, with the link typed afterwards): the file gets that link too
function giveAudioTheLink(sentence) {
  const item = audioLibrary.find(function (entry) { return entry.id === sentence.audioId; });
  if (item && !item.source && webAddress(sentence.source)) {
    item.source = sentence.source;
    saveAudioLibrary();
    refreshAudioPickers();
  }
}

// Put a picker's choice onto a sentence (or take the audio off it)
function applyAudio(sentence, audio) {
  if (audio.audioId) {
    sentence.audioId = audio.audioId;
    sentence.audioStart = audio.audioStart;
    sentence.audioEnd = audio.audioEnd;
  } else {
    delete sentence.audioId;
    delete sentence.audioStart;
    delete sentence.audioEnd;
  }
  delete sentence.audioName; // Older versions kept the name on the sentence; it's in the library now
}


// The little message in the bottom corner: "Saved ✓", or a warning if saving failed
const saveMessage = document.getElementById("save-message");
let saveMessageTimer = null;

function showSaveMessage(worked) {
  saveMessage.textContent = worked
    ? "Saved ✓"
    : "⚠️ Couldn't save. Private browsing, or storage full? Changes will be lost when you leave.";
  saveMessage.classList.toggle("failed", !worked);
  saveMessage.hidden = false;

  // Hide it again after a moment (the warning stays longer)
  clearTimeout(saveMessageTimer);
  saveMessageTimer = setTimeout(function () {
    saveMessage.hidden = true;
  }, worked ? 1500 : 8000);
}


// ===== Navigation bar and tabs =====
const tabButtons = document.querySelectorAll(".tab");

// Show one tab (e.g. "settings-tab") and hide the others
function showTab(tabId) {
  tabButtons.forEach(function (button) {
    const isThisOne = button.dataset.tab === tabId;
    button.classList.toggle("active", isThisOne);
    document.getElementById(button.dataset.tab).hidden = !isThisOne;
  });
  showTextToggles(); // Long sentences can only be measured once their tab is on screen
}

tabButtons.forEach(function (button) {
  button.addEventListener("click", function () {
    showTab(button.dataset.tab);
    saveView();
  });
});


// ----- Smaller tabs inside Study: Practice and Immerse -----
const subtabButtons = document.querySelectorAll(".subtab");

// Show one of them (e.g. "immerse-panel") and hide the other
function showSubtab(panelId) {
  subtabButtons.forEach(function (button) {
    const isThisOne = button.dataset.subtab === panelId;
    button.classList.toggle("active", isThisOne);
    document.getElementById(button.dataset.subtab).hidden = !isThisOne;
  });
}

subtabButtons.forEach(function (button) {
  button.addEventListener("click", function () {
    showSubtab(button.dataset.subtab);
    saveView();
  });
});


// ===== Languages =====
// Every language you can choose from in Settings, with its flag
const LANGUAGE_FLAGS = {
  English: "🇬🇧", French: "🇫🇷", German: "🇩🇪", Polish: "🇵🇱", Turkish: "🇹🇷"
};
const ALL_LANGUAGES = Object.keys(LANGUAGE_FLAGS);

// How a language is shown on the page: its name, then its flag, e.g. "Spanish 🇪🇸"
// (Only the name is saved, so changing a flag here changes it everywhere.)
function languageLabel(language) {
  const flag = LANGUAGE_FLAGS[language];
  return flag ? language + " " + flag : language;
}

// Older versions saved the language and level as plain text, not JSON. This reads both.
function loadSavedText(key) {
  const saved = loadSaved(key, null);
  if (saved !== null) return saved;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

// The language picked in the 🌐 button
let myLanguage = loadSavedText("myLanguage");

// The languages ticked in Settings. The first time, start with the one picked in 🌐 (if any).
let myLanguages = loadSaved("myLanguages", myLanguage ? [myLanguage] : []);

function saveMyLanguage() {
  save("myLanguage", myLanguage);
}


// --- Settings: one checkbox per language ---
const languageOptions = document.getElementById("language-options");

ALL_LANGUAGES.forEach(function (language) {
  const label = document.createElement("label");
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = myLanguages.includes(language);

  checkbox.addEventListener("change", function () {
    if (checkbox.checked) {
      myLanguages.push(language);
      myLanguages.sort(); // Keep them in alphabetical order
    } else {
      myLanguages = myLanguages.filter(function (other) { return other !== language; });
      // If it was the language picked in 🌐, unpick it
      if (myLanguage === language) {
        myLanguage = null;
        saveMyLanguage();
      }
    }
    save("myLanguages", myLanguages);
    updateLanguageLists();
  });

  label.append(checkbox, " " + languageLabel(language));
  languageOptions.append(label);
});


// --- The 🌐 language button ---
const languageDropdown = document.getElementById("language-dropdown");
const languageButton = document.getElementById("language-button");
const languageName = document.getElementById("language-name");
const languageMenu = document.getElementById("language-menu");

const pageTitle = document.getElementById("page-title");

// Fill the 🌐 list with the languages ticked in Settings
function fillLanguageMenu() {
  languageMenu.innerHTML = "";
  languageName.textContent = myLanguage ? languageLabel(myLanguage) : "Choose language";

  // The big title (and the browser tab's name) show the chosen language
  pageTitle.textContent = myLanguage ? "✧ " + languageLabel(myLanguage) + " ✧" : "✧💎✧";
  document.title = myLanguage ? languageLabel(myLanguage) : "Video Study";

  if (myLanguages.length === 0) {
    // Nothing ticked yet: offer a shortcut to Settings
    const item = document.createElement("li");
    item.textContent = "Add languages in ⚙️ Settings";
    item.className = "hint-item";
    item.addEventListener("click", function () {
      languageDropdown.classList.remove("open");
      showTab("settings-tab");
    });
    languageMenu.append(item);
    return;
  }

  myLanguages.forEach(function (language) {
    const item = document.createElement("li");
    item.textContent = languageLabel(language);
    item.classList.toggle("selected", language === myLanguage);
    item.addEventListener("click", function () {
      myLanguage = language;
      saveMyLanguage();
      languageDropdown.classList.remove("open");
      fillLanguageMenu();
      sentenceLanguage.value = language; // New sentences use this language too
      refreshAudioPickers(); // So the Audio list shows this language's files
      showEntries(); // Study only shows entries in this language
    });
    languageMenu.append(item);
  });
}

// On a touch screen, tapping the button opens and closes the list
languageButton.addEventListener("click", function () {
  if (!canHover) {
    languageDropdown.classList.toggle("open");
  }
});

// Tapping anywhere else closes the list
document.addEventListener("click", function (event) {
  if (!languageDropdown.contains(event.target)) {
    languageDropdown.classList.remove("open");
  }
});


// --- Language boxes for sentences ---
// Fill a language box with your languages. "extra" is a language to include even
// if it's no longer ticked in Settings (so editing an old sentence doesn't lose it).
function fillLanguageSelect(select, selected, extra) {
  const languages = myLanguages.slice();
  if (extra && !languages.includes(extra)) {
    languages.push(extra);
  }

  select.innerHTML = "";
  select.append(new Option("—", "")); // "—" means no language
  languages.forEach(function (language) {
    select.append(new Option(languageLabel(language), language));
  });
  select.value = selected || "";
  if (select.selectedIndex === -1) {
    select.value = ""; // The language isn't in the list any more
  }
}

// Refresh everything that lists your languages (after a change in Settings)
function updateLanguageLists() {
  fillLanguageMenu();
  fillLanguageSelect(sentenceLanguage, sentenceLanguage.value || myLanguage);
  refreshAudioPickers();
  showSentences();
}


// ===== Language level (CEFR) =====
// Pick your level (A1 = beginner ... C2 = near-native).
const levelButtons = document.querySelectorAll(".level");
const LEVEL_KEY = "myLevel";

let myLevel = loadSavedText(LEVEL_KEY);

// Highlight the selected level
function showLevel() {
  levelButtons.forEach(function (button) {
    button.classList.toggle("selected", button.dataset.level === myLevel);
  });
}

levelButtons.forEach(function (button) {
  button.addEventListener("click", function () {
    // Clicking the selected level again removes it
    myLevel = myLevel === button.dataset.level ? null : button.dataset.level;
    save(LEVEL_KEY, myLevel);
    showLevel();
  });
});


// ===== Practice: target (noun, verb, adjective or a mix of all three) =====
// One kind of word to practise at a time. The choice is remembered.
const targetButtons = document.querySelectorAll("#practice-target .filter-button");
let practiceTarget = loadSaved("practiceTarget", "noun");

// Highlight the chosen target
function showPracticeTarget() {
  targetButtons.forEach(function (button) {
    button.classList.toggle("selected", button.dataset.target === practiceTarget);
  });
}

targetButtons.forEach(function (button) {
  button.addEventListener("click", function () {
    practiceTarget = button.dataset.target;
    save("practiceTarget", practiceTarget);
    showPracticeTarget();
  });
});

showPracticeTarget();


// ===== Sentences =====
const sentenceForm = document.getElementById("sentence-form");
const sentenceInput = document.getElementById("sentence-input");
const sentenceList = document.getElementById("sentence-list");
const noSentences = document.getElementById("no-sentences");
const sentenceLanguage = document.getElementById("sentence-language");
const topicSuggestions = document.getElementById("topic-suggestions");
const sourceInput = document.getElementById("source-input");

// Today's date, saved with each new sentence: "2026-10-27"
function todayForDateBox() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return now.getFullYear() + "-" + month + "-" + day;
}

// Turn "2026-10-27" into European style: "27.10.2026"
function europeanDate(date) {
  const [year, month, day] = date.split("-");
  return day + "." + month + "." + year;
}

// Old two-word topic names, and the one-word names that replaced them
const OLD_TOPIC_NAMES = {
  "Food & Drink": "Food", "Travel & Transport": "Travel", "Family & Friends": "Family",
  "Health & Body": "Health", "Shopping & Money": "Shopping", "Weather & Nature": "Nature",
  "Time & Dates": "Time", "Hobbies & Sport": "Hobbies", "School & Learning": "School",
};

// Each sentence is saved like this:
//   { text: "Merhaba", language: "Turkish", topics: ["Greetings"], ownTopics: [],
//     source: "YouTube", date: "2026-10-27" }
// "topics" are all its topics. "ownTopics" are the ones you typed yourself,
// which are kept whenever the automatic topics are found again.
// Older sentences may be plain text, have no language, or have a single "topic".
// Turn them into the new shape.
let sentences = loadSaved("sentences", []).map(function (sentence) {
  if (typeof sentence === "string") {
    sentence = { text: sentence, source: "", date: "" };
  }
  if (!sentence.topics) {
    sentence.topics = sentence.topic ? [sentence.topic] : [];
  }
  delete sentence.topic;
  // Topics used to have longer names like "Food & Drink". Rename them to one word.
  sentence.topics = mergeTopics([], sentence.topics.map(function (topic) {
    return OLD_TOPIC_NAMES[topic] || topic;
  }));
  // Before "ownTopics" existed: your own topics are the ones the keywords wouldn't find
  if (!sentence.ownTopics) {
    const keywordTopics = detectTopics(sentence.text, sentence.language || "");
    sentence.ownTopics = sentence.topics.filter(function (topic) {
      return !keywordTopics.includes(topic);
    });
  }
  return { language: "", ...sentence };
});

// Find a sentence's topics by meaning (see ai-topics.js), keep your own topics,
// then save and show the result. This takes a moment, so it happens in the background.
let topicsBeingFound = 0; // How many sentences are waiting for their topics

async function updateTopics(sentence) {
  topicsBeingFound++;
  showTopicStatus();
  const found = await findTopics(sentence.text, sentence.language);
  sentence.topics = mergeTopics(sentence.ownTopics, found);
  topicsBeingFound--;
  saveSentences();
  showSentences();
  showTopicStatus();
}

// Every topic used so far, in alphabetical order
function allTopics() {
  const topics = [];
  sentences.forEach(function (sentence) {
    sentence.topics.forEach(function (topic) {
      if (!topics.includes(topic)) {
        topics.push(topic);
      }
    });
  });
  return topics.sort();
}

// Turn typed topics like "food, travel" into a list: ["Food", "Travel"].
// Topics are one word each, so every word typed becomes its own topic,
// starting with a capital letter (so "food" and "Food" are the same topic).
function parseTopics(typed) {
  const topics = [];
  typed.split(/[\s,]+/).forEach(function (word) {
    if (word) {
      const topic = word.charAt(0).toLocaleUpperCase() + word.slice(1);
      if (!topics.includes(topic)) {
        topics.push(topic);
      }
    }
  });
  return topics;
}

// Join two topic lists without repeating any topic
function mergeTopics(first, second) {
  return first.concat(second.filter(function (topic) {
    return !first.includes(topic);
  }));
}

// Suggest the topics used so far when typing in a Topic box
function fillTopicSuggestions() {
  topicSuggestions.innerHTML = "";
  allTopics().forEach(function (topic) {
    topicSuggestions.append(new Option(topic));
  });
}

function saveSentences() {
  save("sentences", sentences);
}

// Sentences from before the audio library each had their own sound file: add those files to the library
let libraryChanged = false;
sentences.forEach(function (sentence) {
  if (sentence.audioId && !audioFileName(sentence.audioId)) {
    audioLibrary.push({ id: sentence.audioId, name: sentence.audioName || "Sound file" });
    libraryChanged = true;
  }
});

// Files uploaded before language labels existed: label each with the language of a sentence that uses it
audioLibrary.forEach(function (item) {
  if (item.language === undefined) {
    const user = sentences.find(function (sentence) { return sentence.audioId === item.id; });
    item.language = user ? user.language : "";
    libraryChanged = true;
  }
});
if (libraryChanged) saveAudioLibrary();

// The Audio picker in the Add form
addAudioPicker = makeAudioPicker({}, sentenceLanguage, sourceInput);
document.getElementById("add-audio").append(addAudioPicker.element);

// The number of the sentence being edited right now (null = none)
let editingIndex = null;

// The number of the sentence waiting for "Delete it?" to be answered (null = none)
let confirmingIndex = null;

// Small helper for making a button
function makeButton(label, className, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = label;
  button.addEventListener("click", onClick);
  return button;
}

// A sentence as it normally looks, in three columns:
//   left: flag and topics | middle: the sentence | right: date, then Edit and Delete
// Sentences opened with "Show all" (kept open when the list is redrawn)
const expandedSentences = new Set();

// "Show all" only appears under sentences that are really cut off. That can only be measured
// while the list is on screen, so this runs again when the tab opens or the screen size changes.
function showTextToggles() {
  document.querySelectorAll("#sentence-list .sentence-text").forEach(function (text) {
    const toggle = text.nextElementSibling;
    toggle.hidden = !text.classList.contains("expanded") && text.scrollHeight <= text.clientHeight + 1;
  });
}
window.addEventListener("resize", showTextToggles);

function makeSentenceRow(sentence, index) {
  const row = document.createElement("div");
  row.className = "sentence-row";

  // Left column: the flag of the sentence's language (empty if it has none), with its topics underneath
  const side = document.createElement("div");
  side.className = "sentence-side";

  const flag = document.createElement("span");
  flag.className = "sentence-flag";
  flag.textContent = LANGUAGE_FLAGS[sentence.language] || "";
  flag.title = sentence.language || "No language";
  side.append(flag);

  if (sentence.topics.length > 0) {
    const topics = document.createElement("div");
    topics.className = "sentence-topics";
    sentence.topics.forEach(function (topic) {
      const tag = document.createElement("span");
      tag.className = "topic-tag";
      tag.textContent = topic;
      topics.append(tag);
    });
    side.append(topics);
  }

  // Middle column: the sentence, and under it a link to the source if the source is a web address
  const main = document.createElement("div");
  main.className = "sentence-main";

  // Long sentences show three lines; "Show all" opens the rest (see showTextToggles)
  const text = document.createElement("span");
  text.className = "sentence-text";
  text.classList.toggle("expanded", expandedSentences.has(sentence));
  text.textContent = sentence.text;
  const toggle = makeButton(expandedSentences.has(sentence) ? "Show less ▴" : "Show all ▾", "text-toggle", function () {
    if (expandedSentences.has(sentence)) {
      expandedSentences.delete(sentence);
    } else {
      expandedSentences.add(sentence);
    }
    const open = expandedSentences.has(sentence);
    text.classList.toggle("expanded", open);
    toggle.textContent = open ? "Show less ▴" : "Show all ▾";
  });
  toggle.hidden = true;
  main.append(text, toggle);

  // The sentence's own source if it's a link, otherwise the source of its audio file
  const audioItem = audioLibrary.find(function (item) { return item.id === sentence.audioId; });
  const sourceUrl = webAddress(sentence.source) || webAddress(audioItem ? audioItem.source : "");
  if (sourceUrl) {
    const link = document.createElement("a");
    link.className = "source-link";
    link.href = sourceUrl;
    link.target = "_blank"; // Opens in a new tab, so the app stays open
    link.rel = "noopener";
    link.textContent = sourceLabel(sourceUrl); // A short name, not the address itself
    main.append(link);
  }

  // Right column: the date it was added, with the buttons underneath
  const actions = document.createElement("div");
  actions.className = "sentence-actions";

  const date = document.createElement("span");
  date.className = "sentence-date";
  date.textContent = sentence.date ? europeanDate(sentence.date) : "";

  const buttons = document.createElement("div");
  buttons.className = "sentence-buttons";
  actions.append(date, buttons);

  // Asking "Delete it?": show Yes and No instead of Edit and Delete
  if (index === confirmingIndex) {
    const question = document.createElement("span");
    question.className = "delete-question";
    question.textContent = "Delete it?";

    const yesButton = makeButton("Yes", "small-button delete-yes", function () {
      // Its sound file stays in the library (other sentences may use it); delete files in ⚙️ Settings
      sentences.splice(index, 1); // Remove this one sentence
      if (editingIndex !== null && editingIndex > index) editingIndex--;
      confirmingIndex = null;
      saveSentences();
      showSentences();
    });

    const noButton = makeButton("No", "small-button", function () {
      confirmingIndex = null;
      showSentences();
    });

    buttons.append(question, yesButton, noButton);
    row.append(side, main, actions);
    return row;
  }

  const editButton = makeButton("Edit", "small-button", function () {
    editingIndex = index;
    confirmingIndex = null;
    showSentences();
  });

  // Delete only asks first; the sentence is removed after "Yes"
  const deleteButton = makeButton("Delete", "small-button", function () {
    confirmingIndex = index;
    showSentences();
  });

  buttons.append(editButton, deleteButton);
  row.append(side, main, actions);
  return row;
}

// A sentence while it's being edited: boxes for text, language, topic, source and date, plus Save and Cancel
function makeEditRow(sentence, index) {
  const form = document.createElement("form");
  form.className = "edit-form";

  const textBox = document.createElement("textarea");
  textBox.rows = 2;
  textBox.value = sentence.text;

  const languageBox = document.createElement("select");
  fillLanguageSelect(languageBox, sentence.language, sentence.language);

  const sourceBox = document.createElement("input");
  sourceBox.type = "text";
  sourceBox.placeholder = "Source";
  sourceBox.value = sentence.source;

  // No topic or date boxes: they're kept as they are (topics are found again on Save)
  const details = document.createElement("div");
  details.className = "sentence-details";
  details.append(languageBox, sourceBox);

  // Audio: the same picker as in the Add form, showing this sentence's file and part
  editAudioPicker = makeAudioPicker(sentence, languageBox, sourceBox);

  const saveButton = document.createElement("button");
  saveButton.type = "submit";
  saveButton.textContent = "Save";

  const cancelButton = makeButton("Cancel", "small-button", function () {
    editingIndex = null;
    editAudioPicker = null;
    showSentences();
  });

  const buttons = document.createElement("div");
  buttons.className = "edit-buttons";
  buttons.append(saveButton, cancelButton);

  form.append(textBox, details, editAudioPicker.element, buttons);

  form.addEventListener("submit", async function (event) {
    event.preventDefault();
    const newText = textBox.value.trim();
    if (newText === "") {
      return; // Don't allow an empty sentence (use ✕ to delete instead)
    }
    const edited = {
      text: newText,
      language: languageBox.value,
      // Topics added earlier are kept, plus a quick keyword guess until the AI model has found the best ones
      ownTopics: sentence.ownTopics,
      topics: mergeTopics(sentence.ownTopics, detectTopics(newText, languageBox.value)),
      source: sourceBox.value.trim(),
      date: sentence.date, // The date it was first added stays the same
    };

    // Audio: the file and part chosen in the picker (the file itself stays in the library)
    applyAudio(edited, editAudioPicker.value());
    giveAudioTheLink(edited);
    editAudioPicker = null;
    // If this was the selected entry in Study, keep it selected
    if (selectedEntry === sentences[index]) {
      selectedEntry = edited;
    }
    sentences[index] = edited;
    editingIndex = null;
    saveSentences();
    saveView(); // In case this was the selected entry, remember its new text
    showSentences();
    updateTopics(edited); // Find the best topics for the edited text
  });

  return form;
}

// ----- Filter by language -----
const sentenceFilter = document.getElementById("sentence-filter");

// Which sentences to show: "all", a language like "Spanish", or "" for sentences with no language
let filterLanguage = "all";

// Make language filter buttons in "box": All, your languages (plus any others the items use),
// and "No language" if some items don't have one. Used by My sentences and My audios.
// Returns the chosen filter: "current", or "all" if that language is gone
// (e.g. its last sentence was deleted). Clicking a button calls choose(language).
function makeLanguageFilter(box, items, current, choose) {
  box.innerHTML = "";

  const languages = myLanguages.slice();
  items.forEach(function (item) {
    if (item.language && !languages.includes(item.language)) {
      languages.push(item.language);
    }
  });
  languages.sort();

  const choices = [{ value: "all", label: "All" }];
  languages.forEach(function (language) {
    choices.push({ value: language, label: languageLabel(language) });
  });
  if (items.some(function (item) { return !item.language; })) {
    choices.push({ value: "", label: "No language" });
  }

  if (!choices.some(function (choice) { return choice.value === current; })) {
    current = "all";
  }

  choices.forEach(function (choice) {
    const button = makeButton(choice.label, "filter-button", function () {
      choose(choice.value);
    });
    button.classList.toggle("selected", choice.value === current);
    box.append(button);
  });
  return current;
}

function showFilter() {
  filterLanguage = makeLanguageFilter(sentenceFilter, sentences, filterLanguage, function (language) {
    filterLanguage = language;
    editingIndex = null;
    showSentences();
    saveView();
  });
}

// Sort a list for showing, newest first by date ("2026-10-27"). Items added on the same day:
// the one added later (further down in the saved list "all") goes on top. Items without a date go last.
// Only the order on screen changes; the saved list stays as it is.
function newestFirst(items, all) {
  return items.slice().sort(function (a, b) {
    if ((a.date || "") !== (b.date || "")) return (b.date || "").localeCompare(a.date || "");
    return all.indexOf(b) - all.indexOf(a);
  });
}

// Rebuild the list on the page from the "sentences" array
function showSentences() {
  showFilter();
  sentenceList.innerHTML = "";

  // Only the sentences that match the language filter
  const shown = sentences.filter(function (sentence) {
    return filterLanguage === "all" || sentence.language === filterLanguage;
  });

  if (sentences.length === 0) {
    noSentences.textContent = "No sentences yet.";
  } else if (shown.length === 0) {
    noSentences.textContent = "No sentences in this language.";
  }
  noSentences.hidden = shown.length > 0;

  // One list, each sentence shown once, newest at the top
  const list = document.createElement("ol");
  newestFirst(shown, sentences).forEach(function (sentence) {
    const index = sentences.indexOf(sentence); // Its place in the full list
    const item = document.createElement("li");
    if (index === editingIndex) {
      item.append(makeEditRow(sentence, index));
    } else {
      item.append(makeSentenceRow(sentence, index));
    }
    list.append(item);
  });
  sentenceList.append(list);
  showTextToggles();

  fillTopicSuggestions();
  showEntries(); // Keep the Study list up to date too
  showAudioLibrary(); // And how many sentences use each audio file
}

// What happens when you click Add
sentenceForm.addEventListener("submit", async function (event) {
  event.preventDefault();

  // Each non-empty line becomes its own sentence
  const newSentences = sentenceInput.value
    .split("\n")
    .map(function (line) { return line.trim(); })
    .filter(function (line) { return line !== ""; });

  if (newSentences.length === 0) {
    return;
  }

  // Every line gets the same language and source, and today's date
  const language = sentenceLanguage.value;
  const source = sourceInput.value.trim();
  const date = todayForDateBox();

  const added = newSentences.map(function (line) {
    // A quick keyword guess for the topics, until the AI model has found the best ones
    const sentence = {
      text: line,
      language: language,
      topics: detectTopics(line, language),
      ownTopics: [],
      source: source,
      date: date,
    };
    sentences.push(sentence);
    return sentence;
  });

  // The sound file and part chosen in the Audio picker go with the new sentence(s)
  const audio = addAudioPicker.value();
  added.forEach(function (sentence) { applyAudio(sentence, audio); });
  if (added.length > 0) giveAudioTheLink(added[0]);

  saveSentences();
  showSentences();
  added.forEach(updateTopics); // Find the best topics by meaning, in the background

  // Empty the form for the next entry: sentence, source and audio.
  // The language stays, since the next sentence is most likely in the same language.
  sentenceInput.value = "";
  sourceInput.value = "";
  addAudioPicker.reset();
});


// ===== Topic status messages =====
const topicStatus = document.getElementById("topic-status"); // Under the Add button
const aiStatusText = document.getElementById("ai-status");   // In Settings

function showTopicStatus() {
  let message = "";
  if (aiStatus === "loading") {
    message = "Downloading the topic model… " + aiProgress + "% (only the first time)";
  } else if (aiStatus === "failed") {
    message = "The topic model couldn't load (no internet?), so keywords were used instead.";
  } else if (topicsBeingFound > 0) {
    message = "Finding topics…";
  }
  topicStatus.textContent = message;
  topicStatus.hidden = message === "";

  aiStatusText.textContent = {
    "not loaded": "Topic model: not downloaded yet (it downloads when first needed).",
    "loading": "Topic model: downloading… " + aiProgress + "%",
    "ready": "Topic model: ready ✓",
    "failed": "Topic model: couldn't load. Keywords are used instead. Check your internet and try again.",
  }[aiStatus];
}

onAiStatusChange = showTopicStatus; // ai-topics.js calls this when the model's status changes


// ===== Settings: check the topics of all sentences again =====
const detectTopicsButton = document.getElementById("detect-topics-button");
const detectTopicsResult = document.getElementById("detect-topics-result");

detectTopicsButton.addEventListener("click", async function () {
  detectTopicsButton.disabled = true;
  detectTopicsResult.hidden = false;

  // One at a time, so the progress can be shown
  const all = sentences.slice();
  for (let i = 0; i < all.length; i++) {
    detectTopicsResult.textContent = "Checking sentence " + (i + 1) + " of " + all.length + "…";
    await updateTopics(all[i]);
  }

  detectTopicsResult.textContent = "Done! Checked " + all.length + " sentences.";
  detectTopicsButton.disabled = false;
});


// ===== Settings: try a sentence =====
// Shows how well a sentence fits every topic, to see how the model decides
const tryTopicsForm = document.getElementById("try-topics-form");
const tryTopicsInput = document.getElementById("try-topics-input");
const tryTopicsResult = document.getElementById("try-topics-result");

tryTopicsForm.addEventListener("submit", async function (event) {
  event.preventDefault();
  const text = tryTopicsInput.value.trim();
  if (text === "") {
    return;
  }
  tryTopicsResult.textContent = "Thinking…";

  try {
    const scores = await scoreTopics(text, myLanguage || "");
    const chosen = await findTopics(text, myLanguage || "");
    tryTopicsResult.textContent = "Topics: " + (chosen.join(", ") || "none") + "\n\nScores:\n" +
      scores.map(function (item) {
        return item.topic + ": " + item.score.toFixed(2);
      }).join("\n");
  } catch {
    tryTopicsResult.textContent = "The topic model couldn't load. Check your internet and try again.";
  }
});


// ===== Study: Select entry =====
// Lists your sentences in the language chosen with 🌐. Click one to select it.
const entryList = document.getElementById("entry-list");
const noEntries = document.getElementById("no-entries");

// The sentence selected right now (null = none)
let selectedEntry = null;
// The audio group opened in Select entry: an audio file's id, "none" (without audio) or null (the list of groups)
let openEntryGroup = null;

function showEntries() {
  showImmerse(); // Immerse shows the selected entry, so keep it up to date too
  entryList.innerHTML = "";

  if (!myLanguage) {
    noEntries.textContent = "Choose a language with 🌐 to see your entries.";
    noEntries.hidden = false;
    return;
  }

  const matching = sentences.filter(function (sentence) {
    return sentence.language === myLanguage;
  });

  if (matching.length === 0) {
    noEntries.textContent = "No entries in " + languageLabel(myLanguage) + " yet. Add some in 💎 My Collection.";
    noEntries.hidden = false;
    return;
  }
  noEntries.hidden = true;

  // Put the entries in groups: one per audio file, plus "Without audio"
  const groups = {};
  matching.forEach(function (sentence) {
    const groupId = sentence.audioId && audioFileName(sentence.audioId) ? sentence.audioId : "none";
    if (!groups[groupId]) groups[groupId] = [];
    groups[groupId].push(sentence);
  });
  const audioGroupIds = newestFirst(audioLibrary, audioLibrary)
    .map(function (item) { return item.id; })
    .filter(function (id) { return groups[id]; });

  // No audio files used at all: just the list of entries, no groups needed
  if (audioGroupIds.length === 0) {
    showGroupEntries(groups.none, false);
    return;
  }
  if (openEntryGroup && !groups[openEntryGroup]) openEntryGroup = null;

  if (openEntryGroup) {
    // Inside a group: a way back, then its entries
    const back = document.createElement("li");
    back.className = "entry-back";
    back.textContent = "← All audios";
    back.addEventListener("click", function () {
      openEntryGroup = null;
      showEntries();
      saveView();
    });
    const title = document.createElement("span");
    title.className = "entry-group-title";
    title.textContent = openEntryGroup === "none" ? "📝 Without audio" : "🎵 " + audioFileName(openEntryGroup);
    back.append(title);
    entryList.append(back);
    showGroupEntries(groups[openEntryGroup], openEntryGroup !== "none");
    return;
  }

  // The groups: each audio file (newest first), then "Without audio"
  const groupIds = groups.none ? audioGroupIds.concat("none") : audioGroupIds;
  groupIds.forEach(function (groupId) {
    const item = document.createElement("li");
    item.className = "entry-group";
    // The group with the selected entry is marked, so it's easy to find again
    item.classList.toggle("selected", groups[groupId].includes(selectedEntry));
    const name = document.createElement("span");
    name.className = "entry-group-name";
    name.textContent = groupId === "none" ? "📝 Without audio" : "🎵 " + audioFileName(groupId);
    const count = document.createElement("span");
    count.className = "entry-group-count";
    count.textContent = groups[groupId].length === 1 ? "1 entry ›" : groups[groupId].length + " entries ›";
    item.append(name, count);
    item.addEventListener("click", function () {
      openEntryGroup = groupId;
      showEntries();
      saveView();
    });
    entryList.append(item);
  });
}

// The entries of one group, numbered. With audio: in the order they come in the audio,
// each showing its part (start – end). Without audio: the newest first, with the date.
// Long entries show two lines; the selected one is shown in full.
function showGroupEntries(list, byTime) {
  const ordered = byTime
    ? list.slice().sort(function (a, b) {
      return (a.audioStart ?? Infinity) - (b.audioStart ?? Infinity) || sentences.indexOf(a) - sentences.indexOf(b);
    })
    : newestFirst(list, sentences);

  ordered.forEach(function (sentence, index) {
    const item = document.createElement("li");
    item.classList.toggle("selected", sentence === selectedEntry);

    const label = document.createElement("span");
    label.className = "entry-label";
    let detail = "";
    if (byTime) {
      const start = sentence.audioStart ?? null;
      const end = sentence.audioEnd ?? null;
      if (start !== null || end !== null) {
        detail = "  ·  " + (start !== null ? timeLabel(start) : "start") + " – " + (end !== null ? timeLabel(end) : "end");
      }
    } else if (sentence.date) {
      detail = "  ·  " + europeanDate(sentence.date);
    }
    label.textContent = "#" + (index + 1) + detail;

    const text = document.createElement("span");
    text.className = "entry-text";
    text.textContent = sentence.text;

    item.append(label, text);
    item.addEventListener("click", function () {
      // Clicking the selected entry again unselects it
      selectedEntry = selectedEntry === sentence ? null : sentence;
      showEntries();
      saveView();
    });
    entryList.append(item);
  });
}


// ===== Study: Immerse (Pure Text / Grammar Lens) =====
const immerseButtons = document.querySelectorAll("#immerse-options .filter-button");
const pureTextSentence = document.getElementById("pure-text-sentence");

// Show one view (e.g. "grammar-lens") and hide the other
function showImmerseView(viewId) {
  immerseButtons.forEach(function (button) {
    const isThisOne = button.dataset.view === viewId;
    button.classList.toggle("selected", isThisOne);
    document.getElementById(button.dataset.view).hidden = !isThisOne;
  });
  if (viewId === "grammar-lens") {
    showGrammarLens(); // Colour the nouns of the selected entry (asks GPT if needed)
  }
}

immerseButtons.forEach(function (button) {
  button.addEventListener("click", function () {
    showImmerseView(button.dataset.view);
    saveView();
  });
});

// Show the selected entry (if it still exists and is in the chosen language)
function showImmerse() {
  const visible = selectedEntry
    && sentences.includes(selectedEntry)
    && selectedEntry.language === myLanguage;

  if (visible) {
    pureTextSentence.textContent = selectedEntry.text;
    pureTextSentence.classList.remove("hint");
  } else {
    pureTextSentence.textContent = "Select an entry above to read it here.";
    pureTextSentence.classList.add("hint");
  }

  stopAudioIfEntryChanged(); // A different entry: stop reading the old one

  // If Grammar Lens is open, show the (newly) selected entry there too
  if (!document.getElementById("grammar-lens").hidden) {
    showGrammarLens();
  }
}


// ===== Immerse: listen (read the selected entry aloud) =====
// Uses the speech voices built into the device (Mac, iPhone...), so it's free and needs no account.
const SPEECH_LANGUAGES = {
  English: "en-GB", French: "fr-FR", German: "de-DE", Polish: "pl-PL", Turkish: "tr-TR",
};

// The speaker and stop icons (drawn in the button's text colour, so they suit every theme)
const SPEAKER_ICON = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4V5z" fill="currentColor"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg>';
const STOP_ICON = '<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/></svg>';

const audioPlay = document.getElementById("audio-play");
const loopButtons = document.querySelectorAll("#audio-controls .filter-button");
const audioCount = document.getElementById("audio-count");

let audioLoops = loadSaved("audioLoops", "5"); // "5", "10" or "infinite"
let audioPlaying = false;
let audioTimesPlayed = 0;
let audioEntry = null;  // The sentence being read

// Highlight the chosen number of loops
function showLoops() {
  loopButtons.forEach(function (button) {
    button.classList.toggle("selected", button.dataset.loops === audioLoops);
  });
}

loopButtons.forEach(function (button) {
  button.addEventListener("click", function () {
    audioLoops = button.dataset.loops;
    save("audioLoops", audioLoops);
    showLoops();
  });
});

// Show the speaker or stop icon, and "3 / 10" while playing
function showAudioState() {
  audioPlay.innerHTML = audioPlaying ? STOP_ICON : SPEAKER_ICON;
  const label = audioPlaying ? "Stop" : "Play the sentence";
  audioPlay.setAttribute("aria-label", label);
  audioPlay.title = label;
  audioPlay.classList.toggle("playing", audioPlaying);

  if (audioPlaying) {
    const total = audioLoops === "infinite" ? "∞" : audioLoops;
    audioCount.textContent = Math.min(audioTimesPlayed + 1, Number(audioLoops) || Infinity) + " / " + total
      + (recording || !speakingVoiceName ? "" : " · " + speakingVoiceName); // Which voice is reading
  } else {
    audioCount.textContent = "";
  }
}

// The sentence's own recording while it's playing (null when using the device voice)
let recording = null;

function stopAudio() {
  audioPlaying = false;
  audioEntry = null;
  if ("speechSynthesis" in window) {
    speechSynthesis.cancel();
  }
  if (recording) {
    recording.pause();
    URL.revokeObjectURL(recording.src); // Free the memory it used
    recording = null;
  }
  showAudioState();
}

// After each play: play again until the chosen number of times, then stop
function playedOnce(playAgain) {
  if (!audioPlaying) return;
  audioTimesPlayed++;
  const finished = audioLoops !== "infinite" && audioTimesPlayed >= Number(audioLoops);
  if (finished) {
    stopAudio();
  } else {
    showAudioState();
    setTimeout(playAgain, 700); // A short pause between repeats
  }
}

// Play the sentence's part of its sound file: from its start time to its end time
// (the whole file if no times were set)
async function playRecording(entry) {
  let file;
  try {
    file = await loadAudioFile(entry.audioId);
  } catch {
    file = null;
  }
  if (!file) {
    stopAudio();
    audioCount.textContent = "The sound file for this sentence wasn't found on this device.";
    return;
  }
  if (!audioPlaying || audioEntry !== entry) return; // Stopped while loading

  const start = entry.audioStart || 0;
  const end = entry.audioEnd === undefined ? null : entry.audioEnd;
  const thisRecording = new Audio(URL.createObjectURL(file));
  recording = thisRecording;
  let partFinished = false;

  const playFromStart = function () {
    if (!audioPlaying || recording !== thisRecording) return;
    partFinished = false;
    thisRecording.currentTime = start;
    thisRecording.play().catch(function () { stopAudio(); });
  };

  // The part is over: at the end time, or at the end of the file
  const finishPart = function () {
    if (partFinished) return;
    partFinished = true;
    thisRecording.pause();
    playedOnce(playFromStart);
  };

  // Check often whether the end time has been reached (every 10 milliseconds, so it stops right on time)
  const watch = setInterval(function () {
    if (recording !== thisRecording) {
      clearInterval(watch); // Stopped: stop checking
      return;
    }
    if (end !== null && !thisRecording.paused && thisRecording.currentTime >= end) {
      finishPart();
    }
  }, 10);

  thisRecording.onended = finishPart;
  thisRecording.onerror = function () {
    stopAudio();
    audioCount.textContent = "This sound file can't be played.";
  };

  // Wait until the file's length is known, so jumping to the start time works (needed on iPhone)
  if (thisRecording.readyState >= 1) {
    playFromStart();
  } else {
    thisRecording.addEventListener("loadedmetadata", playFromStart, { once: true });
  }
}

// Apple's novelty voices (Eddy, Flo, Grandma, Bubbles…): never chosen
const NOVELTY_VOICES = /eloquence|novelty|\b(eddy|flo|grandma|grandpa|reed|rocko|sandy|shelley|albert|bad news|bahh|bells|boing|bubbles|cellos|good news|jester|organ|superstar|trinoids|whisper|wobble|zarvox|fred|junior|kathy|ralph)\b/i;

// How good a voice is: Siri voices best, then Premium, then Enhanced, then Google's
// (in Chrome), then the standard ones. Novelty voices get -1 so they're never picked.
function voiceQuality(voice) {
  const id = voice.name + " " + voice.voiceURI;
  if (NOVELTY_VOICES.test(id)) return -1;
  if (/siri/i.test(id)) return 5;
  if (/premium/i.test(id)) return 4;
  if (/enhanced/i.test(id)) return 3;
  if (/^google/i.test(voice.name)) return 2;
  return 1;
}

// Pick the best voice for a language, e.g. for "pl-PL" (null: the device decides)
function voiceFor(languageCode) {
  const voices = speechSynthesis.getVoices().filter(function (voice) { return voiceQuality(voice) >= 0; });
  const best = function (list) {
    return list.sort(function (a, b) { return voiceQuality(b) - voiceQuality(a); })[0] || null;
  };
  // Voices for exactly this language and country first, then any country with the same language
  return best(voices.filter(function (voice) { return voice.lang.replace("_", "-") === languageCode; }))
    || best(voices.filter(function (voice) { return voice.lang.slice(0, 2) === languageCode.slice(0, 2); }));
}

// Some browsers load their voices a moment after the page opens: wait for them (at most 1 second)
function voicesReady() {
  if (speechSynthesis.getVoices().length > 0) return Promise.resolve();
  return new Promise(function (resolve) {
    speechSynthesis.addEventListener("voiceschanged", resolve, { once: true });
    setTimeout(resolve, 1000);
  });
}

// The name of the voice speaking now, shown beside the counter (e.g. "Zosia (Premium)")
let speakingVoiceName = "";

// Read the sentence once; when it ends, read it again until the chosen number of times
function speakOnce() {
  if (!audioPlaying) return;

  const utterance = new SpeechSynthesisUtterance(audioEntry.text);
  const languageCode = SPEECH_LANGUAGES[audioEntry.language];
  speakingVoiceName = "";
  if (languageCode) {
    utterance.lang = languageCode;
    const voice = voiceFor(languageCode);
    if (voice) {
      try {
        utterance.voice = voice;
        speakingVoiceName = voice.name;
      } catch {
        // The voice couldn't be used: the device picks one for the language instead
      }
    }
  }
  showAudioState();
  utterance.rate = 0.9; // A little slower than normal, for learning

  utterance.onend = function () { playedOnce(speakOnce); };
  utterance.onerror = function () {
    stopAudio();
  };

  speechSynthesis.speak(utterance);
}

audioPlay.addEventListener("click", function () {
  if (audioPlaying) {
    stopAudio();
    return;
  }
  const entry = selectedEntry;
  if (!entry || !sentences.includes(entry) || entry.language !== myLanguage) {
    audioCount.textContent = "Select an entry above first.";
    return;
  }
  // No sound file: the device reads the sentence aloud, if it can
  if (!entry.audioId && !("speechSynthesis" in window)) {
    audioCount.textContent = "This browser can't read text aloud.";
    return;
  }

  audioPlaying = true;
  audioEntry = entry;
  audioTimesPlayed = 0;
  showAudioState();

  if (entry.audioId) {
    playRecording(entry); // The sentence's own MP3
  } else {
    speechSynthesis.cancel(); // Clear anything left over
    // The device's voice. Speak straight away if the voices are there (iPhone needs that);
    // otherwise wait a moment for them to load.
    if (speechSynthesis.getVoices().length > 0) {
      speakOnce();
    } else {
      voicesReady().then(speakOnce);
    }
  }
});

// Ask for the list of voices early, so it's ready by the time 🔊 is pressed
if ("speechSynthesis" in window) {
  speechSynthesis.getVoices();
}

// Stop reading if another entry is selected (or the entry disappears)
function stopAudioIfEntryChanged() {
  if (audioPlaying && audioEntry !== selectedEntry) {
    stopAudio();
  }
}

showLoops();
showAudioState();


// ===== Settings: themes =====
// Each theme's colours and fonts are in style.css. This list gives each one a name.
// The first theme is used when none has been chosen yet.
const THEMES = [
  {
    id: "cabana",
    name: "Orchid Cabana Club",
  },
  {
    id: "coffee",
    name: "Cold Brew Coffee",
  },
  {
    id: "matcha",
    name: "Kyoto Iced Matcha",
  },
];

const themeOptions = document.getElementById("theme-options");
// The saved theme, or the first one if nothing (or a theme that no longer exists) was saved
let myTheme = loadSaved("theme", null);
if (!THEMES.some(function (theme) { return theme.id === myTheme; })) {
  myTheme = THEMES[0].id;
}

// Put a theme on the whole page and mark its card as chosen
function applyTheme(themeId) {
  document.documentElement.dataset.theme = themeId;
  themeOptions.querySelectorAll(".theme-card").forEach(function (card) {
    card.classList.toggle("selected", card.dataset.theme === themeId);
  });
}

// One card per theme. Each card has its own data-theme, so it shows in its own look.
THEMES.forEach(function (theme) {
  const card = document.createElement("button");
  card.type = "button";
  card.className = "theme-card";
  card.dataset.theme = theme.id;

  const name = document.createElement("span");
  name.className = "theme-name";
  name.textContent = theme.name;

  card.append(name);
  card.addEventListener("click", function () {
    myTheme = theme.id;
    applyTheme(myTheme);
    save("theme", myTheme);
  });
  themeOptions.append(card);
});

applyTheme(myTheme);


// ===== My audios tab: audio files =====
const audioLibraryList = document.getElementById("audio-library");
const noAudioFiles = document.getElementById("no-audio-files");
let confirmingAudioId = null; // The file waiting for "Delete it?" to be answered

// Files added before dates were saved: use the date of the first sentence that uses them
audioLibrary.forEach(function (item) {
  if (item.date) return;
  const dates = sentences
    .filter(function (sentence) { return sentence.audioId === item.id && sentence.date; })
    .map(function (sentence) { return sentence.date; })
    .sort();
  if (dates.length > 0) item.date = dates[0];
});
saveAudioLibrary();

// The language filter above the list ("all", a language, or "" for files without one)
const audioFilter = document.getElementById("audio-filter");
let audioFilterLanguage = "all";

function showAudioLibrary() {
  audioFilterLanguage = makeLanguageFilter(audioFilter, audioLibrary, audioFilterLanguage, function (language) {
    audioFilterLanguage = language;
    editingAudioId = null;
    confirmingAudioId = null;
    showAudioLibrary();
    saveView();
  });
  audioLibraryList.innerHTML = "";

  // Only the files that match the language filter
  const shown = audioLibrary.filter(function (item) {
    return audioFilterLanguage === "all" || item.language === audioFilterLanguage;
  });
  if (audioLibrary.length === 0) {
    noAudioFiles.textContent = "No audio files yet. Add one with the Audio box when adding a sentence.";
  } else if (shown.length === 0) {
    noAudioFiles.textContent = "No audio files in this language.";
  }
  noAudioFiles.hidden = shown.length > 0;

  // Newest at the top, like My sentences
  newestFirst(shown, audioLibrary).forEach(function (item) {
    const users = sentences.filter(function (sentence) { return sentence.audioId === item.id; });

    const row = document.createElement("li");
    row.className = "audio-file-row";

    const name = document.createElement("span");
    name.className = "audio-file-name";
    name.textContent = "🎵 " + item.name;
    name.title = item.name; // Long names are cut to two lines; the full name shows on hover

    // Editing this file: boxes for its name, language and source, with Save and Cancel
    if (editingAudioId === item.id) {
      row.append(makeAudioEditForm(item));
      audioLibraryList.append(row);
      return;
    }

    // Left column: the flag of the file's language (empty if it has none), like in My sentences
    const side = document.createElement("div");
    side.className = "sentence-side";
    const flag = document.createElement("span");
    flag.className = "sentence-flag";
    flag.textContent = LANGUAGE_FLAGS[item.language] || "";
    flag.title = item.language || "No language";
    side.append(flag);

    // Where the file is from: a link (like "▶ YouTube"), plain text, or a reminder if it's missing
    let source;
    const sourceUrl = webAddress(item.source);
    if (sourceUrl) {
      source = document.createElement("a");
      source.href = sourceUrl;
      source.target = "_blank";
      source.rel = "noopener";
      source.textContent = sourceLabel(sourceUrl);
      source.className = "source-link audio-file-source-text";
    } else {
      source = document.createElement("span");
      source.className = "audio-file-source-text" + (item.source ? "" : " missing-text");
      source.textContent = item.source || "No source yet: add one with Edit";
    }

    const count = document.createElement("span");
    count.className = "audio-file-count";
    count.textContent = users.length === 1 ? "1 sentence" : users.length + " sentences";

    const buttons = document.createElement("div");
    buttons.className = "sentence-buttons";

    if (confirmingAudioId === item.id) {
      // Deleting a file also takes it off every sentence that uses it
      const question = document.createElement("span");
      question.className = "delete-question";
      question.textContent = users.length > 0 ? "Delete it? It's removed from those sentences too." : "Delete it?";

      const yesButton = makeButton("Yes", "small-button delete-yes", function () {
        stopAudio();
        users.forEach(function (sentence) { applyAudio(sentence, { audioId: "" }); });
        audioLibrary = audioLibrary.filter(function (other) { return other.id !== item.id; });
        removeAudioFile(item.id);
        confirmingAudioId = null;
        saveAudioLibrary();
        saveSentences();
        refreshAudioPickers();
        showSentences();
      });
      const noButton = makeButton("No", "small-button", function () {
        confirmingAudioId = null;
        showAudioLibrary();
      });
      buttons.append(question, yesButton, noButton);
    } else {
      buttons.append(
        makeButton("Edit", "small-button", function () {
          editingAudioId = item.id;
          confirmingAudioId = null;
          showAudioLibrary();
        }),
        makeButton("Delete", "small-button", function () {
          confirmingAudioId = item.id;
          editingAudioId = null;
          showAudioLibrary();
        })
      );
    }

    // Middle column: the name, the source and how many sentences use it
    const main = document.createElement("div");
    main.className = "sentence-main";
    main.append(name, source, count);

    // Right column: the date it was added, with the buttons underneath
    const actions = document.createElement("div");
    actions.className = "sentence-actions";
    const date = document.createElement("span");
    date.className = "sentence-date";
    date.textContent = item.date ? europeanDate(item.date) : "";
    actions.append(date, buttons);

    row.classList.add("sentence-row");
    row.append(side, main, actions);
    audioLibraryList.append(row);
  });
}

// The file being edited in Settings (null = none)
let editingAudioId = null;

// Edit a file's name, language and source. The source is required.
function makeAudioEditForm(item) {
  const form = document.createElement("form");
  form.className = "edit-form audio-edit-form";

  const nameLabel = document.createElement("label");
  const nameBox = document.createElement("input");
  nameBox.type = "text";
  nameBox.value = item.name;
  nameLabel.append("Name", nameBox);

  const languageLabelBox = document.createElement("label");
  const languageBox = document.createElement("select");
  fillLanguageSelect(languageBox, item.language, item.language);
  languageLabelBox.append("Language", languageBox);

  const sourceLabelBox = document.createElement("label");
  const sourceBox = document.createElement("input");
  sourceBox.type = "text";
  sourceBox.placeholder = "e.g. a YouTube link";
  sourceBox.value = item.source || "";
  sourceLabelBox.append("Source (required)", sourceBox);

  const sourceError = document.createElement("span");
  sourceError.className = "error-text";
  sourceError.textContent = "Please add where this audio is from.";
  sourceError.hidden = true;

  const saveButton = document.createElement("button");
  saveButton.type = "submit";
  saveButton.textContent = "Save";
  const cancelButton = makeButton("Cancel", "small-button", function () {
    editingAudioId = null;
    showAudioLibrary();
  });
  const buttons = document.createElement("div");
  buttons.className = "edit-buttons";
  buttons.append(saveButton, cancelButton);

  form.append(nameLabel, languageLabelBox, sourceLabelBox, sourceError, buttons);

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    const source = sourceBox.value.trim();
    if (!source) {
      sourceError.hidden = false;
      sourceBox.focus();
      return;
    }
    item.name = nameBox.value.trim() || item.name; // An empty name keeps the old one
    item.language = languageBox.value;
    item.source = source;
    editingAudioId = null;
    save("audioLibrary", audioLibrary); // Shows "Saved ✓"
    refreshAudioPickers(); // New name and language in the Audio lists
    showSentences(); // The links under its sentences, and this list
  });

  return form;
}


// ===== OpenAI: settings =====
// The key and model are kept only in this browser (localStorage), never in the website's files.
// gpt-4.1 doesn't reason at all, so answers come straight away.
const DEFAULT_MODEL = "gpt-4.1";

const openaiForm = document.getElementById("openai-form");
const openaiKeyInput = document.getElementById("openai-key");
const openaiModelInput = document.getElementById("openai-model");
const openaiForget = document.getElementById("openai-forget");
const openaiStatus = document.getElementById("openai-status");

let openaiKey = loadSaved("openaiKey", "");
let openaiModel = loadSaved("openaiModel", DEFAULT_MODEL);
if (openaiModel === "gpt-6-luna") {
  openaiModel = DEFAULT_MODEL; // The old default: switch to the new one
}

function showOpenaiStatus() {
  openaiModelInput.value = openaiModel;
  openaiKeyInput.value = "";
  // Only the last 4 characters are ever shown
  openaiKeyInput.placeholder = openaiKey ? "Saved (ends in …" + openaiKey.slice(-4) + ")" : "sk-...";
  openaiStatus.textContent = openaiKey
    ? "Connected: a key is saved on this device. Model: " + openaiModel
    : "No key saved yet.";
}

openaiForm.addEventListener("submit", function (event) {
  event.preventDefault();
  const typedKey = openaiKeyInput.value.trim();
  if (typedKey) {
    openaiKey = typedKey; // An empty box keeps the key that's already saved
  }
  openaiModel = openaiModelInput.value.trim() || DEFAULT_MODEL;
  save("openaiKey", openaiKey);
  save("openaiModel", openaiModel);
  showOpenaiStatus();
});

openaiForget.addEventListener("click", function () {
  openaiKey = "";
  save("openaiKey", null);
  showOpenaiStatus();
});

showOpenaiStatus();

// Send a request to OpenAI and return its answer. If it fails, the error explains why in plain words.
async function askOpenai(request) {
  let response;
  try {
    response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + openaiKey,
      },
      body: JSON.stringify(request),
    });
  } catch {
    // The browser hides OpenAI's error replies (e.g. for a wrong key), so this can mean either
    throw new Error("Couldn't get an answer from OpenAI. Check your internet connection, and that the API key in ⚙️ Settings → OpenAI is correct.");
  }

  const data = await response.json();
  if (response.ok) {
    return data.choices[0].message.content;
  }
  if (response.status === 401) throw new Error("The API key wasn't accepted. Check it in ⚙️ Settings → OpenAI.");
  if (response.status === 404) throw new Error("OpenAI doesn't know the model \"" + openaiModel + "\". Check it in ⚙️ Settings → OpenAI.");
  if (response.status === 429) throw new Error("Too many requests, or no credit left on your OpenAI account. Try again later.");
  throw new Error("Something went wrong (" + response.status + "): " + (data.error ? data.error.message : ""));
}


// ===== Immerse: Grammar Lens (nouns coloured by gender) =====
// Which genders each language's nouns have. English and Turkish nouns have none.
// Languages not listed here are sent to GPT anyway.
const NOUN_GENDERS = {
  English: [],
  Turkish: [],
  French: ["masculine", "feminine"],
  German: ["masculine", "feminine", "neuter"],
  Polish: ["masculine", "feminine", "neuter"],
};

const grammarSentence = document.getElementById("grammar-sentence");
const grammarStatus = document.getElementById("grammar-status");

let grammarBeingFound = null; // The sentence waiting for GPT's answer (so it's only asked once)

function showGrammarStatus(message) {
  grammarStatus.textContent = message;
  grammarStatus.hidden = !message;
}

// Ask GPT for every noun in a sentence and its gender.
// The answer must follow a fixed shape: { nouns: [{ word: "kawa", gender: "feminine" }, ...] }
async function findNounGenders(sentence) {
  const answer = await askOpenai({
    model: openaiModel,
    messages: [
      {
        role: "system",
        content:
          "You are a careful linguist. Find every noun in the user's sentence and give its grammatical gender. " +
          "Copy each noun exactly as it is written in the sentence (same letters, same ending, same capitals). " +
          "List the nouns in the order they appear; if the same noun appears twice, list it twice. " +
          "Use only masculine, feminine or neuter (for Polish, masculine personal, animate and inanimate are all masculine). " +
          "Leave out words that are not nouns, and nouns that have no gender.",
      },
      {
        role: "user",
        content: "Language: " + (sentence.language || "unknown") + "\nSentence: " + sentence.text,
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "noun_genders",
        strict: true,
        schema: {
          type: "object",
          properties: {
            nouns: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  word: { type: "string" },
                  gender: { type: "string", enum: ["masculine", "feminine", "neuter"] },
                },
                required: ["word", "gender"],
                additionalProperties: false,
              },
            },
          },
          required: ["nouns"],
          additionalProperties: false,
        },
      },
    },
  });
  return JSON.parse(answer).nouns;
}

// Find where each noun is in the sentence, as whole words only (so "kot" isn't found inside "kotlet").
// Returns the pieces in order: [{ start, end, gender }, ...]
function findNounPlaces(text, nouns) {
  const places = [];
  let searchFrom = 0;
  const isLetter = function (character) { return /[\p{L}\p{M}]/u.test(character || ""); };

  nouns.forEach(function (noun) {
    const lowerText = text.toLocaleLowerCase();
    const lowerWord = noun.word.toLocaleLowerCase();
    // Look after the previous noun first (GPT lists them in order), then from the start
    for (const from of [searchFrom, 0]) {
      let start = lowerText.indexOf(lowerWord, from);
      while (start !== -1) {
        const end = start + lowerWord.length;
        const wholeWord = !isLetter(text[start - 1]) && !isLetter(text[end]);
        const taken = places.some(function (place) { return start < place.end && end > place.start; });
        if (wholeWord && !taken) {
          places.push({ start: start, end: end, gender: noun.gender });
          searchFrom = end;
          return;
        }
        start = lowerText.indexOf(lowerWord, start + 1);
      }
    }
  });

  return places.sort(function (a, b) { return a.start - b.start; });
}

// Draw the sentence with each noun in its gender's colour
function drawColouredSentence(text, nouns) {
  grammarSentence.textContent = "";
  let position = 0;
  findNounPlaces(text, nouns).forEach(function (place) {
    grammarSentence.append(text.slice(position, place.start));
    const noun = document.createElement("span");
    noun.className = "noun " + place.gender;
    noun.title = place.gender; // Shows "feminine" etc. when the mouse is over it
    noun.textContent = text.slice(place.start, place.end);
    grammarSentence.append(noun);
    position = place.end;
  });
  grammarSentence.append(text.slice(position));
}

// Fill the Grammar Lens view for the selected entry. Asks GPT only when needed.
async function showGrammarLens() {
  const entry = selectedEntry;
  const visible = entry && sentences.includes(entry) && entry.language === myLanguage;
  grammarSentence.classList.remove("hint");

  if (!visible) {
    grammarSentence.textContent = "Select an entry above to see its nouns by gender.";
    grammarSentence.classList.add("hint");
    showGrammarStatus("");
    return;
  }

  // Languages whose nouns have no gender: nothing to colour
  const genders = NOUN_GENDERS[entry.language];
  if (genders && genders.length === 0) {
    grammarSentence.textContent = entry.text;
    showGrammarStatus(languageLabel(entry.language) + " nouns don't have grammatical gender, so there's nothing to colour.");
    return;
  }

  // Already found earlier for this exact text: show it straight away (no new request)
  if (entry.grammar && entry.grammar.text === entry.text) {
    drawColouredSentence(entry.text, entry.grammar.nouns);
    showGrammarStatus(entry.grammar.nouns.length === 0 ? "No nouns with a gender found in this sentence." : "");
    return;
  }

  grammarSentence.textContent = entry.text;
  if (!openaiKey) {
    showGrammarStatus("Add your OpenAI API key in ⚙️ Settings → OpenAI to use Grammar Lens.");
    return;
  }
  if (grammarBeingFound === entry) {
    return; // Already asking GPT about this sentence
  }

  showGrammarStatus("Finding the nouns…");
  grammarBeingFound = entry;
  try {
    const nouns = await findNounGenders(entry);
    entry.grammar = { text: entry.text, nouns: nouns }; // Remember it, so it's never asked twice
    saveSentences();
  } catch (error) {
    if (selectedEntry === entry) showGrammarStatus(error.message);
    grammarBeingFound = null;
    return;
  }
  grammarBeingFound = null;

  // Only redraw if the same entry is still selected and Grammar Lens is still open
  if (selectedEntry === entry && !document.getElementById("grammar-lens").hidden) {
    showGrammarLens();
  }
}


// ===== Practice: questions made by GPT =====
// Short questions from the selected entry, at the chosen level (How Deep Today?)
// and practice target (noun, verb, adjective or mix): one of each type, in this order.
// The gender question is added for A1-B2, in languages whose nouns have a gender.
const QUESTION_TYPES = {
  reading: "📖 Mini reading",
  form: "✏️ Correct form",
  order: "🔀 Word order",
  odd: "🧩 Odd one out",
  gender: "🎨 Gender",
};

const GENDER_QUESTION_LEVELS = ["A1", "A2", "B1", "B2"];

// At these levels, each question lists the meanings of its words that aren't in the selected entry
const WORD_HELP_LEVELS = ["A1", "A2", "B1"];

// The genders to choose from for an entry, or [] if there's no gender question
// (C1-C2, or a language whose nouns have no gender, like English and Turkish)
function genderChoices(entry, level) {
  if (!GENDER_QUESTION_LEVELS.includes(level)) return [];
  return NOUN_GENDERS[entry.language] || [];
}

const makeQuestionsButton = document.getElementById("make-questions");
const quizStatus = document.getElementById("quiz-status");
const quizList = document.getElementById("quiz-list");

let quizScore = { answered: 0, correct: 0, total: 0 };

function showQuizStatus(message) {
  quizStatus.textContent = message;
  quizStatus.hidden = !message;
}

// How the practice target is written in GPT's instructions and in the status line.
// "Mix" asks for nouns, verbs and adjectives, varied across the questions.
function targetWords(target) {
  if (target === "mix") {
    return { focus: "a mix of nouns, verbs and adjectives (use different kinds across the questions)",
      one: "noun, verb or adjective", kind: "word", status: "mixed words" };
  }
  return { focus: target + "s", one: target, kind: target, status: target + "s" };
}

// Ask GPT for the questions. The answer must follow a fixed shape (checked by OpenAI).
async function askForQuestions(entry, level, target) {
  const words = targetWords(target);
  const genders = genderChoices(entry, level);
  // A1-B1: explain the new words in each question
  const wordHelpPart = WORD_HELP_LEVELS.includes(level)
    ? "glossary: list the words in this question (passage, question, options, answer_sentence) that are NOT in " +
      "the learner's sentence. Compare dictionary forms, so a word that appears in the sentence in another form " +
      "is not listed. Each item: word exactly as written in the question, and a short English meaning (1-3 words). " +
      "At most 6 per question. Do not list the answer options of the form question (gloss the word in brackets " +
      "instead), and never mention grammar or gender in a meaning. The learner is a beginner: almost every " +
      "question has new words, so fill the glossary for every question that has them (also for words in the " +
      "options). Use [] only if every word really appears in the learner's sentence."
    : "glossary: always [].";
  const genderPart = genders.length === 0 ? "" :
    "5. type \"gender\": passage is one noun from the sentence in its dictionary form (e.g. \"poczta\"); " +
    "question is \"\"; options are exactly " + JSON.stringify(genders) + " in that order; answer_index is " +
    "the noun's grammatical gender.\n";

  const answer = await askOpenai({
    model: openaiModel,
    messages: [
      {
        role: "system",
        content:
          "You write short practice questions for a language learner. Everything the learner reads in the questions " +
          "(passages, questions, options, sentences) is in " + entry.language + ". Instructions and explanations are " +
          "in simple English. Match CEFR level " + level + ": simple words and grammar for A1-A2, richer for B1-B2, " +
          "natural and advanced for C1-C2. Keep everything short. Focus on " + words.focus + ". Reuse words from the " +
          "learner's sentence and stay on its topic. Every question has exactly one correct answer.\n\n" +
          "Write exactly " + (genders.length > 0 ? 5 : 4) + " questions, in this order:\n" +
          "1. type \"reading\": a NEW passage of 1-2 short sentences on the same topic, using some of the sentence's " +
          "words; a short question about it; 3 options (4 for B1 and above); answer_index is the correct option.\n" +
          "2. type \"form\": a short sentence with one " + words.one + " replaced by ___ and its base form in brackets " +
          "after the gap, e.g. \"Idę do ___ (bankomat).\"; 3 options (4 for B1 and above) that are different forms of " +
          "that word; answer_index is the correct one.\n" +
          "3. type \"order\": answer_sentence is one short correct sentence (4-8 words) using words from the sentence. " +
          "Leave options empty and answer_index -1.\n" +
          "4. type \"odd\": 4 single words as options; 3 belong together (same topic, or the same kind of " +
          target + "), 1 does not; answer_index is the odd one.\n" +
          genderPart + "\n" +
          "Use \"\" for passage when there is none, [] for options when there are none, -1 for answer_index when " +
          "there is none, and \"\" for answer_sentence except in the order question. explanation: one short English " +
          "sentence explaining the answer.\n" + wordHelpPart,
      },
      {
        role: "user",
        content: "Learner's sentence (" + entry.language + "): " + entry.text +
          (entry.topics.length > 0 ? "\nTopics: " + entry.topics.join(", ") : ""),
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "practice_questions",
        strict: true,
        schema: {
          type: "object",
          properties: {
            questions: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  type: { type: "string", enum: ["reading", "form", "order", "odd", "gender"] },
                  instruction: { type: "string" },
                  passage: { type: "string" },
                  question: { type: "string" },
                  options: { type: "array", items: { type: "string" } },
                  answer_index: { type: "integer" },
                  answer_sentence: { type: "string" },
                  explanation: { type: "string" },
                  glossary: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        word: { type: "string" },
                        meaning: { type: "string" },
                      },
                      required: ["word", "meaning"],
                      additionalProperties: false,
                    },
                  },
                },
                required: ["type", "instruction", "passage", "question", "options", "answer_index", "answer_sentence", "explanation", "glossary"],
                additionalProperties: false,
              },
            },
          },
          required: ["questions"],
          additionalProperties: false,
        },
      },
    },
  });

  // Keep only questions that can really be answered
  return JSON.parse(answer).questions.filter(function (question) {
    if (!WORD_HELP_LEVELS.includes(level)) {
      question.glossary = []; // Word help is only for A1-B1
    }
    if (question.type === "order") {
      return question.answer_sentence.trim().split(/\s+/).length >= 2;
    }
    if (question.type === "gender") {
      // Always offer this language's genders in the same order; GPT only says which one is right
      const answerGender = (question.options[question.answer_index] || "").toLowerCase();
      question.options = genders.slice();
      question.answer_index = genders.indexOf(answerGender);
      return genders.length > 0 && question.answer_index >= 0 && question.passage.trim() !== "";
    }
    return question.options.length >= 2
      && question.answer_index >= 0 && question.answer_index < question.options.length;
  });
}

// Mix up a list (for the word order question)
function shuffled(list) {
  const copy = list.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  // Never show the words already in the right order
  if (copy.join(" ") === list.join(" ") && list.length > 1) {
    copy.push(copy.shift());
  }
  return copy;
}

// Compare sentences without caring about capitals, commas or full stops
function sameSentence(a, b) {
  const clean = function (text) {
    return text.toLocaleLowerCase().replace(/[.,!?;:¿¡"«»„“”]/g, "").replace(/\s+/g, " ").trim();
  };
  return clean(a) === clean(b);
}

// After each answer: ✓ or ✗, the explanation, and the score once all are answered
function markAnswer(card, correct, explanation) {
  card.classList.add(correct ? "answered-right" : "answered-wrong");
  const result = document.createElement("p");
  result.className = "quiz-result " + (correct ? "right" : "wrong");
  result.textContent = (correct ? "✓ Correct. " : "✗ Not quite. ") + explanation;
  card.append(result);

  quizScore.answered++;
  if (correct) quizScore.correct++;
  if (quizScore.answered === quizScore.total) {
    showQuizStatus("Done: " + quizScore.correct + " / " + quizScore.total + " correct. Press Make questions for new ones.");
  }
}

// A question answered by tapping one option (reading, correct form, odd one out, gender)
function makeChoiceQuestion(card, question) {
  const options = document.createElement("div");
  options.className = "quiz-options";
  question.options.forEach(function (option, index) {
    // Gender options get the Grammar Lens colours: pink feminine, blue masculine, green neuter
    const genderClass = question.type === "gender" ? " gender-option noun " + option : "";
    const button = makeButton(option, "filter-button quiz-option" + genderClass, function () {
      options.querySelectorAll("button").forEach(function (other) { other.disabled = true; });
      button.classList.add(index === question.answer_index ? "right" : "wrong");
      options.children[question.answer_index].classList.add("right"); // Always show the right one
      markAnswer(card, index === question.answer_index, question.explanation);
    });
    options.append(button);
  });
  card.append(options);
}

// The word order question: tap the words to build the sentence, then Check
function makeOrderQuestion(card, question) {
  const words = question.answer_sentence.trim().split(/\s+/);
  const built = document.createElement("div");
  built.className = "quiz-built";
  const pool = document.createElement("div");
  pool.className = "quiz-options";

  shuffled(words).forEach(function (word) {
    const chip = makeButton(word, "filter-button quiz-option", function () {
      // Tapping a word moves it between the pool and the sentence being built
      (chip.parentElement === pool ? built : pool).append(chip);
      check.disabled = pool.children.length > 0; // Check works once every word is used
    });
    pool.append(chip);
  });

  const check = makeButton("Check", "", function () {
    const answer = Array.from(built.children).map(function (chip) { return chip.textContent; }).join(" ");
    card.querySelectorAll(".quiz-option").forEach(function (chip) { chip.disabled = true; });
    check.disabled = true;
    const correct = sameSentence(answer, question.answer_sentence);
    built.classList.add(correct ? "right" : "wrong");
    markAnswer(card, correct, (correct ? "" : "Correct: " + question.answer_sentence + ". ") + question.explanation);
  });
  check.disabled = true; // Until every word is used

  card.append(built, pool, check);
}

// Show the questions
function showQuestions(questions) {
  quizList.innerHTML = "";
  quizScore = { answered: 0, correct: 0, total: questions.length };

  questions.forEach(function (question, index) {
    const card = document.createElement("li");
    card.className = "quiz-card";

    // Card header: a numbered circle, the type (with its icon), and the instruction underneath
    const header = document.createElement("div");
    header.className = "quiz-header";

    const number = document.createElement("span");
    number.className = "quiz-number";
    number.textContent = index + 1;

    const titles = document.createElement("div");
    const kind = document.createElement("p");
    kind.className = "quiz-kind";
    kind.textContent = QUESTION_TYPES[question.type];
    titles.append(kind);
    if (question.instruction) {
      const instruction = document.createElement("p");
      instruction.className = "quiz-instruction";
      instruction.textContent = question.instruction;
      titles.append(instruction);
    }

    header.append(number, titles);
    card.append(header);

    if (question.passage) {
      const passage = document.createElement("p");
      passage.className = "quiz-passage";
      passage.textContent = question.passage;
      card.append(passage);
    }
    if (question.question) {
      const text = document.createElement("p");
      text.className = "quiz-question";
      text.textContent = question.question;
      card.append(text);
    }

    // A1-B1: the meanings of new words in this question, before the answers
    if (question.glossary && question.glossary.length > 0) {
      const words = document.createElement("p");
      words.className = "quiz-glossary";
      words.append("💡 New words: ");
      question.glossary.forEach(function (item, index) {
        if (index > 0) words.append(" · ");
        const word = document.createElement("b");
        word.textContent = item.word;
        words.append(word, " – " + item.meaning);
      });
      card.append(words);
    }

    if (question.type === "order") {
      makeOrderQuestion(card, question);
    } else {
      makeChoiceQuestion(card, question);
    }
    quizList.append(card);
  });
}

makeQuestionsButton.addEventListener("click", async function () {
  const entry = selectedEntry;
  if (!entry || !sentences.includes(entry) || entry.language !== myLanguage) {
    showQuizStatus("Select an entry above first.");
    return;
  }
  if (!openaiKey) {
    showQuizStatus("Add your OpenAI API key in ⚙️ Settings → OpenAI first.");
    return;
  }

  const level = myLevel || "A2"; // No level picked: a gentle A2
  makeQuestionsButton.disabled = true;
  quizList.innerHTML = "";
  showQuizStatus("Making " + level + " questions about " + practiceTarget + "s…");

  try {
    const questions = await askForQuestions(entry, level, practiceTarget);
    if (questions.length === 0) {
      showQuizStatus("GPT's questions couldn't be used. Please try again.");
    } else {
      showQuizStatus(level + " · " + practiceTarget + "s · from: " + entry.text.slice(0, 40) + (entry.text.length > 40 ? "…" : ""));
      showQuestions(questions);
    }
  } catch (error) {
    showQuizStatus(error.message);
  }
  makeQuestionsButton.disabled = false;
});


// ===== Settings: backup =====
// A backup is one .json file with everything saved in this browser: the saved settings and
// sentences (from localStorage) and the sound files (from IndexedDB, written out as text).
// The OpenAI key is left out, so the file is safe to keep in iCloud Drive etc.
const BACKUP_KEYS = ["sentences", "audioLibrary", "myLanguage", "myLanguages", LEVEL_KEY,
  "practiceTarget", "audioLoops", "theme", "openaiModel", "view"];

const backupDownload = document.getElementById("backup-download");
const backupRestore = document.getElementById("backup-restore");
const backupFile = document.getElementById("backup-file");
const backupConfirm = document.getElementById("backup-confirm");
const backupQuestion = document.getElementById("backup-question");
const backupYes = document.getElementById("backup-yes");
const backupNo = document.getElementById("backup-no");
const backupStatus = document.getElementById("backup-status");
let backupToRestore = null; // The backup waiting for "Yes"

// "1 sentence", "3 sentences"
function countOf(number, word) {
  return number + " " + word + (number === 1 ? "" : "s");
}

function showBackupStatus(message) {
  backupStatus.textContent = message;
  backupStatus.hidden = !message;
}

// A sound file as text ("data:audio/mpeg;base64,…"), so it fits in the backup file
function fileToText(file) {
  return new Promise(function (resolve, reject) {
    const reader = new FileReader();
    reader.onload = function () { resolve(reader.result); };
    reader.onerror = function () { reject(reader.error); };
    reader.readAsDataURL(file);
  });
}

backupDownload.addEventListener("click", async function () {
  backupDownload.disabled = true;
  showBackupStatus("Making the backup…");
  try {
    const saved = {};
    BACKUP_KEYS.forEach(function (key) {
      const value = localStorage.getItem(key);
      if (value !== null) saved[key] = value;
    });

    // Every sound file in the library, with its name and type
    const audio = {};
    const missing = []; // Files listed in My audios whose sound isn't in this browser
    for (const item of audioLibrary) {
      const file = await loadAudioFile(item.id);
      if (file) {
        audio[item.id] = { name: item.name, type: file.type, data: await fileToText(file) };
      } else {
        missing.push(item.name);
      }
    }

    const backup = { app: "language-app", date: todayForDateBox(), saved: saved, audio: audio };
    const blob = new Blob([JSON.stringify(backup)], { type: "application/json" });

    // Download it (on iPhone: choose where to save it, e.g. Files → iCloud Drive)
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "language-app-backup-" + backup.date + ".json";
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(function () { URL.revokeObjectURL(link.href); }, 10000);

    showBackupStatus("Backup downloaded: " + countOf(sentences.length, "sentence") + " and " +
      countOf(Object.keys(audio).length, "audio file") + "." +
      (missing.length > 0 ? " Not included (their sound isn't saved in this browser, upload them again): " +
        missing.join(", ") + "." : ""));
  } catch {
    showBackupStatus("The backup couldn't be made. Please try again.");
  }
  backupDownload.disabled = false;
});

// Restore: choose the file first, then confirm, since it replaces everything on this device
backupRestore.addEventListener("click", function () {
  backupFile.click();
});

backupFile.addEventListener("change", async function () {
  const file = backupFile.files[0];
  backupFile.value = "";
  if (!file) return;
  try {
    const backup = JSON.parse(await file.text());
    if (backup.app !== "language-app" || !backup.saved) throw new Error();
    backupToRestore = backup;
  } catch {
    showBackupStatus("That file isn't a backup from this app.");
    return;
  }
  const count = JSON.parse(backupToRestore.saved.sentences || "[]").length;
  backupQuestion.textContent = (backupToRestore.date ? "Made on " + europeanDate(backupToRestore.date) + ": " : "") +
    countOf(count, "sentence") + " and " +
    countOf(Object.keys(backupToRestore.audio || {}).length, "audio file") + ".";
  backupConfirm.hidden = false;
  showBackupStatus("");
});

backupNo.addEventListener("click", function () {
  backupToRestore = null;
  backupConfirm.hidden = true;
});

backupYes.addEventListener("click", async function () {
  const backup = backupToRestore;
  backupToRestore = null;
  backupConfirm.hidden = true;
  showBackupStatus("Restoring…");
  try {
    stopAudio();
    // The sound files first. The old ones are only removed once the backup's are all stored,
    // so nothing is lost if this goes wrong halfway.
    const backupAudio = backup.audio || {};
    for (const [id, audio] of Object.entries(backupAudio)) {
      const blob = await (await fetch(audio.data)).blob();
      await storeAudioFile(id, new File([blob], audio.name, { type: audio.type }));
    }
    for (const item of audioLibrary) {
      if (!(item.id in backupAudio)) await removeAudioFile(item.id);
    }
    // Then everything else (the OpenAI key on this device stays as it is)
    BACKUP_KEYS.forEach(function (key) {
      if (key in backup.saved) {
        localStorage.setItem(key, backup.saved[key]);
      } else {
        localStorage.removeItem(key);
      }
    });
    location.reload(); // Start again with the restored data
  } catch {
    showBackupStatus("The backup couldn't be restored (maybe there isn't enough space). Please try again.");
  }
});


// ===== Remember what you were looking at =====
// The open tab, Practice/Immerse, Pure Text/Grammar Lens, the filters and the
// selected entry are saved quietly, so the page looks the same next time.
function saveView() {
  const openTab = document.querySelector(".tab.active");
  const openSubtab = document.querySelector(".subtab.active");
  const openView = document.querySelector("#immerse-options .selected");
  save("view", {
    tab: openTab.dataset.tab,
    subtab: openSubtab.dataset.subtab,
    immerseView: openView.dataset.view,
    filterLanguage: filterLanguage,
    audioFilterLanguage: audioFilterLanguage,
    openEntryGroup: openEntryGroup,
    // The selected entry is remembered by its text and language
    selectedEntry: selectedEntry ? { text: selectedEntry.text, language: selectedEntry.language } : null,
  }, true);
}

function restoreView() {
  const view = loadSaved("view", null);
  if (!view) return;

  if (document.getElementById(view.tab)) showTab(view.tab);
  if (document.getElementById(view.subtab)) showSubtab(view.subtab);
  if (document.getElementById(view.immerseView)) showImmerseView(view.immerseView);
  filterLanguage = view.filterLanguage ?? "all";
  audioFilterLanguage = view.audioFilterLanguage ?? "all";
  openEntryGroup = view.openEntryGroup ?? null;
  if (view.selectedEntry) {
    selectedEntry = sentences.find(function (sentence) {
      return sentence.text === view.selectedEntry.text && sentence.language === view.selectedEntry.language;
    }) || null;
  }
}


// ===== Start-up: show everything =====
restoreView();
showLevel();
fillLanguageMenu();
fillLanguageSelect(sentenceLanguage, myLanguage);
refreshAudioPickers(); // The Audio list shows the Add form's language
showSentences();
showTopicStatus();

