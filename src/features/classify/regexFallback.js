// src/features/classify/regexFallback.js
//
// Used when the Swift FoundationModels classifier is unavailable (Apple
// Intelligence off, older macOS, etc). Heuristic only: a question is either an
// interrogative starter or ends in "?".

const STARTS = /^\s*(what|how|can|could|does|do|is|are|why|when|where|which|who)\b/i;

function regexClassify(utterance) {
    const addressed = STARTS.test(utterance) || /\?\s*$/.test(utterance);
    return { addressed, question: addressed ? utterance.trim() : null };
}

module.exports = { regexClassify };
