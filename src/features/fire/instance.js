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
const { AssistantSession } = require('../ai/assistantSession');
const config = require('../common/config/config');
const contextService = require('../context/contextService');

let sharedGrabber = null;
let sharedAssistant = null;

function getGrabber() {
    if (!sharedGrabber) sharedGrabber = new ScreenGrabber({ capturer: desktopCapturer });
    return sharedGrabber;
}

function getAssistant() {
    if (!sharedAssistant) {
        const context = contextService.getActiveContext();
        sharedAssistant = new AssistantSession({
            cwd: context.cwd,
            codexModel: process.env.CLAUDELY_CODEX_MODEL || config.get('codexModel') || null,
            claudeModel: process.env.CLAUDELY_CLAUDE_MODEL || process.env.CLAUDELY_MODEL || config.get('claudeModel') || config.get('model'),
        });
        console.log(`[AI Context] Assistant session ready in ${context.cwd}`);
    }
    return sharedAssistant;
}

function resetAssistant() {
    sharedAssistant = null;
}

contextService.on('changed', ({ active }) => {
    resetAssistant();
    console.log(`[AI Context] Switched to ${active.cwd}; next ask will use a fresh assistant session.`);
});

function getAssistantProxy() {
    return {
        ask: (args) => getAssistant().ask(args),
    };
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
        assistant: getAssistantProxy(),
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
    resetAssistant,
    getActiveListenSessionId,
    updateActiveListenSessionId,
};
