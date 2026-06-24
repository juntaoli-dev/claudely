import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { hasPcmSignal } = require('../sttService.js');

function pcm16(samples) {
    const buf = Buffer.alloc(samples.length * 2);
    samples.forEach((sample, index) => buf.writeInt16LE(sample, index * 2));
    return buf;
}

describe('hasPcmSignal', () => {
    it('treats zero-filled PCM as silence', () => {
        expect(hasPcmSignal(pcm16([0, 0, 0, 0]))).toBe(false);
    });

    it('detects signal above the threshold on either polarity', () => {
        expect(hasPcmSignal(pcm16([0, 15, -16]), 16)).toBe(true);
    });

    it('ignores low-level noise below the threshold', () => {
        expect(hasPcmSignal(pcm16([1, -8, 15]), 16)).toBe(false);
    });
});
