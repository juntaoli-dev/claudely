// src/features/fire/instance.js
//
// Centralised FireDispatcher construction. The STT pipeline builds one per
// listen session (pointing at the current transcript store + classifier). The
// manual-ask IPC path grabs or lazily builds a minimal dispatcher when no
// listen session is active, so Cmd+Enter still works before you start
// capturing audio.

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

function buildDispatcher({ store, classifier, onState }) {
    return new FireDispatcher({
        store: store || { tail: () => '' },
        classifier: classifier || { classify: async () => ({ addressed: false, question: null }) },
        grabber: getGrabber(),
        claude: getClaude(),
        config,
        onState: onState || (() => {}),
    });
}

// Manual-ask fallback dispatcher: one shared instance, no classifier, no
// transcript store. Used when the user presses Cmd+Enter without an active
// listen session.
let manualDispatcher = null;
function getManualDispatcher({ onState } = {}) {
    if (!manualDispatcher) {
        manualDispatcher = buildDispatcher({ onState });
    } else if (onState) {
        // swap the onState hook so the latest requester gets the stream.
        manualDispatcher.onState = onState;
    }
    return manualDispatcher;
}

module.exports = { buildDispatcher, getManualDispatcher };
