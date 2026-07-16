// src/features/summary/summaryIdentity.js
//
// Build a stable identity for the Google Doc that receives a meeting summary.
// Calendar-backed sessions use the calendar event occurrence, not the generated
// summary headline, so live and final summaries update one document.

const crypto = require('crypto');

function cleanText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function toDate(value) {
    if (!value) return null;
    const d = value instanceof Date ? value : new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
}

function toIso(value) {
    const d = toDate(value);
    return d ? d.toISOString() : cleanText(value);
}

function hashKey(seed) {
    return crypto.createHash('sha256').update(seed).digest('hex').slice(0, 24);
}

function eventActive(event) {
    return !!(event?.isActive || event?.is_active_at_close);
}

function isAvailabilityBlock(event) {
    const title = cleanText(event?.title);
    if (!title) return false;
    return /\b(?:ooo|pto)\b/i.test(title)
        || /\bout\s+of\s+office\b/i.test(title)
        || /\bpaid\s+time\s+off\b/i.test(title);
}

function overlapMs(event, windowStart, windowEnd) {
    const eventStart = toDate(event?.start);
    const eventEnd = toDate(event?.end);
    const start = toDate(windowStart);
    const end = toDate(windowEnd);
    if (!eventStart || !eventEnd || !start || !end) return 0;
    return Math.max(0, Math.min(eventEnd.getTime(), end.getTime()) - Math.max(eventStart.getTime(), start.getTime()));
}

function normalizeEvent(event) {
    if (!event) return null;
    const title = cleanText(event.title);
    if (!title) return null;
    return {
        ...event,
        title,
        calendar: cleanText(event.calendar),
        uid: cleanText(event.uid),
        start: event.start || '',
        end: event.end || '',
        location: event.location || '',
        url: event.url || '',
        notes: event.notes || '',
        google_calendar_link: event.google_calendar_link || '',
    };
}

function selectCalendarEvent(events, recordedFrom, recordedTo) {
    const normalized = (Array.isArray(events) ? events : [])
        .map(normalizeEvent)
        .filter((event) => event && !isAvailabilityBlock(event));
    if (!normalized.length) return null;

    const hasWindow = !!(toDate(recordedFrom) && toDate(recordedTo));
    const scored = normalized
        .map((event, index) => {
            const eventStart = toDate(event.start);
            const eventEnd = toDate(event.end);
            const overlap = overlapMs(event, recordedFrom, recordedTo);
            return {
                event,
                index,
                active: eventActive(event) ? 1 : 0,
                overlap,
                matchedWindow: event.matchedWindow || event.matched_window ? 1 : 0,
                hasTimes: eventStart && eventEnd ? 1 : 0,
                startMs: eventStart ? eventStart.getTime() : Number.MAX_SAFE_INTEGER,
            };
        })
        .filter((item) => !hasWindow || !item.hasTimes || item.overlap > 0 || item.active || item.matchedWindow);

    if (!scored.length) return null;
    scored.sort((a, b) => {
        if (a.overlap !== b.overlap) return b.overlap - a.overlap;
        if (a.active !== b.active) return b.active - a.active;
        if (a.matchedWindow !== b.matchedWindow) return b.matchedWindow - a.matchedWindow;
        if (a.hasTimes !== b.hasTimes) return b.hasTimes - a.hasTimes;
        if (a.startMs !== b.startMs) return a.startMs - b.startMs;
        return a.index - b.index;
    });
    return scored[0].event;
}

function buildCalendarKey(event, occurrenceAnchor = '') {
    const occurrence = occurrenceAnchor
        ? `matched-window:${toIso(occurrenceAnchor)}`
        : `${toIso(event.start)}|${toIso(event.end)}`;
    const seed = [
        'calendar',
        cleanText(event.uid),
        cleanText(event.calendar),
        cleanText(event.title),
        occurrence,
    ].join('|');
    return `calendar:${hashKey(seed)}`;
}

function buildSessionKey({ fallbackBaseName, fallbackTitle, recordedFrom, recordedTo }) {
    const seed = [
        'session',
        cleanText(fallbackBaseName),
        cleanText(fallbackTitle),
        toIso(recordedFrom),
        toIso(recordedTo),
    ].join('|');
    return `session:${hashKey(seed)}`;
}

function buildSummaryIdentity({ events, recordedFrom, recordedTo, fallbackTitle, fallbackBaseName } = {}) {
    const event = selectCalendarEvent(events, recordedFrom, recordedTo);
    if (event) {
        // Calendar.app may match a recurring occurrence but expose the series
        // master's original dates. Anchor that case to this recording so a
        // future occurrence does not overwrite an older meeting's Doc.
        const matchedWindow = !!(event.matchedWindow || event.matched_window);
        const occurrenceAnchor = matchedWindow && overlapMs(event, recordedFrom, recordedTo) === 0
            ? recordedFrom
            : '';
        return {
            kind: 'calendar',
            key: buildCalendarKey(event, occurrenceAnchor),
            title: event.title,
            event,
        };
    }

    const title = cleanText(fallbackTitle) || cleanText(fallbackBaseName) || 'Meeting Summary';
    return {
        kind: 'session',
        key: buildSessionKey({ fallbackBaseName, fallbackTitle: title, recordedFrom, recordedTo }),
        title,
        event: null,
    };
}

module.exports = {
    buildSummaryIdentity,
    selectCalendarEvent,
    isAvailabilityBlock,
    cleanText,
    toIso,
};
