// ===== Topics by meaning (built-in AI model) =====
// A small AI model turns a sentence into a list of numbers that describes its meaning
// (a "meaning fingerprint"). Sentences about similar things get similar fingerprints,
// even in different languages. We compare each sentence's fingerprint with the example
// phrases in topics.js and keep the topics that fit best.
//
// The model (about 118 MB) is downloaded the first time it's needed. After that the
// browser keeps it, so it loads quickly and works without downloading again.

const AI_LIBRARY_URL = "https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2";
const AI_MODEL = "Xenova/paraphrase-multilingual-MiniLM-L12-v2";

// Settings for choosing topics. Scores go from about 0 (unrelated) to 1 (same meaning).
const MIN_SCORE = 0.3;       // A topic must score at least this to be used at all
const CLOSE_TO_BEST = 0.07;  // Other topics are kept if they score nearly as well as the best one
const MAX_TOPICS = 3;        // Never more than this many topics per sentence
const KEYWORD_BONUS = 0.1;   // Extra score for a topic whose keywords appear in the sentence

// "not loaded", "loading", "ready" or "failed"
let aiStatus = "not loaded";
let aiProgress = 0; // Download progress in %, while loading

// app.js replaces this to update the page whenever the status changes
let onAiStatusChange = function () {};

function setAiStatus(status) {
  aiStatus = status;
  onAiStatusChange();
}

let modelPromise = null;   // The model, once loading has started
let topicFingerprints = {}; // { Food: [fingerprint, fingerprint...], ... }

// Turn the model's output into a list of fingerprints (one per input text)
function toFingerprints(output) {
  const [count, size] = output.dims;
  const fingerprints = [];
  for (let i = 0; i < count; i++) {
    fingerprints.push(Array.from(output.data.slice(i * size, (i + 1) * size)));
  }
  return fingerprints;
}

// How similar two fingerprints are (they're already scaled, so this is enough)
function similarity(a, b) {
  let total = 0;
  for (let i = 0; i < a.length; i++) {
    total += a[i] * b[i];
  }
  return total;
}

// Load the model (only once) and make fingerprints of the topic examples
function loadAiModel() {
  if (modelPromise) {
    return modelPromise;
  }

  aiProgress = 0;
  setAiStatus("loading");

  modelPromise = import(AI_LIBRARY_URL)
    .then(async function (library) {
      library.env.allowLocalModels = false; // Always get the model from the internet (then the browser keeps it)

      const model = await library.pipeline("feature-extraction", AI_MODEL, {
        quantized: true, // The smaller version of the model
        progress_callback: function (info) {
          if (info.status === "progress" && info.file.endsWith(".onnx")) {
            aiProgress = Math.round(info.progress);
            onAiStatusChange();
          }
        },
      });

      for (const topic of Object.keys(TOPIC_EXAMPLES)) {
        const output = await model(TOPIC_EXAMPLES[topic], { pooling: "mean", normalize: true });
        topicFingerprints[topic] = toFingerprints(output);
      }

      setAiStatus("ready");
      return model;
    })
    .catch(function (error) {
      console.error("The topic model couldn't be loaded:", error);
      modelPromise = null; // Try again next time
      setAiStatus("failed");
      throw error;
    });

  return modelPromise;
}

// Score every topic for a sentence, best first: [{ topic: "Food", score: 0.52 }, ...]
async function scoreTopics(text, language) {
  const model = await loadAiModel();
  const output = await model(text, { pooling: "mean", normalize: true });
  const fingerprint = toFingerprints(output)[0];
  const keywordTopics = detectTopics(text, language);

  const scores = Object.keys(topicFingerprints).map(function (topic) {
    // The topic's score is how close the sentence is to its closest example
    let score = Math.max(...topicFingerprints[topic].map(function (example) {
      return similarity(fingerprint, example);
    }));
    if (keywordTopics.includes(topic)) {
      score += KEYWORD_BONUS;
    }
    return { topic: topic, score: score };
  });

  return scores.sort(function (a, b) { return b.score - a.score; });
}

// Find the topics that fit a sentence best.
// If the model can't be used, fall back to the keyword lists in topics.js.
async function findTopics(text, language) {
  try {
    const scores = await scoreTopics(text, language);
    const best = scores[0].score;
    return scores
      .filter(function (item) {
        return item.score >= MIN_SCORE && item.score >= best - CLOSE_TO_BEST;
      })
      .slice(0, MAX_TOPICS)
      .map(function (item) { return item.topic; });
  } catch {
    return detectTopics(text, language);
  }
}
