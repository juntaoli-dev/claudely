// src/features/classify/classifierBus.js
const { spawn } = require('child_process');
const { regexClassify } = require('./regexFallback');

class ClassifierBus {
    constructor({ binaryPath, spawnFn = spawn }) {
        this.binaryPath = binaryPath;
        this.spawnFn = spawnFn;
        this._proc = null;
        this._unavailable = false;
        this._queue = [];
        this._buffer = '';
    }

    start() {
        try {
            this._proc = this.spawnFn(this.binaryPath, []);
        } catch (e) {
            this._unavailable = true;
            return;
        }

        this._proc.stdout.on('data', (d) => {
            this._buffer += d.toString();
            let idx;
            while ((idx = this._buffer.indexOf('\n')) !== -1) {
                const line = this._buffer.slice(0, idx).trim();
                this._buffer = this._buffer.slice(idx + 1);
                const waiter = this._queue.shift();
                if (!waiter) continue;
                try { waiter.resolve(JSON.parse(line)); }
                catch { waiter.resolve({ addressed: false, question: null }); }
            }
        });
        this._proc.stderr.on('data', (d) => {
            const s = d.toString();
            if (s.includes('model-unavailable')) {
                this._unavailable = true;
                // drain any queued classify calls with regex.
                while (this._queue.length) {
                    const w = this._queue.shift();
                    w.resolve({ addressed: false, question: null });
                }
            }
        });
        this._proc.on('exit', () => { this._proc = null; });
    }

    async classify(utterance) {
        if (this._unavailable || !this._proc) return regexClassify(utterance);
        return new Promise((resolve, reject) => {
            this._queue.push({ resolve, reject });
            try { this._proc.stdin.write(utterance.replace(/\n/g, ' ') + '\n'); }
            catch {
                this._queue.pop();
                resolve(regexClassify(utterance));
            }
        });
    }

    stop() {
        try { this._proc?.kill(); } catch (_) {}
        this._proc = null;
    }
}

module.exports = { ClassifierBus };
