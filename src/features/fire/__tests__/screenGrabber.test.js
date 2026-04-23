import { describe, it, expect, vi } from 'vitest';
import { ScreenGrabber } from '../screenGrabber.js';

describe('ScreenGrabber', () => {
    it('writes PNG to tmp and returns path', async () => {
        const sources = [{ thumbnail: { toPNG: () => Buffer.from('fakepng') } }];
        const fakeCapturer = { getSources: vi.fn(async () => sources) };
        const fakeFs = { writeFileSync: vi.fn(), mkdirSync: vi.fn() };
        const g = new ScreenGrabber({ capturer: fakeCapturer, fs: fakeFs, tmpDir: '/tmp/claudely' });
        const p = await g.grab();
        expect(p).toMatch(/\/tmp\/claudely\/screen-.*\.png/);
        expect(fakeFs.writeFileSync).toHaveBeenCalledOnce();
    });
});
