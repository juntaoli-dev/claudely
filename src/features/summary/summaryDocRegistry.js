// src/features/summary/summaryDocRegistry.js
//
// Small durable map from meeting identity -> Google Doc id. Apps Script can
// update a Doc in place when given docId; this registry keeps that id across
// app restarts and repeated Listen sessions for the same calendar occurrence.

const fs = require('fs');
const os = require('os');
const path = require('path');

function defaultRegistryPath() {
    return process.env.CLAUDELY_SUMMARY_DOC_REGISTRY_PATH
        || path.join(os.homedir(), 'Library/Application Support/Claudely/summary-doc-registry.json');
}

class SummaryDocRegistry {
    constructor({ filePath } = {}) {
        this.filePath = filePath || defaultRegistryPath();
    }

    _load() {
        try {
            if (!fs.existsSync(this.filePath)) return { version: 1, docs: {} };
            const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
            if (!parsed || typeof parsed !== 'object') return { version: 1, docs: {} };
            if (!parsed.docs || typeof parsed.docs !== 'object') parsed.docs = {};
            parsed.version = parsed.version || 1;
            return parsed;
        } catch (e) {
            console.warn('[SummaryDocRegistry] could not load registry:', e.message);
            return { version: 1, docs: {} };
        }
    }

    _save(registry) {
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        const tmp = `${this.filePath}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(registry, null, 2));
        fs.renameSync(tmp, this.filePath);
    }

    getDocId(key) {
        if (!key) return null;
        const entry = this._load().docs[key];
        return entry?.docId || null;
    }

    remember(identity, docId, extra = {}) {
        if (!identity?.key || !docId) return null;
        const registry = this._load();
        const existing = registry.docs[identity.key] || {};
        const now = new Date().toISOString();
        registry.docs[identity.key] = {
            ...existing,
            ...extra,
            docId,
            kind: identity.kind,
            title: identity.title,
            event: identity.event ? {
                title: identity.event.title || '',
                start: identity.event.start || '',
                end: identity.event.end || '',
                uid: identity.event.uid || '',
                calendar: identity.event.calendar || '',
            } : null,
            firstSeenAt: existing.firstSeenAt || now,
            updatedAt: now,
        };
        this._save(registry);
        return registry.docs[identity.key];
    }
}

let defaultRegistry = null;
function getDefaultRegistry() {
    if (!defaultRegistry) defaultRegistry = new SummaryDocRegistry();
    return defaultRegistry;
}

module.exports = {
    SummaryDocRegistry,
    getDefaultRegistry,
    defaultRegistryPath,
};
