// src/features/fire/instance.js
//
// Centralised FireDispatcher construction. STT registers the live
// transcript store + classifier here so manual-ask paths (Cmd+Enter,
// ask:question) can pull from them at fire time. Without registration the
// manual dispatcher falls back to no-op stubs.

const path = require('path');
const { desktopCapturer } = require('electron');
const { FireDispatcher } = require('./fireDispatcher');
const { ScreenGrabber } = require('./screenGrabber');
const { ClaudeSession } = require('../claude/claudeSession');
const config = require('../common/config/config');

let sharedGrabber = null;
let sharedClaude = null;

function getGrabber() {
    if (!sharedGrabber) sharedGrabber = new ScreenGrabber({ capturer: desktopCapturer });
    return sharedGrabber;
}

function getClaude() {
    if (!sharedClaude) {
        sharedClaude = new ClaudeSession({
            cwd: process.env.CLAUDELY_PROJECT_CWD || config.get('projectCwd'),
            model: process.env.CLAUDELY_MODEL || config.get('model'),
        });
    }
    return sharedClaude;
}

// Active listen context: sttService sets these on listen:start, clears on stop.
// listenServiceSessionId is the DB sessions.id row for the live Listen
// session — the row that holds claude_session_id + last_transcript_sent_ts.
let activeStore = null;
let activeClassifier = null;
let activeListenSessionId = null;
// Partial-update semantics: only keys present in the call modify state.
// sttService calls with { store, classifier } and must NOT clobber the
// listenSessionId that listenService set moments earlier. Equally,
// updateActiveListenSessionId must not wipe the store. This used to silently
// blank activeListenSessionId every stt.start, breaking the resume path.
function setActiveListenContext(ctx = {}) {
    if ('store' in ctx) activeStore = ctx.store || null;
    if ('classifier' in ctx) activeClassifier = ctx.classifier || null;
    if ('listenSessionId' in ctx) activeListenSessionId = ctx.listenSessionId || null;
}
function clearActiveListenContext() {
    activeStore = null;
    activeClassifier = null;
    activeListenSessionId = null;
}
function getActiveStore() { return activeStore; }
function getActiveClassifier() { return activeClassifier; }
function getActiveListenSessionId() { return activeListenSessionId; }

// Patch just the listen-session id without disturbing store/classifier.
// Called by listenService once it knows the DB sessions.id, which arrives
// AFTER sttService has already wired the store + classifier.
function updateActiveListenSessionId(id) {
    activeListenSessionId = id || null;
}

// Build a per-dispatcher provider that reads/writes the Claude resume row
// on the LIVE Listen session at fire time. Captured at construction so a
// dispatcher built mid-session keeps pointing at the same row even if a
// later Listen session starts; returns null in non-Listen contexts so the
// dispatcher falls back to the legacy 30s-tail no-resume path.
function buildClaudeContextProvider() {
    const listenSessionId = activeListenSessionId;
    if (!listenSessionId) return null;
    const sessionRepository = require('../common/repositories/session');
    return {
        get() {
            try { return sessionRepository.getClaudeContext(listenSessionId); }
            catch (_) { return { claudeSessionId: null, lastTranscriptSentTs: null }; }
        },
        set(ctx) {
            try { sessionRepository.setClaudeContext(listenSessionId, ctx); }
            catch (_) { /* best-effort */ }
        },
    };
}

function buildDispatcher({ store, classifier, onState }) {
    return new FireDispatcher({
        store: store || activeStore || { tail: () => '' },
        classifier: classifier || activeClassifier || { classify: async () => ({ addressed: false, question: null }) },
        grabber: getGrabber(),
        claude: getClaude(),
        config,
        onState: onState || (() => {}),
        claudeContextProvider: buildClaudeContextProvider(),
    });
}

// Manual-ask dispatcher: rebuilt every call so it always pulls the LIVE
// active store + classifier (not a stale stub from when listen wasn't on).
function getManualDispatcher({ onState } = {}) {
    return buildDispatcher({ onState });
}

module.exports = {
    buildDispatcher,
    getManualDispatcher,
    setActiveListenContext,
    clearActiveListenContext,
    getActiveStore,
    getActiveClassifier,
    getActiveListenSessionId,
    updateActiveListenSessionId,
};
