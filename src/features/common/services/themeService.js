// src/features/common/services/themeService.js
//
// Tiny wrapper around the `theme` field in ~/.claudely/config.json. The
// actual CSS variables live in src/ui/app/{header,content}.html under
// :root[data-theme="<name>"]; this service only stores which palette to
// activate and broadcasts changes (broadcast lives in featureBridge).

const config = require('../config/config');

// Keep this list in sync with the :root[data-theme="..."] blocks in the
// renderer HTML. If you add a palette there, add it here so the picker
// surfaces it.
const THEMES = ['default', 'pink', 'mint', 'amber', 'purple', 'red'];
const DEFAULT_THEME = 'pink';

function getCurrent() {
    const t = config.get('theme');
    return THEMES.includes(t) ? t : DEFAULT_THEME;
}

function list() {
    return THEMES.slice();
}

function set(name) {
    const safe = THEMES.includes(name) ? name : DEFAULT_THEME;
    try {
        config.set('theme', safe);
        // config.set only mutates the in-memory copy; saveUserConfig flushes
        // it back to ~/.claudely/config.json so the choice survives relaunch.
        if (typeof config.saveUserConfig === 'function') config.saveUserConfig();
    } catch (e) {
        console.warn('[themeService] failed to persist theme:', e.message);
    }
    return { name: safe };
}

module.exports = { getCurrent, list, set };
