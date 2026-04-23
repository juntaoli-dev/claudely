import { describe, it, expect } from 'vitest';
import { parseFrames } from '../audioBus.js';

describe('parseFrames', () => {
  it('emits one frame per length-prefixed chunk', () => {
    const buf = Buffer.concat([
      Buffer.from([0, 0, 0, 5, 0, 0xaa, 0xbb, 0xcc, 0xdd]),
      Buffer.from([0, 0, 0, 3, 1, 0xee, 0xff]),
    ]);
    const frames = [];
    const remaining = parseFrames(buf, (track, pcm) => frames.push({ track, pcm: [...pcm] }));
    expect(frames).toEqual([
      { track: 0, pcm: [0xaa, 0xbb, 0xcc, 0xdd] },
      { track: 1, pcm: [0xee, 0xff] },
    ]);
    expect(remaining.length).toBe(0);
  });

  it('returns leftover bytes when a frame is truncated', () => {
    const buf = Buffer.from([0, 0, 0, 5, 0, 0xaa, 0xbb]);
    const frames = [];
    const remaining = parseFrames(buf, (t, p) => frames.push({ t, p }));
    expect(frames.length).toBe(0);
    expect(remaining.length).toBe(7);
  });
});
