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
        claude: getClaude(),
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
};
