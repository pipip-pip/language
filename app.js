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
  audioTimings.delete(id);
  removeTiming(id); // Its word timing goes too
  return withAudioStore("readwrite", function (store) { return store.delete(id); })
    .catch(function () { /* Already gone: nothing to do */ });
}

// The exact word timing of a sound file (from OpenAI, see "Karaoke" below) is kept next to
// the file in the same storage, under the file's id + "#timing": [{ word, start, end }, …]
function timingKey(id) {
  return id + "#timing";
}
function storeTiming(id, words) {
  return withAudioStore("readwrite", function (store) { return store.put(words, timingKey(id)); });
}
function loadTiming(id) {
  return withAudioStore("readonly", function (store) { return store.get(timingKey(id)); });
}
function removeTiming(id) {
  return withAudioStore("readwrite", function (store) { return store.delete(timingKey(id)); })
    .catch(function () { /* Already gone: nothing to do */ });
}
// The timings in memory, so they're ready while playing: id → words (loaded at start-up)
const audioTimings = new Map();

// A new, unique name for a stored sound file
function newAudioId() {
  return "audio-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
}

// A file's name without its ending: "Lesson 3.MP3" → "Lesson 3".
// Only endings of sound files are removed, so a name like "Lesson 3.2" stays whole.
function nameWithoutExtension(name) {
  return name.replace(/\.(mp3|m4a|m4b|aac|wav|ogg|oga|opus|flac|wma|aif|aiff|webm|mp4|caf|amr)$/i, "") || name;
}

// The audio library: every sound file uploaded, stored once. Many sentences can use the same
// file, each with its own part (start and end time). Looks like: [{ id: "audio-...", name: "lesson" }]
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
  audioLibrary.push({ id: id, name: nameWithoutExtension(file.name), language: language || "", source: source, date: todayForDateBox() });
  saveAudioLibrary();
  showSaveMessage(true);
  // Get its exact word timing in the background (only with an API key; nothing waits for it)
  if (openaiKey) getExactTiming(id);
  return id;
}

// ===== Playing a part of a sound file =====
// Every part is played by playPart, so the times are exact on every device.
// iPhone's Safari jumps to the wrong place in many MP3 files. So we decode the whole file into
// plain sound samples first, and then "start" and "end" are simply positions in those samples.
//   Speed 1×: Web Audio plays the samples directly.
//   Other speeds: Web Audio would change the pitch of the voice, so the exact part is copied into
//   a small WAV file and played by an <audio> element, which keeps the pitch natural.
// Either way a part sounds the same: it plays a little past its end time, so the last sound isn't
// cut off, with a fade too tiny to hear at the very start and end, just to avoid a click.
// The saved start and end times never change; this is only how a part is played.
const TAIL_SECONDS = 0.25;
const CLICK_FADE_SECONDS = 0.01;
let audioContext = null;
const speedPlayer = new Audio(); // One <audio> element, used only for the other speeds
let speedPlayerUnlocked = false;

// Call this during a tap: iPhone only allows sound to start from a tap
function wakeUpAudio() {
  makeAudioContext();
  if (audioContext.state !== "running") {
    audioContext.resume().catch(function () { /* It's tried again on the next tap */ });
  }
  // A tiny silent sound during the first tap. After it, iPhone lets this element play later on too
  // (decoding takes a moment, and by then the tap would no longer count).
  if (!speedPlayerUnlocked) {
    speedPlayerUnlocked = true;
    speedPlayer.src = URL.createObjectURL(makeWav(audioContext.createBuffer(1, 441, audioContext.sampleRate), 0, 0.01));
    speedPlayer.play().catch(function () { /* Replaced by the real sound, or not allowed */ });
  }
}

// Make the Web Audio "player" once. (Making it without a tap is fine: it can decode files,
// it just stays silent until wakeUpAudio runs during a tap.)
function makeAudioContext() {
  if (!audioContext) {
    // Play even when the iPhone's silent switch is on (Safari 16.4 and newer)
    if (navigator.audioSession) navigator.audioSession.type = "playback";
    audioContext = new AudioContext();
  }
}

// Decoded files stay in memory, so each is only decoded once. They're big (a 10-minute stereo
// file takes about 200 MB), so above this size the file used longest ago is dropped;
// it's decoded again if it's needed again. Without this, a phone could close the page.
const DECODED_AUDIO_LIMIT = 300 * 1024 * 1024;
const decodedAudio = new Map(); // id → { decoding: a promise of the samples, size: in bytes }

function decodeAudioFile(id) {
  let saved = decodedAudio.get(id);
  if (saved) {
    // Move it to the end of the list: the end is the most recently used
    decodedAudio.delete(id);
    decodedAudio.set(id, saved);
    return saved.decoding;
  }
  saved = { size: 0, decoding: null };
  saved.decoding = loadAudioFile(id).then(function (file) {
    if (!file) throw new Error("The sound file for this sentence wasn't found on this device.");
    return file.arrayBuffer();
  }).then(function (bytes) {
    return audioContext.decodeAudioData(bytes);
  }).then(function (buffer) {
    saved.size = buffer.length * buffer.numberOfChannels * 4;
    dropOldDecodedAudio();
    return buffer;
  });
  saved.decoding.catch(function () { decodedAudio.delete(id); }); // Failed: try again next time
  decodedAudio.set(id, saved);
  return saved.decoding;
}

function dropOldDecodedAudio() {
  let total = 0;
  decodedAudio.forEach(function (saved) { total += saved.size; });
  for (const [id, saved] of decodedAudio) {
    if (total <= DECODED_AUDIO_LIMIT || decodedAudio.size === 1) break;
    total -= saved.size;
    decodedAudio.delete(id);
  }
}

// Copy a part of the decoded sound into a WAV file (one channel, to keep it small).
// A WAV starts exactly at its first sample, so there's no jumping for Safari to get wrong.
// The fades are written into the sound itself. fadeOutFrom = where the fade-out begins (optional).
function makeWav(buffer, from, to, fadeOutFrom) {
  const first = Math.floor(from * buffer.sampleRate);
  const count = Math.max(0, Math.min(Math.ceil(to * buffer.sampleRate), buffer.length) - first);
  const wav = new DataView(new ArrayBuffer(44 + count * 2));
  function writeText(place, text) {
    for (let i = 0; i < text.length; i++) wav.setUint8(place + i, text.charCodeAt(i));
  }
  // The 44-byte header that describes the sound
  writeText(0, "RIFF");
  wav.setUint32(4, 36 + count * 2, true);
  writeText(8, "WAVEfmt ");
  wav.setUint32(16, 16, true);
  wav.setUint16(20, 1, true); // Plain, uncompressed sound
  wav.setUint16(22, 1, true); // One channel
  wav.setUint32(24, buffer.sampleRate, true);
  wav.setUint32(28, buffer.sampleRate * 2, true);
  wav.setUint16(32, 2, true);
  wav.setUint16(34, 16, true);
  writeText(36, "data");
  wav.setUint32(40, count * 2, true);
  // The sound itself: stereo is mixed down to one channel
  const channels = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
  for (let i = 0; i < count; i++) {
    let sample = 0;
    channels.forEach(function (channel) { sample += channel[first + i]; });
    const time = from + i / buffer.sampleRate;
    let volume = Math.min(1, (time - from) / CLICK_FADE_SECONDS);
    if (time > fadeOutFrom) volume *= Math.max(0, (to - time) / (to - fadeOutFrom));
    sample = Math.max(-1, Math.min(1, volume * sample / channels.length));
    wav.setInt16(44 + i * 2, sample * 32767, true);
  }
  return new Blob([wav], { type: "audio/wav" });
}

// What's playing now (only ever one thing), or null
let currentPart = null;

// Start the sound of the current part from "from" (seconds in the file), in the right way for its speed
function startPartSound(part, from) {
  part.from = from;
  if (part.speed === 1) {
    const source = audioContext.createBufferSource();
    source.buffer = part.buffer;
    // The volume control does the fades
    const volume = audioContext.createGain();
    const now = audioContext.currentTime;
    const fadeOutAt = now + part.fadeOutFrom - from;
    if (from < part.fadeOutFrom) {
      volume.gain.setValueAtTime(0, now);
      volume.gain.linearRampToValueAtTime(1, now + Math.min(CLICK_FADE_SECONDS, part.fadeOutFrom - from));
      volume.gain.setValueAtTime(1, fadeOutAt);
    } else {
      // Carrying on in the middle of the tiny end fade (the speed was changed there)
      volume.gain.setValueAtTime((part.to - from) / (part.to - part.fadeOutFrom), now);
    }
    volume.gain.linearRampToValueAtTime(0, now + part.to - from);
    source.connect(volume);
    volume.connect(audioContext.destination);
    source.onended = function () { finishPart(part); };
    source.start(now, from, part.to - from);
    part.source = source;
    part.startedAt = now;
  } else {
    part.wavUrl = URL.createObjectURL(makeWav(part.buffer, from, part.to, part.fadeOutFrom));
    speedPlayer.src = part.wavUrl;
    setSpeedPlayerRate(part.speed);
    speedPlayer.onended = function () { finishPart(part); };
    speedPlayer.onerror = function () { failPart(part, "This sound file can't be played."); };
    speedPlayer.play().catch(function () { failPart(part, "Couldn't start the sound. Please tap play again."); });
  }
}

// Loading a new sound resets the speed to the default one, so both are set
// (webkitPreservesPitch is the older name Safari and iPhone use)
function setSpeedPlayerRate(speed) {
  speedPlayer.preservesPitch = true;
  speedPlayer.webkitPreservesPitch = true;
  speedPlayer.defaultPlaybackRate = speed;
  speedPlayer.playbackRate = speed;
}

// Silence the part. Its "ended" handlers are removed first, so stopping doesn't count as finishing.
function stopPartSound(part) {
  if (part.source) {
    part.source.onended = null;
    part.source.stop();
    part.source = null;
  }
  if (part.wavUrl) {
    speedPlayer.onended = null;
    speedPlayer.onerror = null;
    speedPlayer.pause();
    speedPlayer.removeAttribute("src");
    URL.revokeObjectURL(part.wavUrl); // Free the memory it used
    part.wavUrl = null;
  }
}

// The part reached its end
function finishPart(part) {
  if (currentPart !== part) return;
  stopPartSound(part);
  currentPart = null;
  if (part.whenEnded) part.whenEnded();
}

// The part couldn't play
function failPart(part, message) {
  if (currentPart !== part) return;
  stopPartSound(part);
  currentPart = null;
  if (part.whenFailed) part.whenFailed(message);
}

// Stop whatever part is playing (nothing happens if nothing is)
function stopPart() {
  const part = currentPart;
  if (!part) return;
  stopPartSound(part);
  currentPart = null;
  if (part.whenStopped) part.whenStopped();
}

// Play one sound file from "start" to "end" (seconds; end = null means to the end of the file).
// Anything already playing stops first, so two sounds never overlap.
// "handlers" can have: whenEnded(), whenStopped(), whenFailed(message).
async function playPart(audioId, start, end, speed, handlers) {
  stopPart();
  wakeUpAudio(); // Before the first "await", so it's still part of the tap
  const part = {
    speed: speed,
    whenEnded: handlers.whenEnded,
    whenStopped: handlers.whenStopped,
    whenFailed: handlers.whenFailed,
  };
  currentPart = part;
  try {
    part.buffer = await decodeAudioFile(audioId);
  } catch (error) {
    failPart(part, error.message.startsWith("The sound file") ? error.message : "This sound file can't be played.");
    return;
  }
  if (currentPart !== part) return; // Stopped while decoding
  const from = Math.max(0, start);
  // An end that's missing, too early or past the end of the file means "to the end of the file"
  const partEnd = end !== null && end > from && end < part.buffer.duration ? end : part.buffer.duration;
  if (from >= partEnd) {
    failPart(part, "This part starts after the end of the sound file.");
    return;
  }
  part.to = Math.min(partEnd + TAIL_SECONDS, part.buffer.duration); // The tail, but never past the file's end
  part.fadeOutFrom = Math.max(from, part.to - CLICK_FADE_SECONDS);
  startPartSound(part, from);
}

// A new speed in the middle of playing: carries on from the same place
function changePartSpeed(speed) {
  const part = currentPart;
  if (!part) return;
  wakeUpAudio(); // We may be changing from Web Audio to the <audio> element, or back
  const oldSpeed = part.speed;
  part.speed = speed;
  if (!part.source && !part.wavUrl) return; // Still decoding: it starts at the new speed
  if (oldSpeed !== 1 && speed !== 1) {
    setSpeedPlayerRate(speed); // The <audio> element can just change
    return;
  }
  const place = part.source
    ? part.from + audioContext.currentTime - part.startedAt
    : part.from + speedPlayer.currentTime;
  stopPartSound(part);
  startPartSound(part, Math.min(place, part.to - 0.01));
}

// A time as three number boxes: minutes : seconds : milliseconds  →  [1] : [23] : [250]
// Only numbers can be typed. Returns { element, get(), set(seconds), clear() }:
// get() gives the time in seconds (83.25), or null if all three boxes are empty.
// 65.25 seconds → "1:05:250" (the same m : s : ms as the boxes below, as plain text)
function timeLabel(seconds) {
  const total = Math.round(seconds * 1000);
  return Math.floor(total / 60000) + ":" + String(Math.floor(total / 1000) % 60).padStart(2, "0") +
    ":" + String(total % 1000).padStart(3, "0");
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
  row.append(minutesBox, separator(":"), secondsBox, separator(":"), millisecondsBox);

  function set(value) {
    // Each change tells the page the time changed (like typing does), so buttons that need a time can update
    if (value === null || value === undefined) {
      minutesBox.value = secondsBox.value = millisecondsBox.value = "";
      field.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
    const total = Math.round(value * 1000); // In milliseconds
    minutesBox.value = String(Math.floor(total / 60000));
    secondsBox.value = String(Math.floor(total / 1000) % 60).padStart(2, "0");
    millisecondsBox.value = String(total % 1000).padStart(3, "0");
    field.dispatchEvent(new Event("input", { bubbles: true }));
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
// YouTube links show "YouTube", others show the site's name, e.g. "example.com"
function sourceLabel(url) {
  const site = new URL(url).hostname.replace(/^(www|m)\./i, "");
  if (site === "youtube.com" || site === "youtu.be" || site.endsWith(".youtube.com")) {
    return "YouTube";
  }
  return site;
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

  // 🕒 Now: copies the player's current time (playing or paused) into Start, or into End
  // once Start has a time. Greyed out until an audio file is loaded.
  // aria-disabled instead of disabled, so its tooltip still shows when it can't be used.
  const nowButton = makeButton("Now", "small-button now-button", function () {
    if (nowButton.getAttribute("aria-disabled") === "true") return;
    const now = player.currentTime || 0;
    const start = startTime.get();
    if (start === null) {
      startTime.set(now);
      flashField(startTime.element);
    } else if (now <= start) {
      nowMessage.textContent = "End must be after start";
    } else {
      endTime.set(now);
      flashField(endTime.element);
    }
  });
  // A small clock drawn in the text colour, before the word
  nowButton.insertAdjacentHTML("afterbegin",
    '<svg class="now-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">' +
    '<circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.5"/>' +
    '<path d="M8 4.5V8l2.5 1.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>');
  const nowMessage = document.createElement("span");
  nowMessage.className = "hint now-message";
  nowMessage.setAttribute("role", "status"); // Read out by screen readers
  // The field that just changed lights up briefly, so it's clear which one it was
  function flashField(field) {
    nowMessage.textContent = "";
    field.classList.add("time-flash");
    setTimeout(function () { field.classList.remove("time-flash"); }, 900);
  }
  function updateNowButton() {
    const ready = player.readyState > 0; // The file is loaded and knows its length
    nowButton.setAttribute("aria-disabled", String(!ready));
    nowButton.dataset.tip = ready ? "Use the current audio time" : "Select an audio first";
    nowButton.setAttribute("aria-label", nowButton.dataset.tip);
  }
  ["loadedmetadata", "emptied"].forEach(function (event) {
    player.addEventListener(event, updateNowButton);
  });
  updateNowButton();
  addTooltip(nowButton);
  times.append(nowButton, nowMessage);

  // Where the player is now, and how long the file is, in the same m : s : ms boxes,
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
  // Listening here stops the Study tab's audio, so two sounds never play at once
  player.addEventListener("play", function () { stopAudio(); });
  player.addEventListener("play", function tick() {
    showClock();
    if (!player.paused) requestAnimationFrame(tick);
  });

  // Three buttons to check the times by ear:
  //   ▶ Play this part: from Start to End
  //   ▶ Check start: the first 2 seconds after Start
  //   ▶ Check end: the last 2 seconds before End, so you hear exactly where it stops
  // Only one plays at a time; the playing one turns into "■ Stop".
  const CHECK_SECONDS = 2;
  let playingButton = null;
  function resetPlayingButton() {
    if (playingButton) playingButton.textContent = playingButton.dataset.label;
    playingButton = null;
  }
  // Plays the audio from "from" to "to" (seconds; to = null means to the end of the file)
  function playRange(button, from, to) {
    const wasThisOne = playingButton === button;
    player.pause(); // The small player and a part never play together
    stopPart();
    if (wasThisOne) return; // Pressing "■ Stop" just stops
    playingButton = button;
    button.textContent = "■ Stop";
    playPart(selected, from, to, 1, {
      whenEnded: resetPlayingButton,
      whenStopped: resetPlayingButton,
      whenFailed: function (message) {
        resetPlayingButton();
        nowMessage.textContent = message;
      },
    });
  }
  // A small button that remembers its own label, so it can go back to it after "■ Stop"
  function checkButton(label, onClick) {
    const button = makeButton(label, "small-button", function () { onClick(button); });
    button.dataset.label = label;
    return button;
  }
  const playThisPart = checkButton("▶ Play this part", function (button) {
    playRange(button, startTime.get() || 0, endTime.get());
  });
  const checkStart = checkButton("▶ Check start", function (button) {
    const start = startTime.get() || 0;
    const end = endTime.get();
    // Stop after 2 seconds, or at End if the part is shorter than that
    const stop = end !== null && end > start ? Math.min(end, start + CHECK_SECONDS) : start + CHECK_SECONDS;
    playRange(button, start, stop);
  });
  const checkEnd = checkButton("▶ Check end", function (button) {
    const start = startTime.get() || 0;
    // An empty End means the end of the file
    const end = endTime.get() !== null ? endTime.get() : (isFinite(player.duration) ? player.duration : null);
    if (end === null) return; // File still loading: nothing to check yet
    // Start 2 seconds before End, but never before Start
    playRange(button, Math.max(start, end - CHECK_SECONDS), end);
  });
  const checks = document.createElement("div");
  checks.className = "audio-checks";
  checks.append(playThisPart, checkStart, checkEnd);
  // Check start / Check end only work once that time has been typed in (greyed out until then)
  function updateChecks() {
    checkStart.disabled = startTime.get() === null;
    checkEnd.disabled = endTime.get() === null;
  }
  startTime.element.addEventListener("input", updateChecks);
  endTime.element.addEventListener("input", updateChecks);
  updateChecks();

  // Use the whole audio: Start at 0:00:000 and End at the file's full length,
  // so the times are the same as in the original recording.
  // A short line next to the button says what it does, and then what it just did.
  const WHOLE_HINT = "Sets Start to the beginning and End to the very end of the file.";
  const wholeHint = document.createElement("span");
  wholeHint.className = "hint";
  wholeHint.textContent = WHOLE_HINT;
  const wholeFile = makeButton("Use the whole audio", "small-button", function () {
    startTime.set(0);
    if (isFinite(player.duration)) {
      endTime.set(player.duration);
      wholeHint.textContent = "✓ Done: Start 0:00:000, End " + timeLabel(player.duration) + ".";
    } else {
      // Length not known yet (file still loading): an empty End also means "to the end"
      endTime.set(null);
      wholeHint.textContent = "✓ Done: Start 0:00:000, End left empty (= to the end).";
    }
  });
  // Typing a new time by hand: show the explanation again
  times.addEventListener("input", function () {
    wholeHint.textContent = WHOLE_HINT;
    nowMessage.textContent = "";
  });
  const whole = document.createElement("div");
  whole.className = "audio-whole";
  whole.append(wholeFile, wholeHint);

  part.append(player, clock, times, whole, checks);

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
    if (playingButton) stopPart();
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
      choice.append(new Option(item.name, item.id));
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
    // Without a link, the source is added when the sentence is added, or in the Audio tab → Edit.
    const id = await addToAudioLibrary(file, languageSelect.value, source);
    if (id) {
      selected = id;
      refreshAudioPickers(); // The new file appears in every picker's list
      showAudioLibrary(); // And in the Audio tab
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
    // Stop the small player (a player taken off the page would otherwise keep playing)
    stop: function () {
      player.pause();
      if (playingButton) stopPart();
    },
  };
}

// The pickers on the page (the Add form's, and the Edit form's while one is open),
// so both can show a newly uploaded file
let addAudioPicker = null;
let editAudioPicker = null;

// Closing the Edit form (Save, Cancel or redrawing the list): stop its player first
function closeEditAudioPicker() {
  if (editAudioPicker) editAudioPicker.stop();
  editAudioPicker = null;
}

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
    : "Couldn't save. Private browsing, or storage full? Changes will be lost when you leave.";
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
  requestAnimationFrame(fitStudyPanels);
  tabButtons.forEach(function (button) {
    const isThisOne = button.dataset.tab === tabId;
    button.classList.toggle("active", isThisOne);
    document.getElementById(button.dataset.tab).hidden = !isThisOne;
  });
  showTextToggles(); // Long sentences can only be measured once their tab is on screen
}

tabButtons.forEach(function (button) {
  button.addEventListener("click", function () {
    // Leaving a tab closes any open Edit form (unsaved changes are dropped)
    if (editingIndex !== null) { editingIndex = null; showSentences(); }
    if (editingAudioId !== null) { editingAudioId = null; showAudioLibrary(); }
    // Going to another tab stops all sound
    if (document.getElementById(button.dataset.tab).hidden) stopAllSound();
    showTab(button.dataset.tab);
    saveView();
  });
});


// ----- Smaller tabs inside Study: Practice and Immerse -----
const subtabButtons = document.querySelectorAll(".subtab");

// Show one of them (e.g. "immerse-panel") and hide the other
function showSubtab(panelId) {
  requestAnimationFrame(fitStudyPanels);
  subtabButtons.forEach(function (button) {
    const isThisOne = button.dataset.subtab === panelId;
    button.classList.toggle("active", isThisOne);
    document.getElementById(button.dataset.subtab).hidden = !isThisOne;
  });
}

subtabButtons.forEach(function (button) {
  button.addEventListener("click", function () {
    if (document.getElementById(button.dataset.subtab).hidden) stopAllSound();
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


// --- The language button: one design, used at the top of Study and in the sentence forms ---
// The parts every language button shares: opening, closing, the keyboard and screen readers.

function setDropdownOpen(dropdown, open) {
  dropdown.classList.toggle("open", open);
  dropdown.querySelector("button").setAttribute("aria-expanded", String(open));
}

// Keyboard users land on the chosen language in the list (or the first one if none is chosen)
function focusChosenItem(menu) {
  const item = menu.querySelector("li.selected") || menu.querySelector("li");
  if (item) item.focus();
}

function setUpDropdown(dropdown, button, menu) {
  button.setAttribute("aria-haspopup", "listbox");
  button.setAttribute("aria-expanded", "false");
  menu.setAttribute("role", "listbox");

  // On a touch screen, tapping the button opens and closes the list.
  // "detail" is 0 when Enter, Space or a screen reader pressed it instead of a mouse or finger:
  // those need it to open on a computer too, where a mouse just hovers over the button.
  button.addEventListener("click", function (event) {
    if (!canHover || event.detail === 0) {
      setDropdownOpen(dropdown, !dropdown.classList.contains("open"));
    }
    if (event.detail === 0 && dropdown.classList.contains("open")) {
      focusChosenItem(menu);
    }
  });

  // The up and down arrows open the list too
  button.addEventListener("keydown", function (event) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setDropdownOpen(dropdown, true);
      focusChosenItem(menu);
    }
  });

  // Inside the list: arrows, Home and End move, Enter or Space chooses, Escape closes, Tab leaves
  menu.addEventListener("keydown", function (event) {
    const items = Array.from(menu.querySelectorAll("li"));
    const here = items.indexOf(event.target);
    let next = null;
    if (event.key === "ArrowDown") next = items[Math.min(here + 1, items.length - 1)];
    if (event.key === "ArrowUp") next = items[Math.max(here - 1, 0)];
    if (event.key === "Home") next = items[0];
    if (event.key === "End") next = items[items.length - 1];

    if (next) {
      event.preventDefault();
      next.focus();
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault(); // Enter must not send the form
      event.target.click();
      button.focus();
    } else if (event.key === "Escape") {
      setDropdownOpen(dropdown, false);
      button.focus();
    } else if (event.key === "Tab") {
      setDropdownOpen(dropdown, false);
    }
  });
}

// Fill a language list with the languages ticked in Settings.
// Choosing one calls pick(language); what that changes is up to each button.
function fillLanguageItems(dropdown, menu, chosen, pick) {
  menu.innerHTML = "";

  function addItem(text, className, onClick) {
    const item = document.createElement("li");
    item.textContent = text;
    item.className = className;
    item.tabIndex = -1; // Reached with the arrow keys, not with Tab
    item.setAttribute("role", "option");
    item.setAttribute("aria-selected", String(className === "selected"));
    item.addEventListener("click", function () {
      setDropdownOpen(dropdown, false);
      onClick();
    });
    menu.append(item);
  }

  if (myLanguages.length === 0) {
    // Nothing ticked yet: offer a shortcut to Settings
    addItem("Add languages in Settings", "hint-item", function () {
      showTab("settings-tab");
    });
    return;
  }

  myLanguages.forEach(function (language) {
    addItem(languageLabel(language), language === chosen ? "selected" : "", function () {
      pick(language);
    });
  });
}

// Tapping anywhere else closes an open list. "pointerdown" as well as "click",
// because iPhone Safari sends no click when you tap an empty part of the page.
function closeOtherDropdowns(event) {
  document.querySelectorAll(".dropdown.open").forEach(function (dropdown) {
    if (!dropdown.contains(event.target)) {
      setDropdownOpen(dropdown, false);
    }
  });
}
document.addEventListener("click", closeOtherDropdowns);
document.addEventListener("pointerdown", closeOtherDropdowns);


// --- The language button at the top of Study ---
const languageDropdown = document.getElementById("language-dropdown");
const languageButton = document.getElementById("language-button");
const languageName = document.getElementById("language-name");
const languageMenu = document.getElementById("language-menu");

const pageTitle = document.getElementById("page-title");

// Fill the language list with the languages ticked in Settings
function fillLanguageMenu() {
  languageName.textContent = myLanguage ? languageLabel(myLanguage) : "Choose language";
  languageButton.setAttribute("aria-label", "Language: " + languageName.textContent);

  // The big title (and the browser tab's name) show the chosen language
  // The name gets its own span, so a theme can give it a metallic fill without hiding the flag
  const titleName = document.createElement("span");
  titleName.className = "page-title-text";
  titleName.textContent = myLanguage || "Language Study";
  pageTitle.replaceChildren(titleName);
  // The flag gets its own span too, so it's the same size in every theme
  if (LANGUAGE_FLAGS[myLanguage]) {
    const titleFlag = document.createElement("span");
    titleFlag.className = "page-title-flag";
    titleFlag.textContent = LANGUAGE_FLAGS[myLanguage];
    pageTitle.append(titleFlag);
  }
  document.title = myLanguage ? languageLabel(myLanguage) : "Video Study";

  fillLanguageItems(languageDropdown, languageMenu, myLanguage, function (language) {
    myLanguage = language;
    saveMyLanguage();
    fillLanguageMenu();
    resetAddFormLanguage(); // New sentences start in this language too
    refreshAudioPickers(); // So the Audio list shows this language's files
    showEntries(); // Study only shows entries in this language
  });
}

setUpDropdown(languageDropdown, languageButton, languageMenu);


// --- The language button in a sentence form ---
// It looks and works just like Study's, but only changes the form's own hidden language box,
// so Study's language stays as it is. The box also tells the audio list and the Source
// suggestions when the language changes.
function makeLanguagePicker(select) {
  const dropdown = document.createElement("div");
  dropdown.className = "dropdown";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "language-button";
  const name = document.createElement("span");
  button.append(name, " ▾");

  const menu = document.createElement("ul");
  menu.className = "dropdown-menu";
  dropdown.append(button, menu);
  setUpDropdown(dropdown, button, menu);

  // Show the language that's in the box right now
  function show() {
    const chosen = select.value;
    name.textContent = chosen ? languageLabel(chosen) : "Choose language";
    button.setAttribute("aria-label", "Language of this entry: " + name.textContent);
    fillLanguageItems(dropdown, menu, chosen, function (language) {
      select.value = language;
      select.dispatchEvent(new Event("change"));
      show();
    });
  }
  show();

  return { element: dropdown, show: show };
}


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

// The Add form starts in the language chosen in Study
function resetAddFormLanguage() {
  fillLanguageSelect(sentenceLanguage, myLanguage);
  addLanguagePicker.show();
}

// Refresh everything that lists your languages (after a change in Settings)
function updateLanguageLists() {
  fillLanguageMenu();
  resetAddFormLanguage();
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

// Tidies pasted or typed text: no spaces at the start or end of a line, one space between words
// (tabs and double spaces become one), and no empty lines in between.
// oneLine = true joins the lines with a space (an entry being edited is one piece of text);
// otherwise each sentence stays on its own line, right under the one before (the Add box).
function tidyText(text, oneLine) {
  return text
    .split(/\r\n|\r|\n/)
    .map(function (line) { return line.replace(/[^\S\n]+/g, " ").trim(); })
    .filter(function (line) { return line !== ""; })
    .join(oneLine ? " " : "\n");
}

// Pasting into a text box puts in the tidied text instead of the original, where the cursor is
function tidyWhenPasted(box, oneLine) {
  box.addEventListener("paste", function (event) {
    const pasted = event.clipboardData && event.clipboardData.getData("text/plain");
    if (!pasted) {
      return; // Nothing we can read (e.g. a picture): let the browser paste as usual
    }
    event.preventDefault();
    let tidy = tidyText(pasted, oneLine);
    // Pasting in the middle of a line: keep a space between the old and the new words
    const before = box.value.slice(0, box.selectionStart);
    if (oneLine && tidy && before !== "" && !/\s$/.test(before)) {
      tidy = " " + tidy;
    }
    box.setRangeText(tidy, box.selectionStart, box.selectionEnd, "end");
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

tidyWhenPasted(sentenceInput, false);

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
//   { id: "entry-...", text: "Merhaba", language: "Turkish", topics: ["Greetings"], ownTopics: [],
//     source: "YouTube", date: "2026-10-27" }
// "topics" are all its topics. "ownTopics" are the ones you typed yourself,
// which are kept whenever the automatic topics are found again.
// Older sentences may be plain text, have no language, or have a single "topic".
// Turn them into the new shape.
// A new, unique name for a sentence. It never changes, even when other sentences are added or deleted.
function newEntryId() {
  return "entry-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
}

let sentenceIdsAdded = false;
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
  // Sentences from before ids existed (or from an older backup) get one now
  if (!sentence.id) {
    sentence.id = newEntryId();
    sentenceIdsAdded = true;
  }
  return { language: "", ...sentence };
});
if (sentenceIdsAdded) save("sentences", sentences, true);

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

// A ▾ button inside a Source box that opens a list of the sources used before in that
// form's language (from sentences and audio files; links are left out), styled like the language list.
// Choosing one copies it into the box.
function addSourceSuggestions(sourceBox, languageSelect) {
  // Wrap the box, so the button can sit inside its right end and the list can open under it
  const dropdown = document.createElement("div");
  dropdown.className = "dropdown source-dropdown";
  sourceBox.before(dropdown);

  const button = document.createElement("button");
  button.type = "button";
  button.className = "source-button";
  button.textContent = "▾";
  button.setAttribute("aria-label", "Choose an earlier source");
  button.setAttribute("aria-haspopup", "listbox");
  button.setAttribute("aria-expanded", "false");

  const menu = document.createElement("ul");
  menu.className = "dropdown-menu";
  menu.setAttribute("role", "listbox");
  dropdown.append(sourceBox, button, menu);

  function fill() {
    const language = languageSelect.value;
    const found = [];
    sentences.concat(audioLibrary).forEach(function (item) {
      const source = (item.source || "").trim();
      if (item.language === language && source && !webAddress(source) && !found.includes(source)) found.push(source);
    });
    menu.innerHTML = "";
    found.sort().forEach(function (source) {
      const item = document.createElement("li");
      item.textContent = source;
      item.tabIndex = -1;
      item.setAttribute("role", "option");
      item.classList.toggle("selected", source === sourceBox.value.trim());
      item.addEventListener("click", function (event) {
        event.preventDefault(); // Inside a label: don't let the click jump anywhere else
        setDropdownOpen(dropdown, false);
        sourceBox.value = source;
        // Tell the rest of the form (e.g. the audio picker) that the source changed
        sourceBox.dispatchEvent(new Event("input", { bubbles: true }));
        sourceBox.dispatchEvent(new Event("change", { bubbles: true }));
        sourceBox.focus();
      });
      menu.append(item);
    });
    button.hidden = found.length === 0; // Nothing to choose yet: no button
    if (found.length === 0) setDropdownOpen(dropdown, false);
  }
  fill();
  languageSelect.addEventListener("change", fill);

  // Tapping or clicking ▾ opens and closes the list (on a computer too: hover would get in the way of typing)
  button.addEventListener("click", function (event) {
    event.preventDefault();
    const open = !dropdown.classList.contains("open");
    if (open) fill(); // So sources added a moment ago are there too
    setDropdownOpen(dropdown, open);
    if (open && event.detail === 0) focusChosenItem(menu); // Opened with the keyboard
  });

  // Keyboard inside the list: arrows move, Enter chooses, Escape closes
  menu.addEventListener("keydown", function (event) {
    const items = Array.from(menu.querySelectorAll("li"));
    const here = items.indexOf(event.target);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next = items[Math.max(0, Math.min(items.length - 1, here + (event.key === "ArrowDown" ? 1 : -1)))];
      if (next) next.focus();
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      event.target.click();
    } else if (event.key === "Escape") {
      setDropdownOpen(dropdown, false);
      button.focus();
    }
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

// Names saved with their ending (older files, or a restored older backup): remove the ending.
// This also runs right after a restore, because a restore reloads the page.
audioLibrary.forEach(function (item) {
  const cleanName = nameWithoutExtension(item.name);
  if (cleanName !== item.name) {
    item.name = cleanName;
    libraryChanged = true;
  }
});
if (libraryChanged) saveAudioLibrary();

// The Audio picker in the Add form
addAudioPicker = makeAudioPicker({}, sentenceLanguage, sourceInput);
document.getElementById("add-audio").append(addAudioPicker.element);
addSourceSuggestions(sourceInput, sentenceLanguage);

// The Add form's language button: in the "Add sentences" box, just above the sentence box
const addLanguagePicker = makeLanguagePicker(sentenceLanguage);
sentenceForm.before(addLanguagePicker.element);

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
      // Its sound file stays in the library (other sentences may use it); delete files in Settings
      forgetKnownWords(sentences[index]); // Its known words go with it
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
  tidyWhenPasted(textBox, true);

  // The hidden box holds this entry's language. A language no longer ticked in Settings
  // stays in it, so the button can still show it and saving doesn't lose it.
  const languageBox = document.createElement("select");
  languageBox.hidden = true;
  fillLanguageSelect(languageBox, sentence.language, sentence.language);
  const languagePicker = makeLanguagePicker(languageBox);

  const sourceBox = document.createElement("input");
  sourceBox.type = "text";
  sourceBox.placeholder = "Source";
  sourceBox.value = sentence.source;

  // No topic or date boxes: they're kept as they are (topics are found again on Save)
  const details = document.createElement("div");
  details.className = "sentence-details";
  details.append(languagePicker.element, languageBox, sourceBox);
  addSourceSuggestions(sourceBox, languageBox); // After append, so the list can go next to the box

  // Audio: the same picker as in the Add form, showing this sentence's file and part
  editAudioPicker = makeAudioPicker(sentence, languageBox, sourceBox);

  const saveButton = document.createElement("button");
  saveButton.type = "submit";
  saveButton.textContent = "Save";

  const cancelButton = makeButton("Cancel", "small-button", function () {
    editingIndex = null;
    closeEditAudioPicker();
    stopAudio(); // Closing the form stops any audio too
    showSentences();
  });

  const buttons = document.createElement("div");
  buttons.className = "edit-buttons";
  buttons.append(saveButton, cancelButton);

  form.append(textBox, details, editAudioPicker.element, buttons);

  form.addEventListener("submit", async function (event) {
    event.preventDefault();
    const newText = tidyText(textBox.value, true); // Typed extra spaces or line breaks are tidied too
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
    closeEditAudioPicker();
    // The Study tab may be playing this sentence's old audio part: stop it
    stopAudio();
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
// and "No language" if some items don't have one. Used by My sentences and My audio.
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
  closeEditAudioPicker(); // The old Edit form is about to be removed (a new one is made if still editing)
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

  // Everything in the box becomes ONE entry: line breaks are joined with a space,
  // just like in the Edit box (and extra spaces are tidied away)
  const text = tidyText(sentenceInput.value, true);
  const newSentences = text === "" ? [] : [text];

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
      id: newEntryId(),
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
  // Saving stops any audio: the form's small player and the Study tab's repeats (the speed stays)
  addAudioPicker.stop();
  stopAudio();
  if (added.length > 0) giveAudioTheLink(added[0]);

  saveSentences();
  showSentences();
  added.forEach(updateTopics); // Find the best topics by meaning, in the background

  // Empty the form for the next entry: sentence, source and audio.
  // A language chosen here was only for this entry, so it goes back to Study's language.
  sentenceInput.value = "";
  sourceInput.value = "";
  addAudioPicker.reset();
  resetAddFormLanguage();
  addAudioPicker.refresh(); // The audio list follows the language
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

// ===== Currently learning: up to 3 entries per language you're working on =====
const LEARNING_MAX = 3;
let learningIds = loadSaved("learningIds", []);
const learningHolder = document.getElementById("learning-holder");
const learningList = document.getElementById("learning-list");
const learningEmpty = document.getElementById("learning-empty");
const learningFull = document.getElementById("learning-full");

// The learning entries in the chosen language (entries deleted since are skipped)
function learningEntries() {
  return learningIds
    .map(function (id) { return sentences.find(function (sentence) { return sentence.id === id; }); })
    .filter(function (sentence) { return sentence && sentence.language === myLanguage; });
}

function isLearning(sentence) {
  return learningIds.includes(sentence.id);
}

// Add or remove an entry. Adding a 4th in the same language shows a message instead.
function toggleLearning(sentence) {
  learningFull.hidden = true;
  if (isLearning(sentence)) {
    learningIds = learningIds.filter(function (id) { return id !== sentence.id; });
  } else if (learningEntries().length >= LEARNING_MAX) {
    learningFull.hidden = false;
    return;
  } else {
    learningIds.push(sentence.id);
  }
  // Forget ids of entries that no longer exist
  learningIds = learningIds.filter(function (id) {
    return sentences.some(function (sentence) { return sentence.id === id; });
  });
  save("learningIds", learningIds, true);
  showEntries();
}

// The small Learn / Remove button on an entry
function makeLearnButton(sentence, label) {
  const button = makeButton(label, "small-button learn-button", function (event) {
    event.stopPropagation(); // Don't select or unselect the entry
    toggleLearning(sentence);
  });
  button.classList.toggle("learning", isLearning(sentence));
  return button;
}

function showLearning() {
  learningList.innerHTML = "";
  const hasEntries = myLanguage && sentences.some(function (sentence) { return sentence.language === myLanguage; });
  learningHolder.hidden = !hasEntries;
  if (!hasEntries) return;
  const list = learningEntries();
  learningEmpty.hidden = list.length > 0;
  if (list.length < LEARNING_MAX) learningFull.hidden = true;
  document.getElementById("learning-count").textContent = list.length + " / " + LEARNING_MAX;
  list.forEach(function (sentence, index) {
    const item = document.createElement("li");
    item.classList.toggle("selected", sentence === selectedEntry);
    item.title = sentence.text; // The whole entry on hover
    const number = document.createElement("span");
    number.className = "learning-number";
    number.textContent = index + 1;
    // One line, cut with "…" (the full entry shows in Practice and Immerse once selected)
    const text = document.createElement("span");
    text.className = "learning-text";
    text.textContent = sentence.text;
    const remove = makeLearnButton(sentence, "×");
    remove.setAttribute("aria-label", "Remove from Currently learning");
    remove.dataset.tip = "Remove";
    item.append(number, text, remove);
    item.addEventListener("click", function () {
      selectedEntry = selectedEntry === sentence ? null : sentence;
      showEntries();
      saveView();
    });
    learningList.append(item);
  });
}

function showEntries() {
  showImmerse(); // Immerse shows the selected entry, so keep it up to date too
  showLearning();
  entryList.innerHTML = "";

  if (!myLanguage) {
    noEntries.textContent = "Choose a language at the top to see your entries.";
    noEntries.hidden = false;
    return;
  }

  const matching = sentences.filter(function (sentence) {
    return sentence.language === myLanguage;
  });

  if (matching.length === 0) {
    noEntries.textContent = "No entries in " + languageLabel(myLanguage) + " yet. Add some in the Sentences tab.";
    noEntries.hidden = false;
    return;
  }
  noEntries.hidden = true;

  // Put the entries in groups: one per named source (whatever audio file they use),
  // then one per audio file for entries whose source is a link (or empty), then one per link
  // without audio, plus "Without source". Names that differ only in capitals or spaces match.
  const groups = {};
  const sourceNames = {}; // The name to show for each source group (as it was first typed)
  matching.forEach(function (sentence) {
    const source = (sentence.source || "").trim().replace(/\s+/g, " ");
    let groupId = "none";
    if (source && !webAddress(source)) {
      groupId = "source:" + source.toLowerCase();
      if (!sourceNames[groupId]) sourceNames[groupId] = source;
    } else if (sentence.audioId && audioFileName(sentence.audioId)) {
      groupId = sentence.audioId;
    } else if (source) {
      groupId = "source:" + source.toLowerCase();
      if (!sourceNames[groupId]) sourceNames[groupId] = source;
    }
    if (!groups[groupId]) groups[groupId] = [];
    groups[groupId].push(sentence);
  });
  const hasAudio = function (groupId) {
    return groups[groupId].some(function (sentence) { return audioFileName(sentence.audioId); });
  };
  const groupName = function (groupId) {
    return sourceNames[groupId] || entryGroupName(groupId);
  };
  const audioGroupIds = newestFirst(audioLibrary, audioLibrary)
    .map(function (item) { return item.id; })
    .filter(function (id) { return groups[id]; });
  const sourceGroupIds = Object.keys(groups)
    .filter(function (id) { return id.startsWith("source:"); })
    .sort(function (a, b) { return groupName(a).localeCompare(groupName(b)); });
  const groupIds = audioGroupIds.concat(sourceGroupIds, groups.none ? ["none"] : []);

  // Only one group (e.g. no audio and no sources): just the list of entries, no groups needed
  if (groupIds.length === 1) {
    showGroupEntries(groups[groupIds[0]], hasAudio(groupIds[0]));
    return;
  }
  if (openEntryGroup && !groups[openEntryGroup]) openEntryGroup = null;

  if (openEntryGroup) {
    // Inside a group: a way back, then its entries
    const back = document.createElement("li");
    back.className = "entry-back";
    back.textContent = "← All groups";
    back.addEventListener("click", function () {
      openEntryGroup = null;
      showEntries();
      saveView();
    });
    const title = document.createElement("span");
    title.className = "entry-group-title";
    title.textContent = groupName(openEntryGroup);
    back.append(title);
    entryList.append(back);
    // Audio groups are in audio order; the others newest first
    showGroupEntries(groups[openEntryGroup], hasAudio(openEntryGroup));
    return;
  }

  // The groups: each audio file (newest first), then each source (A–Z), then "Without source"
  groupIds.forEach(function (groupId) {
    const item = document.createElement("li");
    item.className = "entry-group";
    // The group with the selected entry is marked, so it's easy to find again
    item.classList.toggle("selected", groups[groupId].includes(selectedEntry));
    const name = document.createElement("span");
    name.className = "entry-group-name";
    name.textContent = groupName(groupId);
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

// The name shown for a group in Select entry.
// Audio file: its source if that's a name (e.g. "Pan Tadeusz"), or the file's name if the
// source is a link (a link is long and says little). Other groups: the source itself.
function entryGroupName(groupId) {
  if (groupId === "none") return "Without source";
  if (groupId.startsWith("source:")) return groupId.slice("source:".length);
  const file = audioLibrary.find(function (entry) { return entry.id === groupId; });
  const source = file ? (file.source || "").trim() : "";
  return source && !webAddress(source) ? source : audioFileName(groupId);
}

// The entries of one group, numbered. With audio: in the order they come in the audio,
// each showing its part (start – end). Without audio: the newest first, with the date.
// Long entries show two lines; the selected one is shown in full.
function showGroupEntries(list, byTime) {
  // With audio: file by file (oldest file first), each in audio order; entries without audio last
  const fileOrder = function (sentence) {
    const place = audioLibrary.findIndex(function (item) { return item.id === sentence.audioId; });
    return place === -1 ? Infinity : place;
  };
  const ordered = byTime
    ? list.slice().sort(function (a, b) {
      return (fileOrder(a) - fileOrder(b)) ||
        (a.audioStart ?? Infinity) - (b.audioStart ?? Infinity) || sentences.indexOf(a) - sentences.indexOf(b);
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

    // The button comes first so it floats to the top right
    item.append(makeLearnButton(sentence, isLearning(sentence) ? "Learning ✓" : "Learn"), label, text);
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
  if (viewId === "word-focus") {
    showWordFocus(); // The words of the selected entry and their meanings (asks GPT if needed)
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
    markSentences(pureTextSentence, selectedEntry); // A small "?" after each sentence
  } else {
    pureTextSentence.textContent = "Select an entry above to read it here.";
    pureTextSentence.classList.add("hint");
  }

  stopAudioIfEntryChanged(); // A different entry: stop reading the old one
  refreshFollowAlong(); // Karaoke: the "estimated" note, and the timing worked out again after edits
  closeExplanationIfEntryChanged(); // ...and close the old entry's explanation

  // If Grammar Lens is open, show the (newly) selected entry there too
  if (!document.getElementById("grammar-lens").hidden) {
    showGrammarLens();
  }
  // The same for Word Focus
  if (!document.getElementById("word-focus").hidden) {
    showWordFocus();
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
const loopButtons = document.querySelectorAll("#audio-controls .loop-button");
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

// Playback speed: 0.5× to 1.5×, remembered like the loops. It stays the same for every repeat.
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5];
let audioSpeed = Number(loadSaved("audioSpeed", 1));
if (!SPEEDS.includes(audioSpeed)) audioSpeed = 1;
const speedGroup = document.getElementById("audio-speed");

function showSpeeds() {
  speedGroup.querySelectorAll("button").forEach(function (button) {
    const chosen = Number(button.dataset.speed) === audioSpeed;
    button.classList.toggle("selected", chosen);
    button.setAttribute("aria-pressed", chosen);
  });
}

SPEEDS.forEach(function (speed) {
  const button = makeButton(speed + "×", "filter-button speed-button", function () {
    audioSpeed = speed;
    save("audioSpeed", audioSpeed);
    showSpeeds();
    changePartSpeed(speed); // Changes straight away, even in the middle of playing
  });
  button.dataset.speed = speed;
  button.setAttribute("aria-label", "Playback speed " + speed + "×");
  button.dataset.tip = "Playback speed " + speed + "×";
  speedGroup.append(button);
});
showSpeeds();
save("audioPause", null, true); // A setting that no longer exists: tidy it away

// ===== Tooltips =====
// Buttons with a data-tip get a small bubble above them saying what they do:
// on a computer when the mouse is over them (or they get keyboard focus),
// on a touch screen when you press and hold (a long-press doesn't also press the button).
const tooltip = document.createElement("div");
tooltip.className = "tooltip";
tooltip.setAttribute("aria-hidden", "true"); // The buttons' aria-labels already say the same thing
tooltip.hidden = true;
document.body.append(tooltip);
let tooltipTimer = null;
let longPressed = false;

function showTooltip(button) {
  tooltip.textContent = button.dataset.tip;
  tooltip.hidden = false;
  // Centred above the button, but never off the edge of the screen
  const place = button.getBoundingClientRect();
  const left = place.left + place.width / 2 - tooltip.offsetWidth / 2;
  tooltip.style.left = Math.max(8, Math.min(left, window.innerWidth - tooltip.offsetWidth - 8)) + "px";
  tooltip.style.top = (place.top - tooltip.offsetHeight - 6) + "px";
}
function hideTooltip() {
  clearTimeout(tooltipTimer);
  tooltip.hidden = true;
}

document.querySelectorAll("#audio-controls [data-tip]").forEach(addTooltip);
window.addEventListener("scroll", hideTooltip, { passive: true });

function addTooltip(button) {
  button.addEventListener("mouseenter", function () { if (canHover) showTooltip(button); });
  button.addEventListener("mouseleave", hideTooltip);
  button.addEventListener("focus", function () { if (button.matches(":focus-visible")) showTooltip(button); });
  button.addEventListener("blur", hideTooltip);
  // Press and hold for half a second on a touch screen
  button.addEventListener("pointerdown", function (event) {
    if (event.pointerType !== "touch") return;
    longPressed = false;
    clearTimeout(tooltipTimer);
    tooltipTimer = setTimeout(function () {
      longPressed = true;
      showTooltip(button);
      tooltipTimer = setTimeout(hideTooltip, 1500); // Goes away by itself
    }, 500);
  });
  ["pointerup", "pointercancel"].forEach(function (name) {
    button.addEventListener(name, function () { if (!longPressed) clearTimeout(tooltipTimer); });
  });
  // After a long-press, the finger lifting shouldn't count as a tap
  button.addEventListener("click", function (event) {
    if (longPressed) {
      longPressed = false;
      event.stopImmediatePropagation();
    }
  }, true);
  // The play button's words change (Play / Stop): keep an open bubble up to date
  button.addEventListener("click", function () {
    if (!tooltip.hidden) showTooltip(button);
  });
}

// Show the speaker or stop icon, and "3 / 10" while playing
function showAudioState() {
  audioPlay.innerHTML = audioPlaying ? STOP_ICON : SPEAKER_ICON;
  const label = audioPlaying ? "Stop" : "Play";
  audioPlay.setAttribute("aria-label", label);
  audioPlay.dataset.tip = label;
  audioPlay.classList.toggle("playing", audioPlaying);

  if (audioPlaying) {
    const total = audioLoops === "infinite" ? "∞" : audioLoops;
    audioCount.textContent = Math.min(audioTimesPlayed + 1, Number(audioLoops) || Infinity) + " / " + total
      + (audioEntry.audioId || !speakingVoiceName ? "" : " · " + speakingVoiceName); // Which voice is reading
  } else {
    audioCount.textContent = "";
  }
}

// The short wait before the next repeat
let repeatTimer = null;

function stopAudio() {
  audioPlaying = false;
  audioEntry = null;
  clearTimeout(repeatTimer);
  if ("speechSynthesis" in window) {
    speechSynthesis.cancel();
  }
  stopPart();
  showAudioState();
}

// The same, and the small players in the Add and Edit forms too
function stopAllSound() {
  stopAudio();
  document.querySelectorAll("audio").forEach(function (player) { player.pause(); });
}

// After each play: play again after a tiny gap until the chosen number of times, then stop
const REPEAT_GAP_SECONDS = 0.7; // At speed 1×. It stretches with the speed, so it feels the same at every speed
function playedOnce(playAgain) {
  if (!audioPlaying) return;
  audioTimesPlayed++;
  const finished = audioLoops !== "infinite" && audioTimesPlayed >= Number(audioLoops);
  if (finished) {
    stopAudio();
  } else {
    // The counter only moves on when the next round starts
    repeatTimer = setTimeout(function () {
      showAudioState();
      playAgain();
    }, REPEAT_GAP_SECONDS / audioSpeed * 1000);
  }
}

// Play the sentence's part of its sound file: from its start time to its end time
// (the whole file if no times were set)
// from (optional): start at this time instead, e.g. a tapped word. Repeats start at the beginning again.
function playRecording(entry, from) {
  const start = from === undefined ? entry.audioStart || 0 : from;
  const end = entry.audioEnd === undefined ? null : entry.audioEnd;
  playPart(entry.audioId, start, end, audioSpeed, {
    // The part is over: play it again (at the speed chosen by then) until the chosen number of times
    whenEnded: function () {
      playedOnce(function () { playRecording(entry); });
    },
    whenFailed: function (message) {
      stopAudio();
      audioCount.textContent = message;
    },
  });
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
// speakFrom: where in the text to start (a tapped word); only for the first round
let speakFrom = 0;
function speakOnce() {
  if (!audioPlaying) return;

  const offset = speakFrom;
  speakFrom = 0;
  const utterance = new SpeechSynthesisUtterance(audioEntry.text.slice(offset));
  // Follow along: the voice says which word it's starting (on most devices)
  spokenWordIndex = -1;
  utterance.onboundary = function (event) {
    if (event.name === "word") spokenWordIndex = wordIndexAtChar(audioEntry, offset + event.charIndex);
  };
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
  // A little slower than normal, for learning, times the chosen speed.
  // (The device voice can't change speed mid-sentence, so a new speed starts with the next repeat.)
  utterance.rate = 0.9 * audioSpeed;

  utterance.onend = function () { spokenWordIndex = -1; playedOnce(speakOnce); };
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
  startListening(selectedEntry);
});

// Start playing an entry (from the play button, or from a tapped word).
// fromSeconds / fromChar (optional): start at a word instead of the beginning.
function startListening(entry, fromSeconds, fromChar) {
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
  startFollowing(); // The karaoke highlight (and its scrolling) starts afresh

  if (entry.audioId) {
    playRecording(entry, fromSeconds); // The sentence's own MP3
  } else {
    speechSynthesis.cancel(); // Clear anything left over
    speakFrom = fromChar || 0;
    // The device's voice. Speak straight away if the voices are there (iPhone needs that);
    // otherwise wait a moment for them to load.
    if (speechSynthesis.getVoices().length > 0) {
      speakOnce();
    } else {
      voicesReady().then(speakOnce);
    }
  }
}

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


// ===== Immerse: karaoke follow-along =====
// While an entry plays, the word being said gets a soft underline or glow (the theme decides).
// The exact time of every word comes from OpenAI's whisper-1, asked once per audio file and kept
// with the file. Then each entry's own words are matched to those times. Without them (no key,
// no internet…), the times are estimated from the word lengths, so it still works.

const TIMING_ERROR = "Couldn't get exact timing. Check your connection or API key in Settings.";
const WHISPER_LIMIT_BYTES = 24 * 1024 * 1024; // OpenAI accepts up to 25 MB: stay a little under
const WHISPER_FILE_TYPES = /\.(mp3|mp4|mpeg|mpga|m4a|wav|webm|ogg|oga|flac)$/i; // What OpenAI can read
const PART_SECONDS = 600;    // Bigger files are sent in parts of about 10 minutes…
const OVERLAP_SECONDS = 2;   // …that overlap by 2 seconds, so no word is cut in half
const SPEECH_RATE = 16000;   // Parts are sent as 16 kHz WAV: plenty for speech, and 10 min ≈ 19 MB

// The state of each file's job: id → { state: "working" | "failed", note }
const timingState = new Map();
const timingJobs = new Map(); // id → the running job (so a file is never asked about twice at once)

// Read the saved timings into memory (at start-up)
async function loadAllTimings() {
  for (const item of audioLibrary) {
    try {
      const words = await loadTiming(item.id);
      if (Array.isArray(words)) audioTimings.set(item.id, words);
    } catch { /* Nothing saved: estimated timing is used */ }
  }
  showAllTimingStatus();
  refreshFollowAlong();
}

// The language code OpenAI wants, e.g. "Polish" → "pl"
function whisperLanguage(language) {
  const code = SPEECH_LANGUAGES[language];
  return code ? code.slice(0, 2) : "";
}

// Send one sound file to OpenAI and get back every word with its start and end time
async function askWhisper(file, fileName, languageCode) {
  const form = new FormData();
  form.append("file", file, fileName);
  form.append("model", "whisper-1"); // The model that can give the time of each word
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "word");
  if (languageCode) form.append("language", languageCode);
  let response;
  try {
    response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { "Authorization": "Bearer " + openaiKey },
      body: form,
    });
  } catch {
    throw new Error(TIMING_ERROR);
  }
  if (!response.ok) throw new Error(TIMING_ERROR);
  const data = await response.json();
  return (data.words || [])
    .filter(function (word) { return typeof word.word === "string" && isFinite(word.start) && isFinite(word.end); })
    .map(function (word) { return { word: word.word.trim(), start: word.start, end: word.end }; });
}

// A part of the decoded sound as a small WAV: one channel at 16 kHz
function makeSpeechWav(buffer, from, to) {
  const step = buffer.sampleRate / SPEECH_RATE; // How many original samples make one new one
  const first = Math.floor(from * buffer.sampleRate);
  const count = Math.max(0, Math.floor((Math.min(to, buffer.duration) - from) * SPEECH_RATE));
  const wav = new DataView(new ArrayBuffer(44 + count * 2));
  const writeText = function (place, text) {
    for (let i = 0; i < text.length; i++) wav.setUint8(place + i, text.charCodeAt(i));
  };
  writeText(0, "RIFF");
  wav.setUint32(4, 36 + count * 2, true);
  writeText(8, "WAVEfmt ");
  wav.setUint32(16, 16, true);
  wav.setUint16(20, 1, true);
  wav.setUint16(22, 1, true);
  wav.setUint32(24, SPEECH_RATE, true);
  wav.setUint32(28, SPEECH_RATE * 2, true);
  wav.setUint16(32, 2, true);
  wav.setUint16(34, 16, true);
  writeText(36, "data");
  wav.setUint32(40, count * 2, true);
  const channels = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
  for (let i = 0; i < count; i++) {
    // The average of the original samples it covers (mixed to one channel), which also softens hiss
    const a = first + Math.floor(i * step);
    const b = Math.min(buffer.length, Math.max(a + 1, first + Math.floor((i + 1) * step)));
    let sum = 0;
    for (const channel of channels) {
      for (let j = a; j < b; j++) sum += channel[j];
    }
    const sample = Math.max(-1, Math.min(1, sum / ((b - a) * channels.length) || 0));
    wav.setInt16(44 + i * 2, sample * 32767, true);
  }
  return new Blob([wav], { type: "audio/wav" });
}

// The quietest moment between two times (so a part ends in a pause, not in the middle of a word)
function quietestMoment(buffer, from, to) {
  const data = buffer.getChannelData(0);
  const windowSize = Math.floor(buffer.sampleRate * 0.3);
  let best = to;
  let bestLoudness = Infinity;
  for (let start = Math.floor(from * buffer.sampleRate); start + windowSize < to * buffer.sampleRate; start += windowSize / 2) {
    let loudness = 0;
    for (let i = start; i < start + windowSize; i += 4) loudness += data[i] * data[i];
    if (loudness < bestLoudness) {
      bestLoudness = loudness;
      best = (start + windowSize / 2) / buffer.sampleRate;
    }
  }
  return best;
}

// A big file (or one OpenAI can't read): cut it into parts at quiet moments, ask about each part,
// move each part's times to their place in the whole file, and join them.
// Where two parts overlap, words are taken from the first part before the cut and from the next one after it,
// so no word appears twice.
async function transcribeInParts(id, languageCode, showProgress) {
  makeAudioContext();
  const buffer = await decodeAudioFile(id);
  const cuts = [];
  let place = 0;
  while (place + PART_SECONDS < buffer.duration - 5) {
    const cut = quietestMoment(buffer, place + PART_SECONDS - 30, place + PART_SECONDS);
    cuts.push(cut);
    place = cut;
  }
  const edges = [0].concat(cuts, [buffer.duration]);
  const words = [];
  for (let i = 0; i < edges.length - 1; i++) {
    showProgress(edges.length > 2 ? "part " + (i + 1) + " of " + (edges.length - 1) : "");
    const from = Math.max(0, edges[i] - (i > 0 ? OVERLAP_SECONDS / 2 : 0));
    const to = Math.min(buffer.duration, edges[i + 1] + OVERLAP_SECONDS / 2);
    const partWords = await askWhisper(makeSpeechWav(buffer, from, to), "part.wav", languageCode);
    partWords.forEach(function (word) {
      const start = word.start + from;
      const isLast = i === edges.length - 2;
      // Only the words that start in this part's own stretch (from one cut to the next)
      if (start >= edges[i] && (isLast || start < edges[i + 1])) {
        words.push({ word: word.word, start: start, end: word.end + from });
      }
    });
  }
  return words;
}

// Get the exact word timing for one audio file (in the background). Returns when it's done.
function getExactTiming(id) {
  if (timingJobs.has(id)) return timingJobs.get(id);
  const job = (async function () {
    const item = audioLibrary.find(function (other) { return other.id === id; });
    if (!item) return;
    timingState.set(id, { state: "working", note: "" });
    showTimingStatus(id);
    try {
      if (!openaiKey) throw new Error(TIMING_ERROR);
      const file = await loadAudioFile(id);
      if (!file) throw new Error("The sound file isn't on this device.");
      const fileName = file.name || item.name + ".mp3";
      const languageCode = whisperLanguage(item.language);
      let words;
      if (file.size <= WHISPER_LIMIT_BYTES && WHISPER_FILE_TYPES.test(fileName)) {
        words = await askWhisper(file, fileName, languageCode); // Small enough: send it as it is
      } else {
        words = await transcribeInParts(id, languageCode, function (note) {
          timingState.set(id, { state: "working", note: note });
          showTimingStatus(id);
        });
      }
      await storeTiming(id, words);
      audioTimings.set(id, words);
      timingState.delete(id);
    } catch (error) {
      timingState.set(id, { state: "failed", note: error.message === TIMING_ERROR ? "" : error.message });
    }
    timingJobs.delete(id);
    showTimingStatus(id);
    refreshFollowAlong(); // Its entries now follow the exact timing
  })();
  timingJobs.set(id, job);
  return job;
}

// The timing line under a file in the Audio tab: "Getting timing…", "Exact timing ready" or the error
function fillTimingStatus(box, item) {
  box.textContent = "";
  const state = timingState.get(item.id);
  const text = document.createElement("span");
  if (state && state.state === "working") {
    text.textContent = "Getting timing…" + (state.note ? " (" + state.note + ")" : "");
    box.append(text);
  } else if (state && state.state === "failed") {
    text.className = "error-text";
    text.textContent = state.note ? "Couldn't get exact timing: " + state.note : TIMING_ERROR;
    box.append(text, makeButton("Try again", "small-button", function () { getExactTiming(item.id); }));
  } else if (audioTimings.has(item.id)) {
    text.textContent = "✓ Exact timing ready";
    box.append(text);
  } else {
    box.append(makeButton("Get exact timing", "small-button", function () { getExactTiming(item.id); }));
  }
}

function showTimingStatus(id) {
  const item = audioLibrary.find(function (other) { return other.id === id; });
  document.querySelectorAll(".audio-timing").forEach(function (box) {
    if (item && box.dataset.timingFor === id) fillTimingStatus(box, item);
  });
}

function showAllTimingStatus() {
  audioLibrary.forEach(function (item) { showTimingStatus(item.id); });
}

// Settings: get the timing for every audio that doesn't have it yet, one after another
const timingAllButton = document.getElementById("timing-all");
const timingAllStatus = document.getElementById("timing-all-status");
timingAllButton.addEventListener("click", async function () {
  const missing = audioLibrary.filter(function (item) { return !audioTimings.has(item.id); });
  timingAllStatus.hidden = false;
  if (missing.length === 0) {
    timingAllStatus.textContent = "Every audio already has exact timing.";
    return;
  }
  if (!openaiKey) {
    timingAllStatus.textContent = "Add your OpenAI API key above first.";
    return;
  }
  timingAllButton.disabled = true;
  let failed = 0;
  for (let i = 0; i < missing.length; i++) {
    timingAllStatus.textContent = "Getting timing… " + (i + 1) + " of " + missing.length;
    await getExactTiming(missing[i].id);
    if (!audioTimings.has(missing[i].id)) failed++;
  }
  timingAllStatus.textContent = (missing.length - failed) + " of " + missing.length + " ready." +
    (failed > 0 ? " " + TIMING_ERROR : "");
  timingAllButton.disabled = false;
});

// ----- Matching the transcript's words to an entry's own words -----

// The words of a text, with where each one is: [{ from, to }] (positions in the text)
const WORD_PATTERN = /[\p{L}\p{M}\p{N}]+(?:['’\-][\p{L}\p{M}\p{N}]+)*/gu;
function splitWords(text) {
  return Array.from(text.matchAll(WORD_PATTERN), function (match) {
    return { from: match.index, to: match.index + match[0].length };
  });
}

// A word made plain for comparing: no capitals, accents or punctuation ("Żółw," → "zołw")
function plainWord(word) {
  return word.normalize("NFKC").toLocaleLowerCase().normalize("NFD").replace(/[^\p{L}\p{N}]/gu, "");
}

// How many letters must change to turn one word into the other
function editDistance(a, b) {
  let previous = Array.from({ length: b.length + 1 }, function (_, i) { return i; });
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = row;
  }
  return previous[b.length];
}

// 1 = the same word, 0 = nothing alike
function wordLikeness(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  return 1 - editDistance(a, b) / Math.max(a.length, b.length);
}

// Line up the entry's words with the heard words, keeping both in order (like a "diff").
// Small spelling differences still match; heard words before or after the entry cost nothing
// (they belong to the entries around it). Returns, for each entry word, the heard word's number or -1.
const SIMILAR_ENOUGH = 0.6;
function lineUpWords(mine, heard) {
  const n = mine.length;
  const m = heard.length;
  const score = [];
  const move = [];
  for (let i = 0; i <= n; i++) {
    score.push(new Float64Array(m + 1));
    move.push(new Uint8Array(m + 1)); // 1 = matched, 2 = entry word skipped, 3 = heard word skipped
    for (let j = 0; j <= m; j++) {
      if (i === 0) { score[i][j] = 0; move[i][j] = 3; continue; }
      if (j === 0) { score[i][j] = score[i - 1][0] - 0.5; move[i][j] = 2; continue; }
      const likeness = wordLikeness(mine[i - 1], heard[j - 1]);
      const pair = score[i - 1][j - 1] + (likeness >= SIMILAR_ENOUGH ? 1 + likeness : -1);
      const skipMine = score[i - 1][j] - 0.5;
      const skipHeard = score[i][j - 1] - 0.3;
      if (pair >= skipMine && pair >= skipHeard) { score[i][j] = pair; move[i][j] = 1; }
      else if (skipMine >= skipHeard) { score[i][j] = skipMine; move[i][j] = 2; }
      else { score[i][j] = skipHeard; move[i][j] = 3; }
    }
  }
  // Heard words after the entry are free too: end wherever the score is best
  let j = 0;
  for (let k = 1; k <= m; k++) if (score[n][k] > score[n][j]) j = k;
  const matches = new Array(n).fill(-1);
  let i = n;
  while (i > 0) {
    const step = j === 0 ? 2 : move[i][j];
    if (step === 1) {
      if (wordLikeness(mine[i - 1], heard[j - 1]) >= SIMILAR_ENOUGH) matches[i - 1] = j - 1;
      i--; j--;
    } else if (step === 2) {
      i--;
    } else {
      j--;
    }
  }
  return matches;
}

// Share a stretch of time between some words, by their length.
// pauses (optional): extra room after a word with a comma or full stop.
function shareTime(words, text, from, to, pauses) {
  const weights = words.map(function (word) {
    let weight = word.to - word.from;
    if (pauses) {
      const after = text.slice(word.to, word.to + 3);
      if (/^\s*[.!?…]/.test(after)) weight += 4;
      else if (/^\s*[,;:—–]/.test(after)) weight += 2;
    }
    return weight;
  });
  const total = weights.reduce(function (a, b) { return a + b; }, 0) || 1;
  let time = from;
  words.forEach(function (word, i) {
    const length = (to - from) * weights[i] / total;
    // The pause is the end of the word's share: the word itself is said in the first part
    const spoken = (to - from) * (word.to - word.from) / total;
    word.start = time;
    word.end = time + (pauses ? spoken : length);
    time += length;
  });
}

// The timing of every word of an entry: { words: [{ from, to, start, end }], estimated }.
// Worked out again only when the text, start/end or the file's timing change (no OpenAI request).
const timingCache = new Map(); // entry id → { key, result }
function entryTiming(entry) {
  const heardAll = audioTimings.get(entry.audioId) || null;
  const start = entry.audioStart || 0;
  let end = entry.audioEnd;
  if (end === undefined || end === null) {
    // The whole file: its length, if known
    const playing = currentPart && currentPart.buffer;
    end = playing ? playing.duration : heardAll && heardAll.length ? heardAll[heardAll.length - 1].end : null;
  }
  const key = entry.text + "|" + start + "|" + end;
  const saved = timingCache.get(entry.id);
  if (saved && saved.key === key && saved.heard === heardAll) return saved.result;

  const words = splitWords(entry.text);
  if (end === null) end = start + entry.text.length * 0.07; // Unknown: about a normal speaking speed
  let estimated = true;
  if (heardAll && words.length > 0) {
    // The heard words inside the entry's part, with a second to spare on each side
    const heard = heardAll.filter(function (word) { return word.end > start - 1 && word.start < end + 1; });
    const matches = lineUpWords(
      words.map(function (word) { return plainWord(entry.text.slice(word.from, word.to)); }),
      heard.map(function (word) { return plainWord(word.word); }));
    if (matches.some(function (match) { return match >= 0; })) {
      estimated = false;
      words.forEach(function (word, i) {
        if (matches[i] >= 0) {
          word.start = heard[matches[i]].start;
          word.end = heard[matches[i]].end;
        }
      });
      // Words that weren't matched: share the time between the matched words around them
      let i = 0;
      while (i < words.length) {
        if (matches[i] >= 0) { i++; continue; }
        let k = i;
        while (k < words.length && matches[k] < 0) k++;
        const from = i > 0 ? words[i - 1].end : start;
        const to = k < words.length ? words[k].start : Math.max(end, from);
        shareTime(words.slice(i, k), entry.text, from, Math.max(from, to), false);
        i = k;
      }
    }
  }
  if (estimated) shareTime(words, entry.text, start, end, true);
  const result = { words: words, estimated: estimated };
  timingCache.set(entry.id, { key: key, heard: heardAll, result: result });
  return result;
}

// Which word is being said at this time in the file (-1 = none yet)
function wordIndexAtTime(timing, time) {
  let index = -1;
  for (let i = 0; i < timing.words.length; i++) {
    if (timing.words[i].start <= time) index = i;
    else break;
  }
  return index;
}

// Which word is at this place in the text (for the device voice)
function wordIndexAtChar(entry, place) {
  const words = splitWords(entry.text);
  for (let i = words.length - 1; i >= 0; i--) {
    if (words[i].from <= place) return i;
  }
  return -1;
}

// ----- Drawing the words, so each one can light up and be tapped -----

// Wrap each word of the entry inside a sentence box in <span class="kara-word" data-word="3">.
// It works on whatever is already drawn there (plain text, or nouns coloured by gender),
// so the gender colours stay. Buttons inside (and anything marked data-no-words) are skipped.
function markWords(container, entry) {
  const nodes = [];
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode: function (node) {
      return node.parentElement.closest("button, [data-no-words]") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
    },
  });
  while (walker.nextNode()) nodes.push(walker.currentNode);
  if (nodes.map(function (node) { return node.data; }).join("") !== entry.text) return; // Something else is shown
  const words = splitWords(entry.text);
  let offset = 0;
  let w = 0;
  nodes.forEach(function (node) {
    const text = node.data;
    const nodeStart = offset;
    offset += text.length;
    const pieces = [];
    let position = 0;
    while (w < words.length && words[w].from < offset) {
      const word = words[w];
      const a = Math.max(word.from, nodeStart) - nodeStart;
      const b = Math.min(word.to, offset) - nodeStart;
      if (a > position) pieces.push(text.slice(position, a));
      const span = document.createElement("span");
      span.className = "kara-word";
      span.dataset.word = w;
      span.textContent = text.slice(a, b);
      pieces.push(span);
      position = b;
      if (word.to <= offset) w++;
      else break; // The word carries on in the next piece of text
    }
    if (pieces.length > 0) {
      if (position < text.length) pieces.push(text.slice(position));
      node.replaceWith.apply(node, pieces);
    }
  });
  shownWord = null; // Draw the highlight again on the new words
}

// The sentence boxes are redrawn in several places (Pure Text, Grammar Lens…). Watching them
// means the words are marked after every redraw, whatever drew it.
const karaokeBoxes = [pureTextSentence, document.getElementById("grammar-sentence")];
const karaokeWatcher = new MutationObserver(function () {
  karaokeBoxes.forEach(function (box) {
    const entry = selectedEntry;
    if (!entry || box.classList.contains("hint") || box.querySelector(".kara-word")) return;
    markWords(box, entry);
  });
});
karaokeBoxes.forEach(function (box) {
  karaokeWatcher.observe(box, { childList: true, subtree: true, characterData: true });
  // Tap a word: play from it
  box.addEventListener("click", function (event) {
    const word = event.target.closest(".kara-word");
    if (word) playFromWord(Number(word.dataset.word));
  });
});

function playFromWord(index) {
  const entry = selectedEntry;
  if (!entry || !sentences.includes(entry) || entry.language !== myLanguage) return;
  if (entry.audioId) {
    const timing = entryTiming(entry);
    const word = timing.words[index];
    if (!word) return;
    const from = Math.max(0, word.start - 0.05); // A hair early, so its first sound isn't cut
    if (audioPlaying && audioEntry === entry) {
      clearTimeout(repeatTimer); // Jump within the current round
      showAudioState();
      startFollowing();
      playRecording(entry, from);
    } else {
      stopAudio();
      startListening(entry, from);
    }
  } else {
    stopAudio();
    startListening(entry, undefined, splitWords(entry.text)[index].from);
  }
}

// ----- The highlight itself -----

const followButton = document.getElementById("follow-along");
let followAlong = loadSaved("followAlong", true);

// The HIGHLIGHT row: On or Off, like the REPEAT and SPEED rows
const followChoices = followButton.querySelectorAll("button");
function showFollowButton() {
  followChoices.forEach(function (button) {
    const chosen = (button.dataset.follow === "on") === followAlong;
    button.classList.toggle("selected", chosen);
    button.setAttribute("aria-pressed", chosen);
  });
}
followChoices.forEach(function (button) {
  addTooltip(button); // Hover (or press and hold) to see what it does
  button.addEventListener("click", function () {
    followAlong = button.dataset.follow === "on";
    save("followAlong", followAlong);
    showFollowButton();
    refreshFollowAlong();
  });
});
showFollowButton();

const karaokeNote = document.getElementById("karaoke-note");
let spokenWordIndex = -1; // The device voice's current word
let shownWord = null;     // The word lit up now (null = draw again)
let litUp = [];           // The elements lit up now
let followFrame = null;
let userScrolled = false; // Stop following the words with the scroll once the user scrolls

// Where the sound is now, in seconds from the start of the file (null = nothing playing)
function playbackTime() {
  const part = currentPart;
  if (!part || !part.buffer) return null;
  if (part.source) {
    const delay = audioContext.outputLatency || audioContext.baseLatency || 0; // Sound takes a moment to reach the speaker
    return part.from + (audioContext.currentTime - part.startedAt) * part.speed - delay;
  }
  if (part.wavUrl) return part.from + speedPlayer.currentTime;
  return null;
}

// Light up one word (-1 = none). Only changes the page when the word changes, so nothing flickers.
function showWord(index) {
  if (index === shownWord) return;
  shownWord = index;
  litUp.forEach(function (element) {
    element.classList.remove("kara-current");
    element.removeAttribute("aria-current");
  });
  litUp = [];
  if (index < 0 || !audioEntry) return;
  document.querySelectorAll('#immerse-panel .kara-word[data-word="' + index + '"]').forEach(function (element) {
    litUp.push(element);
  });
  // Word Focus: the card that holds this word
  const word = splitWords(audioEntry.text)[index];
  if (word && !document.getElementById("word-focus").hidden) {
    const lowerText = audioEntry.text.toLocaleLowerCase();
    let searchFrom = 0;
    document.querySelectorAll("#word-list .word-card").forEach(function (card) {
      const written = card.querySelector(".word-written");
      if (!written) return;
      const place = lowerText.indexOf(written.textContent.toLocaleLowerCase(), searchFrom);
      if (place < 0) return;
      searchFrom = place + 1;
      if (word.from >= place && word.from < place + written.textContent.length) litUp.push(card);
    });
  }
  litUp.forEach(function (element) {
    element.classList.add("kara-current");
    element.setAttribute("aria-current", "true");
  });
  if (litUp.length > 0) keepInView(litUp[0]);
}

// Phone: scroll gently so the word stays on screen (unless the user has scrolled themselves)
function keepInView(element) {
  if (userScrolled || !window.matchMedia("(max-width: 600px)").matches) return;
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const behavior = reduceMotion ? "auto" : "smooth";
  const place = element.getBoundingClientRect();
  const area = element.closest(".panel-scroll");
  if (area && area.scrollHeight > area.clientHeight + 1) {
    const box = area.getBoundingClientRect();
    if (place.top < box.top + 24 || place.bottom > box.bottom - 24) {
      area.scrollBy({ top: place.top - box.top - box.height / 3, behavior: behavior });
      return;
    }
  }
  const screenHeight = window.visualViewport ? window.visualViewport.height : window.innerHeight;
  if (place.top < 24 || place.bottom > screenHeight - 24) {
    window.scrollBy({ top: place.top - screenHeight / 3, behavior: behavior });
  }
}
["wheel", "touchmove"].forEach(function (name) {
  window.addEventListener(name, function () { if (audioPlaying) userScrolled = true; }, { passive: true });
});

// Every screen frame while playing: find the word at the sound's position and light it up
function followTick() {
  followFrame = null;
  if (!audioPlaying || !followAlong || !audioEntry || audioEntry !== selectedEntry) {
    showWord(-1);
    return;
  }
  if (audioEntry.audioId) {
    const time = playbackTime();
    showWord(time === null ? -1 : wordIndexAtTime(entryTiming(audioEntry), time));
  } else {
    showWord(spokenWordIndex);
  }
  followFrame = requestAnimationFrame(followTick);
}

// Playing started (or jumped to a word): follow again, scroll again
function startFollowing() {
  userScrolled = false;
  spokenWordIndex = -1;
  shownWord = null;
  if (!followFrame) followFrame = requestAnimationFrame(followTick);
}

// Something changed (the entry, its timing, the toggle): update the "estimated" note and the highlight
function refreshFollowAlong() {
  const entry = selectedEntry;
  const showNote = followAlong && entry && entry.audioId && sentences.includes(entry) &&
    entry.language === myLanguage && entryTiming(entry).estimated;
  karaokeNote.hidden = !showNote;
  if (showNote) {
    const state = timingState.get(entry.audioId);
    karaokeNote.textContent = state && state.state === "working"
      ? "Word timing: estimated (getting exact timing…)"
      : "Word timing: estimated";
  }
  shownWord = null;
  if (audioPlaying && !followFrame) followFrame = requestAnimationFrame(followTick);
}


// ===== Settings: themes =====
// Each theme's colours and fonts are in style.css. This list gives each one a name.
// The first theme is used when none has been chosen yet.
// The first one is used until another is chosen
const THEMES = [
  {
    id: "riviera",
    name: "Honey Coconut Hour",
  },
  {
    id: "coffee",
    name: "Cold Brew Coffee",
  },
  {
    id: "matcha",
    name: "Kyoto Iced Matcha",
  },
  {
    id: "rosewater",
    name: "Peach Rosewater",
  },
  {
    id: "cosmopolitan",
    name: "Bubblegum Bling",
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


// ===== Audio tab: audio files =====
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
    noAudioFiles.textContent = "No audio files yet. Add one with the Audio box in the Sentences tab.";
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
    name.textContent = item.name;
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
        decodedAudio.delete(item.id); // Free its memory too
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
    // Exact word timing for the karaoke: its state, or a button to get it
    const timing = document.createElement("div");
    timing.className = "audio-timing";
    timing.dataset.timingFor = item.id;
    fillTimingStatus(timing, item);
    main.append(name, source, count, timing);

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
    throw new Error("Couldn't get an answer from OpenAI. Check your internet connection, and that the API key in Settings → OpenAI is correct.");
  }

  const data = await response.json();
  if (response.ok) {
    return data.choices[0].message.content;
  }
  if (response.status === 401) throw new Error("The API key wasn't accepted. Check it in Settings → OpenAI.");
  if (response.status === 404) throw new Error("OpenAI doesn't know the model \"" + openaiModel + "\". Check it in Settings → OpenAI.");
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
const genderLegend = document.getElementById("gender-legend");

// The small key above the sentence: one sample per gender the language has,
// in the same colours and underlines as the nouns ("masculine  feminine  neuter").
// Hidden when nothing is selected or the language has no genders (English, Turkish).
function showGenderLegend(language) {
  genderLegend.textContent = "";
  const genders = language ? (NOUN_GENDERS[language] || ["masculine", "feminine", "neuter"]) : [];
  genders.forEach(function (gender) {
    const sample = document.createElement("span");
    sample.className = "noun " + gender;
    sample.textContent = gender;
    genderLegend.append(sample);
  });
  genderLegend.hidden = genders.length === 0;
}

let grammarBeingFound = null; // The sentence waiting for GPT's answer (so it's only asked once)

function showGrammarStatus(message) {
  grammarStatus.textContent = message;
  grammarStatus.hidden = !message;
}

// Saved results without this format number came from the older nouns-only question:
// they're asked for again when Grammar Lens is opened.
const GRAMMAR_FORMAT = 2;

// Find the nouns of a sentence and their genders. GPT labels every word, so we can check that it
// looked at all of them. If it missed some, ask once more; the second answer is used either way.
// Then only the nouns are kept: [{ word: "kawa", base: "kawa", type: "noun", gender: "feminine" }, ...]
async function findNounGenders(sentence) {
  let words = await askForWordGenders(sentence);
  if (!wordsCoverText(sentence.text, words)) {
    words = await askForWordGenders(sentence);
  }
  return words.filter(function (item) {
    return item.type === "noun" && item.gender !== "none";
  });
}

// The answer must follow a fixed shape:
// { words: [{ word: "kawa", base: "kawa", type: "noun", gender: "feminine" }, ...] }
async function askForWordGenders(sentence) {
  const answer = await askOpenai({
    model: openaiModel,
    temperature: 0, // So the answer stays steady
    messages: [
      {
        role: "system",
        content:
          "You are a careful linguist. Go through the user's text and return every word, in order, leaving out " +
          "only punctuation. If a word appears twice, list it twice. For each word:\n" +
          "word: exactly as written in the text (same letters, same ending, same capitals).\n" +
          "base: its dictionary form (nominative singular for nouns).\n" +
          "type: \"noun\" or \"other\".\n" +
          "gender: for a noun, masculine, feminine or neuter; for any other word, \"none\". " +
          "For Polish, masculine personal, animate and inanimate are all masculine.\n" +
          "A plural noun has the gender of its singular dictionary form, e.g. rzeczy → rzecz → feminine, " +
          "pędzle → pędzel → masculine. Proper names that are nouns (like \"Kicia Kocia\") are nouns and get " +
          "their gender too. Verbs, adjectives and participles are never nouns, even when they have a feminine " +
          "or masculine ending (e.g. \"umówiła\", \"malarski\"): their type is \"other\" and their gender \"none\".",
      },
      {
        role: "user",
        content: "Language: " + (sentence.language || "unknown") + "\nText: " + sentence.text,
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
            words: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  word: { type: "string" },
                  base: { type: "string" },
                  type: { type: "string", enum: ["noun", "other"] },
                  gender: { type: "string", enum: ["masculine", "feminine", "neuter", "none"] },
                },
                required: ["word", "base", "type", "gender"],
                additionalProperties: false,
              },
            },
          },
          required: ["words"],
          additionalProperties: false,
        },
      },
    },
  });
  return JSON.parse(answer).words;
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
  showGenderLegend(visible ? entry.language : null);

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
    markSentences(grammarSentence, entry);
    showGrammarStatus(languageLabel(entry.language) + " nouns don't have grammatical gender, so there's nothing to colour.");
    return;
  }

  // Already found earlier for this exact text: show it straight away (no new request)
  const haveGrammar = entry.grammar && entry.grammar.text === entry.text;
  if (haveGrammar && entry.grammar.format === GRAMMAR_FORMAT) {
    drawColouredSentence(entry.text, entry.grammar.nouns);
    markSentences(grammarSentence, entry);
    showGrammarStatus(entry.grammar.nouns.length === 0 ? "No nouns with a gender found in this sentence." : "");
    return;
  }

  // An older result stays on screen until the new one arrives (or if a new one can't be made)
  if (haveGrammar) {
    drawColouredSentence(entry.text, entry.grammar.nouns);
  } else {
    grammarSentence.textContent = entry.text;
  }
  markSentences(grammarSentence, entry);
  if (!openaiKey) {
    showGrammarStatus("Add your OpenAI API key in Settings → OpenAI to use Grammar Lens.");
    return;
  }
  if (grammarBeingFound === entry) {
    return; // Already asking GPT about this sentence
  }

  showGrammarStatus("Finding the nouns…");
  grammarBeingFound = entry;
  try {
    const nouns = await findNounGenders(entry);
    entry.grammar = { text: entry.text, nouns: nouns, format: GRAMMAR_FORMAT }; // Remember it, so it's never asked twice
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


// ===== Immerse: Word Focus (the words of an entry and their meanings) =====
// GPT splits the selected entry into learning units, in order: single words, and chunks of 2-4 words
// that are best learned together. Each has: as written, its dictionary form, its type,
// its form in the sentence (or a usage note for a chunk) and its English meaning.
// Like Grammar Lens, the answer is saved with the entry, so each entry is only asked about once.
// Saved lists without this format number are the old word-by-word ones: they're made again when opened.
const WORD_LIST_FORMAT = 2;
const wordList = document.getElementById("word-list");
const wordFocusStatus = document.getElementById("word-focus-status");
const wordsKnownRow = document.getElementById("words-known");
let wordsBeingFound = null; // The entry waiting for GPT's answer (so it's only asked once)

function showWordFocusStatus(message) {
  wordFocusStatus.textContent = message;
  wordFocusStatus.hidden = !message;
}

// True if the cards use up the whole text in order, with only punctuation and spaces left over
function wordsCoverText(text, words) {
  let place = 0;
  let leftOver = "";
  for (const item of words) {
    const found = text.indexOf(item.word, place);
    if (found === -1) return false;
    leftOver += text.slice(place, found);
    place = found + item.word.length;
  }
  leftOver += text.slice(place);
  return !/[\p{L}\p{N}]/u.test(leftOver);
}

// GPT sometimes misses a word: ask once more. If the second answer misses one too, it's still used.
async function findWords(sentence) {
  const words = await askForWords(sentence);
  return wordsCoverText(sentence.text, words) ? words : askForWords(sentence);
}

async function askForWords(sentence) {
  const answer = await askOpenai({
    model: openaiModel,
    messages: [
      {
        role: "system",
        content:
          "You help a language learner study a text. Split the user's text into the most useful learning units, " +
          "in the order of the text. Every word of the text must be in exactly one unit, including repeated words, " +
          "names and numbers. Leave out only punctuation between units.\n" +
          "Use a chunk of 2-4 words when the words belong together and are best learned together: fixed " +
          "expressions, collocations, phrasal verbs, verb + preposition, verb + its usual object, set phrases and " +
          "idioms. Examples: \"mam ochotę na\" (I feel like), \"jechać pociągiem\" (go by train), \"give up\", " +
          "\"take a photo\", \"çok teşekkür ederim\" (thank you very much), \"ne zaman\" (when).\n" +
          "Use a single word when it makes sense on its own (most nouns, adjectives, simple verbs). Never split a " +
          "chunk into parts that lose their meaning, and don't make chunks just to group words that happen to be " +
          "next to each other.\n" +
          "For each unit: word: the text exactly as written in the user's text, same letters and capitals; base: " +
          "its dictionary form (infinitive for verbs, nominative singular for nouns, masculine singular for " +
          "adjectives; for a chunk, the form you'd find it under, e.g. \"mieć ochotę na\"); type: its kind of word " +
          "for a single word, or phrase, collocation, phrasal verb or idiom for a chunk; form: for a single word, " +
          "a short English description of its form in the text (e.g. \"instrumental singular\", \"1st person " +
          "singular, present\") or \"\" if it is the dictionary form or the language has no such forms; for a " +
          "chunk, a short note on how it's used if helpful (e.g. \"+ accusative\"), otherwise \"\"; meaning: a " +
          "short English meaning that fits this text (1-4 words).",
      },
      {
        role: "user",
        content: "Language: " + (sentence.language || "unknown") + "\nText: " + sentence.text,
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "vocabulary",
        strict: true,
        schema: {
          type: "object",
          properties: {
            words: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  word: { type: "string" },
                  base: { type: "string" },
                  type: {
                    type: "string",
                    enum: ["noun", "verb", "adjective", "adverb", "pronoun", "preposition", "conjunction",
                      "particle", "numeral", "phrase", "collocation", "phrasal verb", "idiom", "other"],
                  },
                  form: { type: "string" },
                  meaning: { type: "string" },
                },
                required: ["word", "base", "type", "form", "meaning"],
                additionalProperties: false,
              },
            },
          },
          required: ["words"],
          additionalProperties: false,
        },
      },
    },
  });
  return JSON.parse(answer).words;
}

// One card per word:  pociągiem → pociąg   noun
//                      train
//                      instrumental singular
// Words you've marked as known, per entry (by the entry's id), by their dictionary form in lower case:
// { "entry-...": ["dzisiaj", "do"], ... }. A word only shows as known in the entry it was marked in.
let knownByEntry = loadSaved("knownByEntry", {});
// Older known words that aren't in any entry's word list. They're never shown,
// but questions still avoid them: { Polish: ["dom"], ... }
let knownWithoutEntry = loadSaved("knownWithoutEntry", {});

// Known words used to be saved per language ("knownWords"), so a word marked in one entry showed as
// known in all of them. Move them over once (this also runs after restoring an older backup).
// The old data doesn't say where a word was marked, so it goes on every entry whose word list
// already has it. Entries whose words haven't been looked up yet start with nothing marked.
const oldKnownWords = loadSaved("knownWords", null);
if (oldKnownWords) {
  Object.keys(oldKnownWords).forEach(function (language) {
    oldKnownWords[language].forEach(function (key) {
      const entries = sentences.filter(function (entry) {
        return entry.language === language && entry.words && entry.words.list.some(function (item) {
          return knownKey(item) === key;
        });
      });
      entries.forEach(function (entry) {
        knownByEntry[entry.id] = (knownByEntry[entry.id] || []).concat(key);
      });
      if (entries.length === 0) {
        knownWithoutEntry[language] = (knownWithoutEntry[language] || []).concat(key);
      }
    });
  });
  save("knownByEntry", knownByEntry, true);
  save("knownWithoutEntry", knownWithoutEntry, true);
  save("knownWords", null, true); // Only removed now that the words are safely moved
}

function knownKey(item) {
  return (item.base || item.word).toLocaleLowerCase();
}

function isKnown(entry, item) {
  return (knownByEntry[entry.id] || []).includes(knownKey(item));
}

function forgetKnownWords(entry) {
  delete knownByEntry[entry.id];
  save("knownByEntry", knownByEntry, true);
}

// Everything marked as known in a language, for making questions
function allKnownWords(language) {
  const words = new Set(knownWithoutEntry[language] || []);
  sentences.forEach(function (entry) {
    if (entry.language === language) {
      (knownByEntry[entry.id] || []).forEach(function (key) { words.add(key); });
    }
  });
  return Array.from(words);
}

// Tap a word: mark it as known, or tap it again (under "Known") to bring it back
function toggleKnown(entry, item) {
  const list = knownByEntry[entry.id] || [];
  const key = knownKey(item);
  knownByEntry[entry.id] = list.includes(key)
    ? list.filter(function (other) { return other !== key; })
    : list.concat(key);
  save("knownByEntry", knownByEntry, true);
  showWordFocus();
}

// The words you still need, as cards. Known words go in a small row underneath.
function drawWordList(words, entry) {
  wordList.innerHTML = "";
  wordsKnownRow.innerHTML = "";
  const known = words.filter(function (item) { return isKnown(entry, item); });
  words.forEach(function (item) {
    if (isKnown(entry, item)) return;
    const card = document.createElement("li");
    card.className = "word-card";
    card.title = "Tap when you know this";
    card.addEventListener("click", function () { toggleKnown(entry, item); });

    const top = document.createElement("div");
    top.className = "word-top";
    const word = document.createElement("span");
    word.className = "word-written";
    word.textContent = item.word;
    top.append(word);
    // The dictionary form, if it's different from how it's written in the entry
    if (item.base && item.base.toLocaleLowerCase() !== item.word.toLocaleLowerCase()) {
      const base = document.createElement("span");
      base.className = "word-base";
      base.textContent = "→ " + item.base;
      top.append(base);
    }
    const type = document.createElement("span");
    type.className = "word-type";
    type.textContent = item.type;
    top.append(type);

    const meaning = document.createElement("p");
    meaning.className = "word-meaning";
    meaning.textContent = item.meaning;
    card.append(top, meaning);

    if (item.form) {
      const form = document.createElement("p");
      form.className = "word-form";
      form.textContent = item.form;
      card.append(form);
    }
    wordList.append(card);
  });

  // ✓ Known: small chips; tap one to bring it back to the cards
  wordsKnownRow.hidden = known.length === 0;
  if (known.length > 0) {
    const label = document.createElement("span");
    label.className = "words-known-label";
    label.textContent = "✓ Known (tap to bring back):";
    wordsKnownRow.append(label);
    known.forEach(function (item) {
      wordsKnownRow.append(makeButton("✓ " + item.word, "word-known-chip", function () {
        toggleKnown(entry, item);
      }));
    });
  }
}

// Fill the Word Focus view for the selected entry. Asks GPT only when needed.
async function showWordFocus() {
  const entry = selectedEntry;
  const visible = entry && sentences.includes(entry) && entry.language === myLanguage;
  wordList.innerHTML = "";
  wordsKnownRow.innerHTML = "";
  wordsKnownRow.hidden = true;

  if (!visible) {
    showWordFocusStatus("Select an entry above to see its words and their meanings.");
    return;
  }

  const haveWords = entry.words && entry.words.text === entry.text;
  // Already found earlier for this exact text: show it straight away (no new request)
  if (haveWords && entry.words.format === WORD_LIST_FORMAT) {
    drawWordList(entry.words.list, entry);
    const toLearn = entry.words.list.filter(function (item) { return !isKnown(entry, item); }).length;
    let message = toLearn + " to learn. Tap a card when you know it.";
    if (entry.words.list.length === 0) message = "No words found in this entry.";
    else if (toLearn === 0) message = "You know every word in this entry!";
    showWordFocusStatus(message);
    return;
  }

  if (!openaiKey) {
    if (haveWords) drawWordList(entry.words.list, entry); // The old list is better than nothing
    showWordFocusStatus("Add your OpenAI API key in Settings → OpenAI to use Word Focus.");
    return;
  }
  if (wordsBeingFound === entry) {
    showWordFocusStatus("Finding the words…");
    return; // Already asking GPT about this entry
  }

  showWordFocusStatus("Finding the words…");
  wordsBeingFound = entry;
  try {
    const words = await findWords(entry);
    entry.words = { text: entry.text, list: words, format: WORD_LIST_FORMAT }; // Remember it, so it's never asked twice
    saveSentences();
  } catch (error) {
    wordsBeingFound = null;
    if (selectedEntry === entry) {
      if (haveWords) drawWordList(entry.words.list, entry); // The old list is kept until a new one arrives
      showWordFocusStatus(error.message);
    }
    return;
  }
  wordsBeingFound = null;

  // Only redraw if the same entry is still selected and Word Focus is still open
  if (selectedEntry === entry && !document.getElementById("word-focus").hidden) {
    showWordFocus();
  }
}


// ===== Immerse: Explain this sentence =====
// A small "?" after each sentence of the entry (in Pure Text and Grammar Lens). Tapping it opens a
// panel where GPT explains that one sentence: a translation, every word, the grammar worth noticing,
// one similar example, and a box for asking more. The explanation is saved on the entry
// (entry.explanations, keyed by the sentence's text), so it opens instantly next time, works
// offline, and goes into backups with the sentences. Follow-up answers are not saved.

// Saved explanations without this format number are asked for again when opened
const EXPLAIN_FORMAT = 1;

const explainPanel = document.getElementById("explain-panel");
const explainBackdrop = document.getElementById("explain-backdrop");
const explainSentence = document.getElementById("explain-sentence");
const explainBody = document.getElementById("explain-body");
const explainPlay = document.getElementById("explain-play");
const explainRefresh = document.getElementById("explain-refresh");
const explainClose = document.getElementById("explain-close");
const explainHome = explainPanel.parentElement; // Its place on a computer: inside the Immerse box
const phoneScreen = window.matchMedia("(max-width: 600px)");

let explainEntry = null;    // The entry the panel is about
let explainText = "";       // The sentence the panel is about
let explainAsking = null;   // "entry id + sentence" while GPT is working on it (so it's asked only once)

// Split a text into sentences: [{ start, end }], where end is just after the final punctuation
// (closing quotes and brackets included). Uses the browser's own sentence finder when it has one.
function findSentences(text, language) {
  const pieces = [];
  if (window.Intl && Intl.Segmenter) {
    const segmenter = new Intl.Segmenter(SPEECH_LANGUAGES[language] || undefined, { granularity: "sentence" });
    for (const piece of segmenter.segment(text)) {
      pieces.push({ start: piece.index, text: piece.segment });
    }
  } else {
    // Older browsers: cut after . ! ? … (and closing quotes or brackets after them)
    const pattern = /[^.!?…。？！]+(?:[.!?…。？！]+["'»”’)\]]*|$)\s*/g;
    let match;
    while ((match = pattern.exec(text)) && match[0]) {
      pieces.push({ start: match.index, text: match[0] });
    }
  }
  // Leave out the spaces at the end, and pieces with no letters at all
  return pieces
    .map(function (piece) { return { start: piece.start, end: piece.start + piece.text.trimEnd().length }; })
    .filter(function (piece) { return /[\p{L}\p{N}]/u.test(text.slice(piece.start, piece.end)); });
}

// Put a "?" button after each sentence of a paragraph that shows the entry's text.
// The paragraph may already hold coloured nouns (Grammar Lens): the buttons go between them, never inside.
function markSentences(paragraph, entry) {
  if (paragraph.querySelector(".explain-marker")) return; // Already done
  const text = paragraph.textContent;
  const sentences = findSentences(text, entry.language);

  // Work from the last sentence back, so the earlier positions don't move
  sentences.reverse().forEach(function (sentence) {
    const sentenceText = text.slice(sentence.start, sentence.end);
    const marker = makeButton("?", "explain-marker", function (event) {
      event.stopPropagation();
      if (longPressed) return; // A long-press only showed the tooltip
      openExplanation(entry, sentenceText);
    });
    marker.setAttribute("aria-label", "Explain this sentence");
    marker.dataset.tip = "Explain this sentence";
    marker.dataset.noWords = ""; // Karaoke follow-along: this "?" isn't a word of the sentence
    addTooltip(marker);

    // Find the piece of text where the sentence ends
    let position = 0;
    const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (node.parentElement.closest(".explain-marker")) continue;
      const nodeEnd = position + node.length;
      if (sentence.end <= nodeEnd) {
        if (node.parentElement === paragraph) {
          node.splitText(sentence.end - position); // Cut the text right after the punctuation
          node.after(marker);
        } else {
          node.parentElement.after(marker); // Ends inside a coloured noun: put it after the noun
        }
        return;
      }
      position = nodeEnd;
    }
    paragraph.append(marker);
  });
}

// ----- Opening and closing the panel -----

function openExplanation(entry, sentenceText) {
  stopAudio(); // The listening loop pauses while you read
  explainEntry = entry;
  explainText = sentenceText;
  explainSentence.textContent = sentenceText;

  // A bottom sheet on a phone (it must leave the Immerse box: inside a see-through box a
  // fixed-position sheet would be stuck to the box, not the screen), under the passage on a computer
  if (phoneScreen.matches) {
    document.body.append(explainPanel);
    explainPanel.classList.add("sheet");
    explainBackdrop.hidden = false;
    document.documentElement.classList.add("sheet-open");
  } else {
    explainHome.append(explainPanel);
    explainPanel.classList.remove("sheet");
    explainBackdrop.hidden = true;
    document.documentElement.classList.remove("sheet-open");
  }
  explainPanel.hidden = false;
  explainPanel.style.transform = "";
  explainPanel.scrollTop = 0;
  showExplanation(false);
  if (!phoneScreen.matches) {
    explainPanel.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
  explainClose.focus({ preventScroll: true });
}

function closeExplanation() {
  if (explainPanel.hidden) return;
  explainPanel.hidden = true;
  explainBackdrop.hidden = true;
  document.documentElement.classList.remove("sheet-open");
  if ("speechSynthesis" in window && !audioPlaying) speechSynthesis.cancel();
  explainEntry = null;
}

function closeExplanationIfEntryChanged() {
  if (explainEntry && explainEntry !== selectedEntry) closeExplanation();
}

explainClose.addEventListener("click", closeExplanation);
explainBackdrop.addEventListener("click", closeExplanation);
document.addEventListener("keydown", function (event) {
  if (event.key === "Escape") closeExplanation();
});

// Turning the phone, or making the window wider or narrower: move the panel to the right place
phoneScreen.addEventListener("change", function () {
  if (explainEntry && !explainPanel.hidden) openExplanation(explainEntry, explainText);
});

// Swipe down on the sheet to close it (only when it's scrolled to the top, so scrolling still works)
let swipeStartY = null;
let swipeDistance = 0;
explainPanel.addEventListener("touchstart", function (event) {
  if (!explainPanel.classList.contains("sheet") || explainPanel.scrollTop > 0) return;
  swipeStartY = event.touches[0].clientY;
  swipeDistance = 0;
}, { passive: true });
explainPanel.addEventListener("touchmove", function (event) {
  if (swipeStartY === null) return;
  swipeDistance = Math.max(0, event.touches[0].clientY - swipeStartY);
  explainPanel.style.transform = swipeDistance ? "translateY(" + swipeDistance + "px)" : "";
}, { passive: true });
explainPanel.addEventListener("touchend", function () {
  if (swipeStartY === null) return;
  swipeStartY = null;
  explainPanel.style.transform = "";
  if (swipeDistance > 90) closeExplanation(); // Pulled down far enough
});

// ----- Play this sentence (once, with the device's voice) -----

explainPlay.addEventListener("click", function () {
  if (!("speechSynthesis" in window)) {
    explainPlay.textContent = "This browser can't read text aloud";
    return;
  }
  stopAudio();
  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(explainText);
  const languageCode = SPEECH_LANGUAGES[explainEntry ? explainEntry.language : ""];
  if (languageCode) {
    utterance.lang = languageCode;
    const voice = voiceFor(languageCode);
    try {
      if (voice) utterance.voice = voice;
    } catch {
      // The device picks a voice for the language instead
    }
  }
  utterance.rate = 0.9 * audioSpeed; // The same pace as the listening loop
  speechSynthesis.speak(utterance);
});

// ----- Showing the explanation -----

// The saved explanation of a sentence (or null)
function savedExplanation(entry, sentenceText) {
  const saved = entry.explanations && entry.explanations[sentenceText];
  return saved && saved.format === EXPLAIN_FORMAT ? saved : null;
}

// Show the saved explanation, or ask GPT for one (always when "fresh" is true: the Refresh button)
async function showExplanation(fresh) {
  const entry = explainEntry;
  const sentenceText = explainText;
  const saved = fresh ? null : savedExplanation(entry, sentenceText);
  explainRefresh.hidden = !saved;
  if (saved) {
    drawExplanation(saved);
    return;
  }

  const askKey = entry.id + "|" + sentenceText;
  showExplainLoading();
  if (!openaiKey || !navigator.onLine) {
    showExplainError();
    return;
  }
  if (explainAsking === askKey) return; // Already asking
  explainAsking = askKey;
  let explanation;
  try {
    explanation = await askForExplanation(entry, sentenceText);
  } catch {
    explainAsking = null;
    if (explainEntry === entry && explainText === sentenceText) showExplainError();
    return;
  }
  explainAsking = null;

  // Remember it with the entry. Explanations of sentences no longer in the entry are tidied away.
  const kept = {};
  Object.keys(entry.explanations || {}).forEach(function (key) {
    if (entry.text.includes(key)) kept[key] = entry.explanations[key];
  });
  kept[sentenceText] = explanation;
  entry.explanations = kept;
  saveSentences();

  // Only show it if the panel is still open on the same sentence
  if (explainEntry === entry && explainText === sentenceText && !explainPanel.hidden) {
    explainRefresh.hidden = false;
    drawExplanation(explanation);
  }
}

// A calm "working on it" message, with three softly breathing dots
function showExplainLoading() {
  explainBody.innerHTML = "";
  const loading = document.createElement("p");
  loading.className = "explain-loading hint";
  loading.textContent = "Explaining this sentence";
  const dots = document.createElement("span");
  dots.className = "explain-dots";
  dots.setAttribute("aria-hidden", "true");
  dots.innerHTML = "<span>.</span><span>.</span><span>.</span>";
  loading.append(dots);
  explainBody.append(loading);
}

// No key, no internet, or the request failed: say so, with a Try again button
function showExplainError() {
  explainBody.innerHTML = "";
  const message = document.createElement("p");
  message.className = "explain-error";
  message.textContent = "Couldn't load an explanation. Check your connection or API key in Settings.";
  const again = document.createElement("button");
  again.type = "button";
  again.textContent = "Try again"; // No class: a main button
  again.addEventListener("click", function () { showExplanation(true); });
  explainBody.append(message, again);
}

// A small heading for each part of the panel
function explainHeading(text) {
  const heading = document.createElement("h4");
  heading.className = "explain-label type-nav"; // Small labels use the theme's navigation font
  heading.textContent = text;
  return heading;
}

// Reading text in the entry's language (right to left for Hebrew, by itself)
function foreignText(tag, text, className) {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = text;
  element.dir = "auto";
  return element;
}

function drawExplanation(data) {
  explainBody.innerHTML = "";

  // 1. Translation: natural, then word for word
  explainBody.append(explainHeading("Translation"));
  const natural = document.createElement("p");
  natural.className = "explain-translation";
  natural.textContent = data.translation;
  const literal = document.createElement("p");
  literal.className = "explain-literal";
  literal.textContent = "Word for word: " + data.literal;
  explainBody.append(natural, literal);

  // 2. Every word: as written (nouns in their gender colour), dictionary form, part of speech, grammar
  explainBody.append(explainHeading("Word breakdown"));
  const list = document.createElement("ul");
  list.className = "explain-words";
  data.words.forEach(function (word) {
    const item = document.createElement("li");
    const written = foreignText("span", word.word, "explain-word");
    if (word.gender !== "none") {
      written.classList.add("noun", word.gender);
      written.title = word.gender;
    }
    const top = document.createElement("div");
    top.className = "explain-word-top";
    top.append(written);
    if (word.base && word.base.toLocaleLowerCase() !== word.word.toLocaleLowerCase()) {
      top.append(foreignText("span", "→ " + word.base, "explain-base"));
    }
    const kind = document.createElement("div");
    kind.className = "explain-kind";
    kind.textContent = word.partOfSpeech + (word.grammar ? " · " + word.grammar : "");
    item.append(top, kind);
    if (word.meaning) {
      const meaning = document.createElement("div");
      meaning.className = "explain-meaning";
      meaning.textContent = word.meaning;
      item.append(meaning);
    }
    list.append(item);
  });
  explainBody.append(list);

  // 3. Key grammar points (1 to 3)
  explainBody.append(explainHeading("Key grammar points"));
  const points = document.createElement("ol");
  points.className = "explain-points";
  data.points.forEach(function (point) {
    const item = document.createElement("li");
    const title = document.createElement("strong");
    title.textContent = point.title;
    const text = document.createElement("p");
    text.textContent = point.explanation;
    item.append(title, text);
    points.append(item);
  });
  explainBody.append(points);

  // 4. A new sentence with the same pattern; its translation is hidden until tapped
  explainBody.append(explainHeading("Similar example"));
  explainBody.append(foreignText("p", data.example.sentence, "explain-example"));
  const exampleTranslation = document.createElement("p");
  exampleTranslation.className = "explain-example-translation";
  exampleTranslation.textContent = data.example.translation;
  exampleTranslation.hidden = true;
  const showTranslation = makeButton("Show translation", "filter-button explain-show", function () {
    exampleTranslation.hidden = false;
    showTranslation.remove();
  });
  explainBody.append(showTranslation, exampleTranslation);

  // 5. Ask about this sentence (answers are shown, not saved)
  explainBody.append(explainHeading("Ask about this sentence"));
  const form = document.createElement("form");
  form.className = "try-form explain-ask";
  const question = document.createElement("input");
  question.type = "text";
  question.placeholder = "Ask about this sentence";
  question.setAttribute("aria-label", "Ask about this sentence");
  const send = document.createElement("button");
  send.type = "submit";
  send.textContent = "Ask"; // No class: a main button
  form.append(question, send);
  const answer = document.createElement("p");
  answer.className = "explain-answer";
  answer.hidden = true;
  explainBody.append(form, answer);

  const entry = explainEntry;
  const sentenceText = explainText;
  form.addEventListener("submit", async function (event) {
    event.preventDefault();
    const asked = question.value.trim();
    if (!asked) return;
    answer.hidden = false;
    answer.classList.add("hint");
    answer.textContent = "Thinking…";
    send.disabled = true;
    try {
      if (!openaiKey || !navigator.onLine) throw new Error("offline");
      const reply = await askFollowUp(entry, sentenceText, data, asked);
      answer.classList.remove("hint");
      answer.textContent = reply;
    } catch {
      answer.textContent = "Couldn't get an answer. Check your connection or API key in Settings.";
    }
    send.disabled = false;
  });
}

explainRefresh.addEventListener("click", function () { showExplanation(true); });

// ----- Asking GPT -----

// How to write for each level: plain words for beginners, full grammar terms for advanced learners
function explainStyle(level) {
  if (level === "A1" || level === "A2") {
    return "The learner is a beginner (" + level + "). Use short, simple English and everyday words. " +
      "Use as few grammar terms as possible, and when you need one, explain it in a few plain words.";
  }
  if (level === "B1") {
    return "The learner is intermediate (B1). Use clear English and the common grammar terms, briefly explained.";
  }
  return "The learner is advanced (" + level + "). Use full, precise grammar terminology.";
}

// The answer must follow a fixed shape, so the panel always looks the same:
// { translation, literal, words: [{ word, base, partOfSpeech, gender, grammar, meaning }],
//   points: [{ title, explanation }], example: { sentence, translation } }
async function askForExplanation(entry, sentenceText) {
  const level = myLevel || "A2"; // No level picked: a gentle A2
  const answer = await askOpenai({
    model: openaiModel,
    temperature: 0.3,
    messages: [
      {
        role: "system",
        content:
          "You are a friendly, precise language teacher. Explain one sentence to a learner, in English.\n" +
          explainStyle(level) + "\n" +
          "translation: a natural English translation.\n" +
          "literal: a word-for-word English version that keeps the original word order.\n" +
          "words: every word of the sentence in order, leaving out punctuation. word: exactly as written. " +
          "base: its dictionary form. partOfSpeech: e.g. noun, verb, adjective, pronoun, preposition. " +
          "gender: for nouns only, masculine, feminine or neuter (for languages with grammatical gender); " +
          "\"none\" for every other word and for languages without gender. " +
          "grammar: for nouns, adjectives and pronouns give case, gender and number; for verbs give tense, " +
          "aspect, person and mood (only the ones the language has); otherwise a short note or \"\". " +
          "meaning: its English meaning here.\n" +
          "points: 1 to 3 short, clear explanations of what is most worth noticing in this sentence's grammar " +
          "(title: a few words; explanation: 1-3 sentences).\n" +
          "example: one new sentence in the same language using the same pattern, at the learner's level, " +
          "with its English translation.",
      },
      {
        role: "user",
        content: "Language: " + (entry.language || "unknown") + "\nLevel: " + level +
          "\nSentence: " + sentenceText + "\nThe whole passage, for context: " + entry.text,
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "sentence_explanation",
        strict: true,
        schema: {
          type: "object",
          properties: {
            translation: { type: "string" },
            literal: { type: "string" },
            words: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  word: { type: "string" },
                  base: { type: "string" },
                  partOfSpeech: { type: "string" },
                  gender: { type: "string", enum: ["masculine", "feminine", "neuter", "none"] },
                  grammar: { type: "string" },
                  meaning: { type: "string" },
                },
                required: ["word", "base", "partOfSpeech", "gender", "grammar", "meaning"],
                additionalProperties: false,
              },
            },
            points: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  title: { type: "string" },
                  explanation: { type: "string" },
                },
                required: ["title", "explanation"],
                additionalProperties: false,
              },
            },
            example: {
              type: "object",
              properties: {
                sentence: { type: "string" },
                translation: { type: "string" },
              },
              required: ["sentence", "translation"],
              additionalProperties: false,
            },
          },
          required: ["translation", "literal", "words", "points", "example"],
          additionalProperties: false,
        },
      },
    },
  });

  // Check the answer, so a broken one is never saved
  const data = JSON.parse(answer);
  if (!data.translation || !Array.isArray(data.words) || data.words.length === 0 || !data.example) {
    throw new Error("The explanation came back incomplete.");
  }
  const genders = NOUN_GENDERS[entry.language];
  data.words.forEach(function (word) {
    // No colours in languages without gender (English, Turkish), whatever GPT says
    if (genders && !genders.includes(word.gender)) word.gender = "none";
  });
  data.points = data.points.slice(0, 3);
  data.format = EXPLAIN_FORMAT;
  data.level = level;
  return data;
}

// A follow-up question, with the sentence and its explanation as context. Returns the answer's text.
async function askFollowUp(entry, sentenceText, explanation, question) {
  const level = myLevel || "A2";
  const answer = await askOpenai({
    model: openaiModel,
    temperature: 0.3,
    messages: [
      {
        role: "system",
        content: "You are a friendly, precise language teacher. Answer the learner's question about the " +
          "sentence below, in English, briefly (at most about 120 words). " + explainStyle(level),
      },
      {
        role: "user",
        content: "Language: " + (entry.language || "unknown") + "\nSentence: " + sentenceText +
          "\nExplanation already given: " + JSON.stringify(explanation) + "\nQuestion: " + question,
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "follow_up",
        strict: true,
        schema: {
          type: "object",
          properties: { answer: { type: "string" } },
          required: ["answer"],
          additionalProperties: false,
        },
      },
    },
  });
  return JSON.parse(answer).answer;
}


// ===== Practice: questions made by GPT =====
// Short questions from the selected entry, at the chosen level (How Deep Today?)
// and practice target (noun, verb, adjective or mix). Each set has 5 questions of random
// types in a random order (pickQuestionTypes). Gender questions exist for A1-B2, in
// languages whose nouns have a gender.
const QUESTION_TYPES = {
  reading: "Mini reading",
  form: "Correct form",
  order: "Word order",
  odd: "Odd one out",
  gender: "Gender",
};

// At these levels, instructions, questions and explanations are in the practice language too
const IMMERSION_LEVELS = ["C1", "C2"];

// The line at the top of each question card at A1-B2. It's fixed here, not written by GPT,
// so it's never in the wrong language. At C1-C2, GPT writes it in the practice language.
const QUESTION_INSTRUCTIONS = {
  reading: "Read the text and answer the question.",
  form: "Choose the correct form for the gap.",
  order: "Tap the words to put them in the right order.",
  odd: "Which word doesn't belong?",
  gender: "What is the gender of this noun?",
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

const QUESTIONS_PER_SET = 5;
const MAX_SAME_TYPE = 2; // No type more than twice in one set
const ONE_GENDER_LEVELS = ["A1", "A2"]; // Every set has exactly one gender question
const NO_READING_LEVELS = ["A1"]; // Mini reading is too hard here

// The types of the previous set, in order, so the next set never repeats it exactly
let lastQuestionPlan = "";

// The types that can be made for this entry and level (the gender question is
// left out here, it's added by pickQuestionTypes)
function questionTypesThatWork(entry, level) {
  const wordCount = entry.text.trim().split(/\s+/).length;
  return Object.keys(QUESTION_TYPES).filter(function (type) {
    if (type === "gender") return false;
    if (type === "reading" && NO_READING_LEVELS.includes(level)) return false;
    if (type === "order" && wordCount < 3) return false; // Too few words to put in order
    if (type === "odd" && wordCount < 2) return false; // Too little to build a word group from
    return true;
  });
}

// Pick random types for a set. "avoid" lists types that just failed, so they're not picked again.
// count: how many to pick (5 for a new set, fewer when replacing failed questions).
// usedTypes: types already in the set (when replacing), so the "max twice" rule still holds.
function pickQuestionTypes(entry, level, count, avoid, usedTypes) {
  const genders = genderChoices(entry, level);
  let pool = questionTypesThatWork(entry, level).filter(function (type) { return !avoid.includes(type); });
  if (pool.length === 0) pool = questionTypesThatWork(entry, level); // Nothing left: allow them again
  // B1-B2 may get gender questions at random, like any other type
  const randomGender = genders.length > 0 && !ONE_GENDER_LEVELS.includes(level) && !avoid.includes("gender");
  if (randomGender) pool.push("gender");
  // A1-A2: exactly one gender question (if the language has genders)
  const needsGender = genders.length > 0 && ONE_GENDER_LEVELS.includes(level)
    && !usedTypes.includes("gender") && !avoid.includes("gender");

  let plan = [];
  for (let attempt = 0; attempt < 30; attempt++) {
    plan = needsGender ? ["gender"] : [];
    const counts = {};
    usedTypes.concat(plan).forEach(function (type) { counts[type] = (counts[type] || 0) + 1; });
    while (plan.length < count) {
      // Prefer types used less than twice; if none are left (a tiny pool), allow more
      let choices = pool.filter(function (type) { return (counts[type] || 0) < MAX_SAME_TYPE; });
      if (choices.length === 0) choices = pool;
      const type = choices[Math.floor(Math.random() * choices.length)];
      counts[type] = (counts[type] || 0) + 1;
      plan.push(type);
    }
    plan = shuffled(plan, true);
    // A new set mustn't be the same types in the same order as the last one
    if (usedTypes.length > 0 || plan.join() !== lastQuestionPlan) break;
  }
  return plan;
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

// Make one set: pick the types, ask GPT, and if some questions can't be used,
// ask once more for replacements of other random types (still following the level rules)
async function makeQuestionSet(entry, level, target) {
  const plan = pickQuestionTypes(entry, level, QUESTIONS_PER_SET, [], []);
  lastQuestionPlan = plan.join();
  const questions = await askForQuestions(entry, level, target, plan);
  const missing = plan.length - questions.length;
  if (missing > 0 && questions.length > 0) {
    const usedTypes = questions.map(function (question) { return question.type; });
    // The types that came back fewer times than planned
    const failed = plan.filter(function (type) {
      const planned = plan.filter(function (other) { return other === type; }).length;
      return usedTypes.filter(function (other) { return other === type; }).length < planned;
    });
    const morePlan = pickQuestionTypes(entry, level, missing, failed, usedTypes);
    try {
      const more = await askForQuestions(entry, level, target, morePlan);
      // Put the replacements at random places in the set
      more.forEach(function (question) {
        questions.splice(Math.floor(Math.random() * (questions.length + 1)), 0, question);
      });
    } catch (error) {
      // Keep the questions we have
    }
  }
  return questions;
}

// One question type, as described to GPT
function questionRule(type, words, genders, target, guideLanguage) {
  if (type === "reading") {
    return "type \"reading\": a NEW passage of 1-2 short sentences on the same topic, using some of the sentence's " +
      "words; a short question about it, written in " + guideLanguage + "; 3 options (4 for B1 and above); " +
      "answer_index is the correct option.";
  }
  if (type === "form") {
    return "type \"form\": a short sentence with one " + words.one + " replaced by ___ and its base form in brackets " +
      "after the gap, e.g. \"Idę do ___ (bankomat).\"; 3 options (4 for B1 and above) that are different forms of " +
      "that word; answer_index is the correct one. Put the sentence with the gap in question and leave passage \"\"; " +
      "never write the completed sentence anywhere.";
  }
  if (type === "order") {
    return "type \"order\": answer_sentence is one short correct sentence (4-8 words) using words from the sentence. " +
      "Leave options empty and answer_index -1. Leave passage and question \"\": never write the sentence anywhere " +
      "except answer_sentence.";
  }
  if (type === "odd") {
    return "type \"odd\": 4 single words as options; 3 belong together (same topic, or the same kind of " +
      target + "), 1 does not; answer_index is the odd one.";
  }
  return "type \"gender\": passage is one noun from the sentence in its dictionary form (e.g. \"poczta\"); " +
    "question is \"\"; options are exactly " + JSON.stringify(genders) + " in that order; answer_index is " +
    "the noun's grammatical gender.";
}

// Ask GPT for the questions in the plan (a list of types, in order).
// The answer must follow a fixed shape (checked by OpenAI).
async function askForQuestions(entry, level, target, plan) {
  const words = targetWords(target);
  const genders = genderChoices(entry, level);
  // The language of everything that says what to do or explains the answer
  const guideLanguage = IMMERSION_LEVELS.includes(level) ? entry.language : "English";
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
  // Words marked as known in Word Focus: questions practise the other words instead,
  // and known words aren't explained again (the newest 300 are sent, to keep the request short)
  const known = allKnownWords(entry.language).slice(-300);
  const knownPart = known.length === 0 ? "" :
    "\nWords the learner already knows (dictionary forms): " + known.join(", ") +
    "\nPrefer the other words of the sentence for the questions (above all the form, odd and gender questions), " +
    "and never list a known word in a glossary.";
  // The plan as a numbered list, e.g. "1. type "odd": …". A type used twice should ask about different words.
  const planPart = plan.map(function (type, index) {
    return (index + 1) + ". " + questionRule(type, words, genders, target, guideLanguage);
  }).join("\n") + "\nIf a type appears twice, use different words in each.\n";

  const answer = await askOpenai({
    model: openaiModel,
    messages: [
      {
        role: "system",
        content:
          "You write short practice questions for a language learner. The exercise content is in " + entry.language +
          ": passages, the sentence with the gap in a form question, options, answer_sentence and the noun in a " +
          "gender question. The instruction, the question about a reading passage and the explanation are in clear, " +
          "simple " + guideLanguage + ". Match CEFR level " + level + " in the exercise content: simple words and " +
          "grammar for A1-A2, richer for B1-B2, natural and advanced for C1-C2. Keep everything short. Focus on " + words.focus + ". Reuse words from the " +
          "learner's sentence and stay on its topic. Every question has exactly one correct answer.\n\n" +
          "Write exactly " + plan.length + " questions, in this order:\n" +
          planPart + "\n" +
          "Use \"\" for passage when there is none, [] for options when there are none, -1 for answer_index when " +
          "there is none, and \"\" for answer_sentence except in the order question. instruction: one short line " +
          "telling the learner what to do, in " + guideLanguage + ". explanation: one short sentence in " +
          guideLanguage + " explaining the answer.\n" +
          "translation: a natural English translation of the full sentence(s) of the question: the passage for " +
          "reading, the COMPLETED sentence (gap filled with the right answer) for form, answer_sentence for order; " +
          "\"\" for odd and gender. It is only shown after the learner answers.\n" + wordHelpPart + "\n" +
          // Said again at the very end, because GPT tended to forget it
          "The instruction, the question about a reading passage and the explanation must be in " + guideLanguage + ".",
      },
      {
        role: "user",
        content: "Learner's sentence (" + entry.language + "): " + entry.text +
          (entry.topics.length > 0 ? "\nTopics: " + entry.topics.join(", ") : "") + knownPart,
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
                  instruction: { type: "string", description: "Written in " + guideLanguage + "." },
                  passage: { type: "string" },
                  // A form question keeps its sentence with the gap here, so that stays in the practice language
                  question: {
                    type: "string",
                    description: "Reading question: written in " + guideLanguage + ". Form question: the sentence with the gap, in " + entry.language + ".",
                  },
                  options: { type: "array", items: { type: "string" } },
                  answer_index: { type: "integer" },
                  answer_sentence: { type: "string" },
                  explanation: { type: "string", description: "Written in " + guideLanguage + "." },
                  translation: { type: "string", description: "English translation of the full sentence(s); \"\" for odd and gender." },
                  glossary: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        word: { type: "string" },
                        meaning: { type: "string", description: "Always in simple English, at every CEFR level." },
                      },
                      required: ["word", "meaning"],
                      additionalProperties: false,
                    },
                  },
                },
                required: ["type", "instruction", "passage", "question", "options", "answer_index", "answer_sentence", "explanation", "translation", "glossary"],
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

  // Put GPT's questions in the planned order (and drop any type that wasn't asked for)
  const returned = JSON.parse(answer).questions;
  const ordered = [];
  plan.forEach(function (type) {
    const index = returned.findIndex(function (question) { return question.type === type; });
    if (index >= 0) ordered.push(returned.splice(index, 1)[0]);
  });

  // Keep only questions that can really be answered
  return ordered.filter(function (question) {
    if (!IMMERSION_LEVELS.includes(level)) {
      question.instruction = QUESTION_INSTRUCTIONS[question.type];
    }
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

// Mix up a list (for the word order question, and the order of question types).
// allowSame: it's fine if the mixed list happens to come out in the same order.
function shuffled(list, allowSame) {
  const copy = list.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  // Never show the words already in the right order
  if (!allowSame && copy.join(" ") === list.join(" ") && list.length > 1) {
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
function markAnswer(card, correct, explanation, translation) {
  card.classList.add(correct ? "answered-right" : "answered-wrong");
  const result = document.createElement("p");
  result.className = "quiz-result " + (correct ? "right" : "wrong");
  result.textContent = (correct ? "✓ Correct. " : "✗ Not quite. ") + explanation;
  card.append(result);

  // Whole-sentence questions (reading, form, order): the English meaning, only after answering
  if (translation && translation.trim()) {
    const english = document.createElement("p");
    english.className = "quiz-translation";
    english.textContent = translation.trim();
    card.append(english);
  }

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
      markAnswer(card, index === question.answer_index, question.explanation, question.translation);
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
    markAnswer(card, correct, (correct ? "" : "Correct: " + question.answer_sentence + ". ") + question.explanation, question.translation);
  });
  check.disabled = true; // Until every word is used

  card.append(built, pool, check);
}

// GPT sometimes writes the answer into the question text. Before showing a card,
// blank out any passage or question that would give the answer away:
// - word order: only the word tiles are shown, never the sentence they came from
// - correct form: only the sentence with the gap ___ is shown, never the filled-in one
// - and no glossary meaning for the correct form itself
function hideAnswers(question) {
  if (question.type === "order") {
    question.passage = "";
    question.question = "";
  }
  if (question.type === "form") {
    const right = (question.options[question.answer_index] || "").toLowerCase();
    const hasGap = question.passage.includes("___") || question.question.includes("___");
    // Keep only the text with the gap in it. If neither has one, keep any text that doesn't hold the answer.
    [ "passage", "question" ].forEach(function (field) {
      const text = question[field];
      const leaks = hasGap ? !text.includes("___") : right !== "" && text.toLowerCase().includes(right);
      if (leaks) question[field] = "";
    });
    if (question.glossary) {
      question.glossary = question.glossary.filter(function (item) { return item.word.toLowerCase() !== right; });
    }
  }
}

// Show the questions
function showQuestions(questions) {
  quizList.innerHTML = "";
  quizScore = { answered: 0, correct: 0, total: questions.length };

  questions.forEach(function (question, index) {
    const card = document.createElement("li");
    card.className = "quiz-card";

    // Card header: a numbered circle and the instruction beside it
    const header = document.createElement("div");
    header.className = "quiz-header";

    const number = document.createElement("span");
    number.className = "quiz-number";
    number.textContent = index + 1;

    // No type name ("Word order" …) on the card: the instruction says what to do
    const titles = document.createElement("div");
    if (question.instruction) {
      const instruction = document.createElement("p");
      instruction.className = "quiz-instruction";
      instruction.textContent = question.instruction;
      titles.append(instruction);
    }

    header.append(number, titles);
    card.append(header);

    // Never show the answer before the learner answers (see hideAnswers)
    hideAnswers(question);

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
      words.append("New words: ");
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

  // Under the last question: a button for a fresh set, so there's no need to scroll back up.
  // It does the same as "Let's go" (same entry, level and focus), then jumps up to the new questions.
  const more = document.createElement("li");
  more.className = "quiz-more";
  // A plain button with no class, so it gets the same main-button look as "Let's go" in every theme
  const moreButton = document.createElement("button");
  moreButton.type = "button";
  moreButton.textContent = "New set of questions";
  moreButton.addEventListener("click", function () {
    makeQuestionsButton.click();
    quizStatus.scrollIntoView({ behavior: "smooth", block: "center" });
  });
  more.append(moreButton);
  quizList.append(more);
}

makeQuestionsButton.addEventListener("click", async function () {
  const entry = selectedEntry;
  if (!entry || !sentences.includes(entry) || entry.language !== myLanguage) {
    showQuizStatus("Select an entry above first.");
    return;
  }
  if (!openaiKey) {
    showQuizStatus("Add your OpenAI API key in Settings → OpenAI first.");
    return;
  }

  const level = myLevel || "A2"; // No level picked: a gentle A2
  makeQuestionsButton.disabled = true;
  quizList.innerHTML = "";
  showQuizStatus("Making " + level + " questions about " + practiceTarget + "s…");

  try {
    const questions = await makeQuestionSet(entry, level, practiceTarget);
    if (questions.length === 0) {
      showQuizStatus("GPT's questions couldn't be used. Please try again.");
    } else {
      showQuizStatus(level + " · " + practiceTarget + "s"); // No sentence preview: it could give answers away
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
// The theme is left out too: it belongs to the device, so a restore never changes it
// (and a "theme" inside an older backup is simply ignored).
const BACKUP_KEYS = ["sentences", "audioLibrary", "myLanguage", "myLanguages", LEVEL_KEY,
  "practiceTarget", "audioLoops", "audioSpeed", "openaiModel", "view", "knownWords", "knownByEntry", "knownWithoutEntry", "learningIds", "followAlong"];
// ("knownWords" is the old format: it only exists in older backups, and is moved over after the restore)

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
    const missing = []; // Files listed in My audio whose sound isn't in this browser
    for (const item of audioLibrary) {
      const file = await loadAudioFile(item.id);
      if (file) {
        audio[item.id] = { name: item.name, type: file.type, data: await fileToText(file) };
        // Its exact word timing too, so it never has to be asked for again
        if (audioTimings.has(item.id)) audio[item.id].timing = audioTimings.get(item.id);
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
  // Backup is the last section, so the box can open below the bottom of an iPhone's screen.
  // Wait a moment first: the iPhone's file picker is still closing, and a scroll now could get lost.
  setTimeout(function () {
    if (backupConfirm.hidden) return; // Already answered: nothing to show
    // Cancel gets the focus, so a stray Enter or VoiceOver tap can't replace the data by accident.
    // preventScroll: only the scroll below moves the page
    backupNo.focus({ preventScroll: true });
    // Glide to the box, or jump straight there if "Reduce motion" is switched on
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    backupConfirm.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "center" });
  }, 200);
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
      if (Array.isArray(audio.timing)) await storeTiming(id, audio.timing);
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
    // Open on the Study tab, at the top of the page, with no group or entry open
    const view = loadSaved("view", {});
    view.tab = "study-tab";
    view.openEntryGroup = null;
    view.selectedEntry = null;
    localStorage.setItem("view", JSON.stringify(view));
    try { sessionStorage.setItem("justRestored", "yes"); } catch {} // Start-up then scrolls to the top
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
// Just restored a backup: start at the top (the browser would jump back down to the Backup box)
try {
  if (sessionStorage.getItem("justRestored")) {
    sessionStorage.removeItem("justRestored");
    history.scrollRestoration = "manual";
    window.scrollTo(0, 0);
  }
} catch {}
showLevel();
fillLanguageMenu();
resetAddFormLanguage();
refreshAudioPickers(); // The Audio list shows the Add form's language
showSentences();
showTopicStatus();
loadAllTimings(); // Karaoke: each audio's exact word timing



// Smaller screens: make the open Practice/Immerse panel's scroll area end exactly at
// the bottom of the screen, so only the panel scrolls, not the whole page.
function fitStudyPanels() {
  document.querySelectorAll(".panel-scroll").forEach(function (area) {
    if (area.offsetParent === null) return;
    const top = area.getBoundingClientRect().top + window.scrollY;
    const space = (window.visualViewport ? window.visualViewport.height : window.innerHeight)
      - top - 16 /* box padding */ - 16 /* page padding */;
    // At least 80% of the screen tall, so more content shows at once
    const tall = Math.max(space, (window.visualViewport ? window.visualViewport.height : window.innerHeight) * 0.8);
    area.style.setProperty("--panel-max", Math.floor(tall) + "px");
  });
}
window.addEventListener("resize", fitStudyPanels);
if (window.visualViewport) window.visualViewport.addEventListener("resize", fitStudyPanels);
new ResizeObserver(fitStudyPanels).observe(document.getElementById("entry-list"));
fitStudyPanels();
