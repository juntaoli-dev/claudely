import { describe, it, expect } from 'vitest';
import { createInterleaver } from '../interleaver.js';

function pcm16(samples) {
    const buf = Buffer.alloc(samples.length * 2);
    samples.forEach((s, i) => buf.writeInt16LE(s, i * 2));
    return buf;
}

function readSamples(buf) {
    const out = [];
    for (let i = 0; i < buf.length; i += 2) out.push(buf.readInt16LE(i));
    return out;
}

describe('createInterleaver', () => {
    it('interleaves balanced tracks into stereo frames', () => {
        const frames = [];
        const il = createInterleaver({ onFrame: (b) => frames.push(b) });
        il.push(0, pcm16([1, 2, 3]));
        il.push(1, pcm16([-1, -2, -3]));
        expect(frames.length).toBe(1);
        expect(readSamples(frames[0])).toEqual([1, -1, 2, -2, 3, -3]);
        expect(il.pendingBytes(0)).toBe(0);
        expect(il.pendingBytes(1)).toBe(0);
    });

    it('holds a small lead without emitting or padding', () => {
        const frames = [];
        const il = createInterleaver({ maxLagBytes: 1000, onFrame: (b) => frames.push(b) });
        il.push(0, pcm16([5, 6]));
        expect(frames.length).toBe(0);
        expect(il.pendingBytes(0)).toBe(4);
    });

    it('stays bounded when one track starves, padding the other with silence', () => {
        const frames = [];
        const il = createInterleaver({ maxLagBytes: 1000, onFrame: (b) => frames.push(b) });
        // Simulate a dead mic: only track 0 ever produces. 100 chunks of 100
        // samples = 20000 bytes, way past the 1000-byte lag cap.
        for (let i = 0; i < 100; i++) {
            il.push(0, pcm16(new Array(100).fill(7)));
        }
        // The leading track must never accumulate past the cap.
        expect(il.pendingBytes(0)).toBeLessThanOrEqual(1000);
        expect(il.pendingBytes(1)).toBe(0);
        // Everything over the cap was flushed as stereo with silent track 1.
        const totalStereoBytes = frames.reduce((n, b) => n + b.length, 0);
        expect(totalStereoBytes).toBeGreaterThanOrEqual((20000 - 1000) * 2);
        const last = frames[frames.length - 1];
        const samples = readSamples(last);
        for (let i = 0; i < samples.length; i += 2) {
            expect(samples[i]).toBe(7);      // real audio preserved
            expect(samples[i + 1]).toBe(0);  // starved track padded with silence
        }
    });

    it('resumes normal interleave after a starvation flush', () => {
        const frames = [];
        const il = createInterleaver({ maxLagBytes: 8, onFrame: (b) => frames.push(b) });
        il.push(0, pcm16([1, 2, 3, 4, 5, 6])); // 12 bytes > 8, triggers flush
        frames.length = 0;
        il.push(0, pcm16([9]));
        il.push(1, pcm16([-9]));
        expect(frames.length).toBe(1);
        expect(readSamples(frames[0])).toEqual([9, -9]);
    });
});
