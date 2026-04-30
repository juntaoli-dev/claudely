// src/features/shortcuts/keyholdManager.js
//
// Hold-to-move for Shift+Arrow, optimized so it doesn't lag the desktop.
//
// Strategy:
//   1. Register Shift+Arrow with Electron's globalShortcut. That fires once
//      on press, suppresses the keystroke from reaching the focused app, and
//      costs ~zero at idle (no system-wide event tap).
//   2. On press: emit the first move tick AND lazily start uiohook-napi for
//      this brief hold window so we can detect keyup (globalShortcut doesn't
//      surface keyup events).
//   3. setInterval drives the repeat tick at ~35ms.
//   4. uiohook keyup for the active arrow → stop the timer AND stop uiohook.
//      A 2.5s safety timer also stops everything if keyup is missed (e.g.
//      the user switched apps mid-hold).
//
// Net effect: uiohook only runs WHILE the user is holding Shift+Arrow, not
// 24/7. CGEventTap traffic stops the moment the hold ends, so the laptop
// stays responsive when Claudely is open. Outside of holds, only
// globalShortcut is registered, which has no per-event cost.

const { globalShortcut } = require('electron');
const internalBridge = require('../../bridge/internalBridge');

let uIOhook = null;
let UiohookKey = null;
let hookLoaded = false;
let hookStarted = false;
let holdTimer = null;
let safetyTimer = null;
let activeDirection = null;

const ARROWS = ['Left', 'Right', 'Up', 'Down'];

function loadHookLib() {
    if (hookLoaded) return !!uIOhook;
    hookLoaded = true;
    try {
        const mod = require('uiohook-napi');
        uIOhook = mod.uIOhook;
        UiohookKey = mod.UiohookKey;
        return true;
    } catch (e) {
        console.warn('[KeyHold] uiohook-napi unavailable; hold-to-move will fall back to single-tap moves only:', e.message);
        return false;
    }
}

function dirByKeycode() {
    if (!UiohookKey) return {};
    return {
        [UiohookKey.ArrowLeft]: 'left',
        [UiohookKey.ArrowRight]: 'right',
        [UiohookKey.ArrowUp]: 'up',
        [UiohookKey.ArrowDown]: 'down',
    };
}

function onKeyUp(e) {
    const dir = dirByKeycode()[e.keycode];
    if (dir && dir === activeDirection) stopHold();
}

function startUiohook() {
    if (hookStarted) return;
    if (!loadHookLib()) return;
    try {
        uIOhook.on('keyup', onKeyUp);
        uIOhook.start();
        hookStarted = true;
    } catch (e) {
        console.warn('[KeyHold] uiohook.start failed (Accessibility TCC?):', e.message);
        hookStarted = false;
    }
}

function stopUiohook() {
    if (!hookStarted) return;
    try {
        uIOhook.removeAllListeners('keyup');
        uIOhook.stop();
    } catch (_) {}
    hookStarted = false;
}

function startHold(direction, intervalMs = 35) {
    // If we're already holding this direction, leave the existing repeat
    // running so consecutive globalShortcut fires don't reset the cadence.
    if (activeDirection === direction && holdTimer) return;
    stopHold();
    activeDirection = direction;
    holdTimer = setInterval(() => {
        internalBridge.emit('window:moveStep', { direction, hold: true });
    }, intervalMs);
    safetyTimer = setTimeout(stopHold, 2500);
    startUiohook();
}

function stopHold() {
    if (holdTimer) { clearInterval(holdTimer); holdTimer = null; }
    if (safetyTimer) { clearTimeout(safetyTimer); safetyTimer = null; }
    activeDirection = null;
    stopUiohook();
}

function start() {
    let registered = 0;
    for (const arrow of ARROWS) {
        const accel = `Shift+${arrow}`;
        const dir = arrow.toLowerCase();
        try {
            const ok = globalShortcut.register(accel, () => {
                // First tick fires synchronously so the very first nudge
                // lands without waiting for the setInterval cadence.
                internalBridge.emit('window:moveStep', { direction: dir, hold: true });
                startHold(dir);
            });
            if (ok) registered++;
            else console.warn(`[KeyHold] could not register ${accel} (OS may reserve it)`);
        } catch (e) {
            console.warn(`[KeyHold] register ${accel} threw:`, e.message);
        }
    }
    if (registered === 0) {
        console.warn('[KeyHold] no Shift+Arrow shortcuts registered. Hold-to-move disabled this session.');
        return false;
    }
    console.log(`[KeyHold] registered ${registered}/4 Shift+Arrow shortcuts (uiohook armed lazily on press)`);
    return true;
}

function stop() {
    stopHold();
    for (const arrow of ARROWS) {
        try { globalShortcut.unregister(`Shift+${arrow}`); } catch (_) {}
    }
}

module.exports = { start, stop };
