const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const config = require('../common/config/config');
const internalBridge = require('../../bridge/internalBridge');

function expandHome(input) {
    const value = String(input || '').trim();
    if (!value) return '';
    if (value === '~') return os.homedir();
    if (value.startsWith(`~${path.sep}`)) return path.join(os.homedir(), value.slice(2));
    return value;
}

function normalizeContextPath(input, { mustExist = true } = {}) {
    const expanded = expandHome(input);
    if (!expanded) throw new Error('Choose a folder for the code context.');
    const resolved = path.resolve(expanded);
    if (!mustExist) return resolved;
    let stat;
    try {
        stat = fs.statSync(resolved);
    } catch (_) {
        throw new Error(`Folder does not exist: ${resolved}`);
    }
    if (!stat.isDirectory()) throw new Error(`Code context must be a folder: ${resolved}`);
    try {
        return fs.realpathSync(resolved);
    } catch (_) {
        return resolved;
    }
}

function contextLabel(cwd) {
    const base = path.basename(cwd || '');
    return base || cwd || 'Code context';
}

class ContextService extends EventEmitter {
    constructor({ configStore = config, bridge = internalBridge, env = process.env } = {}) {
        super();
        this.config = configStore;
        this.bridge = bridge;
        this.env = env;
        this.runtimeCwd = null;
        this.switchHistory = [];
    }

    getActiveContext() {
        const configured = this.runtimeCwd
            || this.env.CLAUDELY_PROJECT_CWD
            || this.config.get('projectCwd')
            || path.join(os.homedir(), 'Documents/creative_studio_repo');
        const cwd = normalizeContextPath(configured, { mustExist: false });
        return {
            cwd,
            label: contextLabel(cwd),
        };
    }

    getRecentContexts() {
        const active = this.getActiveContext();
        const configured = this.config.get('recentProjectCwds');
        const list = Array.isArray(configured) ? configured : [];
        const normalized = [];
        for (const item of [active.cwd, ...list]) {
            try {
                const cwd = normalizeContextPath(item, { mustExist: false });
                if (!normalized.includes(cwd)) normalized.push(cwd);
            } catch (_) {}
        }
        return normalized.slice(0, 8).map((cwd) => ({ cwd, label: contextLabel(cwd) }));
    }

    getState() {
        return {
            active: this.getActiveContext(),
            recent: this.getRecentContexts(),
        };
    }

    setActiveContext(input, { source = 'settings' } = {}) {
        const previous = this.getActiveContext();
        const cwd = normalizeContextPath(input, { mustExist: true });
        const active = { cwd, label: contextLabel(cwd) };
        const changed = previous.cwd !== active.cwd;

        this.runtimeCwd = active.cwd;
        this.config.set('projectCwd', active.cwd);
        this.config.set('recentProjectCwds', this._nextRecent(active.cwd));
        this.config.saveUserConfig();

        const payload = {
            active,
            previous,
            recent: this.getRecentContexts(),
            changed,
            source,
            at: new Date().toISOString(),
        };

        if (changed) {
            this.switchHistory.push(payload);
            if (this.switchHistory.length > 200) this.switchHistory.splice(0, this.switchHistory.length - 200);
            this.emit('changed', payload);
            this.bridge?.emit?.('ai-context:changed', payload);
        }

        return payload;
    }

    getSwitchesBetween(from, to) {
        const fromMs = from ? new Date(from).getTime() : 0;
        const toMs = to ? new Date(to).getTime() : Date.now();
        return this.switchHistory.filter((event) => {
            const t = new Date(event.at).getTime();
            return t >= fromMs && t <= toMs;
        }).map((event) => ({
            at: event.at,
            source: event.source,
            previous: event.previous,
            active: event.active,
        }));
    }

    _nextRecent(activeCwd) {
        const configured = this.config.get('recentProjectCwds');
        const list = Array.isArray(configured) ? configured : [];
        const next = [];
        for (const item of [activeCwd, ...list]) {
            try {
                const cwd = normalizeContextPath(item, { mustExist: false });
                if (!next.includes(cwd)) next.push(cwd);
            } catch (_) {}
        }
        return next.slice(0, 8);
    }
}

const contextService = new ContextService();

module.exports = contextService;
module.exports.ContextService = ContextService;
module.exports.expandHome = expandHome;
module.exports.normalizeContextPath = normalizeContextPath;
