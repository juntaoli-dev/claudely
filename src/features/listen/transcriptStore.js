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

    // Formatted transcript of every line newer than the given epoch-ms
    // timestamp. Used to send only the delta since the last ask to Claude
    // when the Listen session has a resumable Claude session id. Pass 0 to
    // get the entire in-memory window.
    since(ts) {
        const t = Number(ts) || 0;
        return this.lines
            .filter((l) => l.ts > t)
            .map((l) => `${l.speaker}: ${l.text}`)
            .join('\n');
    }

    // Epoch-ms timestamp of the newest line in the window, or null when
    // empty. FireDispatcher snapshots this at fire time so
    // lastTranscriptSentTs reflects what was actually sent, not when the
    // answer finished streaming (lines spoken during a slow answer used to
    // fall into that gap and never reach the assistant).
    latestTs() {
        return this.lines.length ? this.lines[this.lines.length - 1].ts : null;
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
