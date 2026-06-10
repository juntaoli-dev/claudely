export const TRANSCRIPT_BOTTOM_THRESHOLD_PX = 48;

export function getBottomGap(container) {
    if (!container) return 0;
    const scrollTop = Number(container.scrollTop) || 0;
    const clientHeight = Number(container.clientHeight) || 0;
    const scrollHeight = Number(container.scrollHeight) || 0;
    return Math.max(0, scrollHeight - clientHeight - scrollTop);
}

export function isNearBottom(container, thresholdPx = TRANSCRIPT_BOTTOM_THRESHOLD_PX) {
    if (!container) return true;
    const scrollHeight = Number(container.scrollHeight) || 0;
    const clientHeight = Number(container.clientHeight) || 0;
    if (scrollHeight <= clientHeight) return true;
    return getBottomGap(container) <= thresholdPx;
}
