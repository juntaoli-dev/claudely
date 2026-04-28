// src/features/listen/transcriptStore.js
const fs = require('fs');
const path = require('path');

class TranscriptStore {
    constructor({ maxMinutes = 60, persistPath = null } = {}) {
        this.maxMs = maxMinutes * 60_000;
        this.lines = [];
        this.persistPath = persistPath;
        if (persistPath) {
            try {
                fs.mkdirSync(path.dirname(persistPath), { recursive: true });
                this._stream = fs.createWriteStream(persistPath, { flags: 'a' });
                this._stream.on('error', (e) => console.warn('[TranscriptStore] persist error:', e.message));
            } catch (e) {
                console.warn('[TranscriptStore] Could not open persist stream:', e.message);
                this._stream = null;
            }
        }
    }

    append(line) {
        this.lines.push(line);
        const cutoff = line.ts - this.maxMs;
        while (this.lines.length && this.lines[0].ts < cutoff) this.lines.shift();
        if (this._stream) {
            try { this._stream.write(JSON.stringify(line) + '\n'); } catch (_) {}
        }
    }

    tail({ now, seconds }) {
        const since = now - seconds * 1000;
        return this.lines
            .filter((l) => l.ts >= since)
            .map((l) => `${l.speaker}: ${l.text}`)
            .join('\n');
    }

    all() { return [...this.lines]; }

    close() {
        try { this._stream?.end(); } catch (_) {}
    }

    getPersistPath() {
        return this.persistPath || null;
    }
}

module.exports = { TranscriptStore };
