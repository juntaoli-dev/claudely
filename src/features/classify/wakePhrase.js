// src/features/classify/wakePhrase.js
function matchWake(utterance, phrases) {
    if (!utterance || !phrases?.length) return null;
    const lower = utterance.toLowerCase();
    // Check the longest phrases first so "hey claudely" isn't swallowed by
    // "hey claude".
    const sorted = [...phrases].sort((a, b) => b.length - a.length);
    for (const p of sorted) {
        if (lower.startsWith(p.toLowerCase())) {
            return utterance.slice(p.length).replace(/^[,\s]+/, '').trim() || null;
        }
    }
    return null;
}
module.exports = { matchWake };
