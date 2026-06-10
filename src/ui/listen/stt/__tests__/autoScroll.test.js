import { describe, expect, it } from 'vitest';
import { getBottomGap, isNearBottom, TRANSCRIPT_BOTTOM_THRESHOLD_PX } from '../autoScroll.js';

function container({ scrollTop, clientHeight = 200, scrollHeight = 1000 }) {
    return { scrollTop, clientHeight, scrollHeight };
}

describe('transcript auto-scroll helpers', () => {
    it('treats a short transcript as pinned to the bottom', () => {
        expect(isNearBottom(container({ scrollTop: 0, clientHeight: 300, scrollHeight: 200 }))).toBe(true);
    });

    it('stays pinned inside the bottom threshold', () => {
        const nearBottom = container({
            scrollTop: 1000 - 200 - TRANSCRIPT_BOTTOM_THRESHOLD_PX + 1,
        });

        expect(getBottomGap(nearBottom)).toBe(TRANSCRIPT_BOTTOM_THRESHOLD_PX - 1);
        expect(isNearBottom(nearBottom)).toBe(true);
    });

    it('pauses auto-follow when the user scrolls away from the bottom', () => {
        const awayFromBottom = container({ scrollTop: 100 });

        expect(getBottomGap(awayFromBottom)).toBe(700);
        expect(isNearBottom(awayFromBottom)).toBe(false);
    });
});
