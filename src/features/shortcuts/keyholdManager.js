// src/features/shortcuts/keyholdManager.js
//
// Continuous hold-to-move shortcuts. Electron's globalShortcut fires once per
// press and ignores OS key-repeat, so holding Shift+Arrow only nudges the
// window once. This module hooks the system-wide keyboard via uiohook-napi
// and runs a smooth repeater while the combo is held.
//
// macOS requires Accessibility permission for the host app to receive global
// key events. We fail soft if the lib doesn't load or the user hasn't
// granted accessibility — globalShortcut still handles single-tap moves.

const internalBridge = require('../../bridge/internalBridge');

let uIOhook = null;
let UiohookKey = null;
let started = false;
let holdTimer = null;
let activeDirection = null;

function load() {
    if (uIOhook) return true;
    try {
        const mod = require('uiohook-napi');
        uIOhook = mod.uIOhook;
        UiohookKey = mod.UiohookKey;
        return true;
    } catch (e) {
        console.warn('[KeyHold] uiohook-napi unavailable:', e.message);
        return false;
    }
}

const DIRECTION_FOR_KEY = () => ({
    [UiohookKey.ArrowLeft]: 'left',
    [UiohookKey.ArrowRight]: 'right',
    [UiohookKey.ArrowUp]: 'up',
    [UiohookKey.ArrowDown]: 'down',
});

function startHold(direction, intervalMs = 35) {
    stopHold();
    activeDirection = direction;
    // Kick once immediately so the first frame lands without delay.
    internalBridge.emit('window:moveStep', { direction, hold: true });
    holdTimer = setInterval(() => {
        internalBridge.emit('window:moveStep', { direction, hold: true });
    }, intervalMs);
}

function stopHold() {
    if (holdTimer) {
        clearInterval(holdTimer);
        holdTimer = null;
    }
    activeDirection = null;
}

function start() {
    if (started) return true;
    if (!load()) return false;

    const dirMap = DIRECTION_FOR_KEY();

    uIOhook.on('keydown', (e) => {
        // Require Shift; ignore when other modifiers (cmd/ctrl/alt) are held so
        // we don't fight system shortcuts.
        if (!e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
        const dir = dirMap[e.keycode];
        if (!dir) return;
        if (activeDirection === dir) return; // already running
        startHold(dir);
    });

    uIOhook.on('keyup', (e) => {
        const dir = dirMap[e.keycode];
        if (!dir) return;
        if (activeDirection === dir) stopHold();
    });

    try {
        uIOhook.start();
        started = true;
        console.log('[KeyHold] uiohook started; Shift+Arrow hold-to-move active');
        return true;
    } catch (e) {
        console.warn('[KeyHold] uiohook start failed (likely Accessibility not granted):', e.message);
        started = false;
        return false;
    }
}

function stop() {
    if (!started) return;
    try { uIOhook.stop(); } catch (_) {}
    started = false;
    stopHold();
}

module.exports = { start, stop };
