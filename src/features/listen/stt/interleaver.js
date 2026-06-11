// src/features/listen/stt/interleaver.js
//
// Bounded two-track PCM interleaver. Pairs 16-bit mono samples from track 0
// (system audio) and track 1 (mic) into stereo frames for Deepgram
// multichannel. The lag cap is the long-session safety valve: if one track
// starves (dead mic, dormant Zoom call), the other track's backlog is flushed
// against synthesized silence instead of accumulating forever. Without the
// cap, every incoming chunk re-copies an ever-growing pending buffer and the
// main process ends up memmove-bound after a few hours.

// 16kHz * 2 bytes/sample = 32000 bytes/s per track; 2s of lead.
const DEFAULT_MAX_LAG_BYTES = 64000;

function interleave(a, b) {
    const samples = a.length / 2;
    const out = Buffer.alloc(samples * 4);
    for (let i = 0; i < samples; i++) {
        out.writeInt16LE(a.readInt16LE(i * 2), i * 4);
        out.writeInt16LE(b.readInt16LE(i * 2), i * 4 + 2);
    }
    return out;
}

function createInterleaver({ maxLagBytes = DEFAULT_MAX_LAG_BYTES, onFrame } = {}) {
    const pending = { 0: Buffer.alloc(0), 1: Buffer.alloc(0) };

    function consume(bytes) {
        const a = pending[0].subarray(0, bytes);
        const b = pending[1].subarray(0, bytes);
        pending[0] = pending[0].subarray(bytes);
        pending[1] = pending[1].subarray(bytes);
        onFrame?.(interleave(a, b));
    }

    return {
        push(track, pcm) {
            if (track !== 0 && track !== 1) return;
            pending[track] = Buffer.concat([pending[track], pcm]);

            const common = Math.min(pending[0].length, pending[1].length) & ~1;
            if (common > 0) consume(common);

            // One side is now empty. If the other side has built up past the
            // lag cap, the empty track is starved: flush the backlog against
            // silence so pending bytes stay bounded for the life of the app.
            const lead = pending[0].length >= pending[1].length ? 0 : 1;
            const excess = pending[lead].length & ~1;
            if (excess > maxLagBytes) {
                pending[1 - lead] = Buffer.concat([pending[1 - lead], Buffer.alloc(excess - pending[1 - lead].length)]);
                consume(excess);
            }
        },
        pendingBytes(track) {
            return pending[track].length;
        },
    };
}

module.exports = { createInterleaver };
