// src/features/audio/audioBus.js
const { spawn } = require('child_process');
const EventEmitter = require('events');

function parseFrames(buffer, emit) {
    let offset = 0;
    while (buffer.length - offset >= 5) {
        const totalLen = buffer.readUInt32BE(offset);
        if (buffer.length - offset - 4 < totalLen) break;
        const track = buffer[offset + 4];
        const pcm = buffer.subarray(offset + 5, offset + 4 + totalLen);
        emit(track, pcm);
        offset += 4 + totalLen;
    }
    return buffer.subarray(offset);
}

class AudioBus extends EventEmitter {
    constructor({ binaryPath, bundleId = 'us.zoom.xos' }) {
        super();
        this.binaryPath = binaryPath;
        this.bundleId = bundleId;
        this._buffer = Buffer.alloc(0);
        this._proc = null;
    }

    start() {
        this._proc = spawn(this.binaryPath, [this.bundleId]);
        this._proc.stdout.on('data', (chunk) => {
            this._buffer = Buffer.concat([this._buffer, chunk]);
            this._buffer = parseFrames(this._buffer, (track, pcm) => this.emit('pcm', { track, pcm }));
        });
        this._proc.stderr.on('data', (d) => this.emit('stderr', d.toString()));
        this._proc.on('exit', (code) => this.emit('exit', code));
    }

    stop() {
        this._proc?.kill();
        this._proc = null;
    }
}

module.exports = { AudioBus, parseFrames };
