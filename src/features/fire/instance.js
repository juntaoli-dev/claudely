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
let activeStore = null;
let activeClassifier = null;
function setActiveListenContext({ store, classifier }) {
    activeStore = store || null;
    activeClassifier = classifier || null;
}
function clearActiveListenContext() {
    activeStore = null;
    activeClassifier = null;
}
function getActiveStore() { return activeStore; }
function getActiveClassifier() { return activeClassifier; }

function buildDispatcher({ store, classifier, onState }) {
    return new FireDispatcher({
        store: store || activeStore || { tail: () => '' },
        classifier: classifier || activeClassifier || { classify: async () => ({ addressed: false, question: null }) },
        grabber: getGrabber(),
        assistant: getAssistantProxy(),
        config,
        onState: onState || (() => {}),
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
};
