// src/features/calendar/calendarContext.js
//
// Query Calendar.app via osascript. Apple's EventKit helper-binary path
// silently denies TCC for non-app-bundled tools, so AppleScript is the
// reliable channel. The query against Claudely.app (LSUIElement) can be slow
// the first time Calendar.app cold-starts, so:
//   • fetchEvents runs with a 180 s timeout
//   • startWarming kicks a background fetch on app launch / listen start so
//     the FireDispatcher pulls from cache without ever blocking
//   • Subsequent fires re-warm in the background after the 60 s TTL expires.

const { spawn } = require('child_process');

const TTL_MS = 60 * 1000;
let cache = { ts: 0, payload: null };
let inflight = null;

function calendarNames() {
    return (process.env.CLAUDELY_CAL_NAMES || 'juntao.li@pmg.com')
        .split(',').map((s) => s.trim()).filter(Boolean);
}

function asAppleScriptDate(jsDate) {
    // AppleScript wants a `date "..."` literal that its locale parser accepts.
    // Use ISO-ish format that AppleScript can coerce via `date "<text>"`.
    const pad = (n) => String(n).padStart(2, '0');
    const m = ['January','February','March','April','May','June','July','August','September','October','November','December'][jsDate.getMonth()];
    const d = jsDate.getDate();
    const y = jsDate.getFullYear();
    const hh = jsDate.getHours();
    const mm = pad(jsDate.getMinutes());
    const ss = pad(jsDate.getSeconds());
    const ampm = hh >= 12 ? 'PM' : 'AM';
    const h12 = ((hh + 11) % 12) + 1;
    return `${m} ${d}, ${y} ${h12}:${mm}:${ss} ${ampm}`;
}

// Build an AppleScript that returns events in the given time window. Used
// both for "what's on now" (default 8 h forward) and for sidecar metadata
// at session close (the actual recording window).
function buildAppleScript({ start, end } = {}) {
    const namesLiteral = calendarNames().map((n) => `"${n.replace(/"/g, '\\"')}"`).join(', ');
    let startExpr = 'now';
    let endExpr = 'now + (8 * hours)';
    if (start instanceof Date) startExpr = `(date "${asAppleScriptDate(start)}")`;
    if (end instanceof Date) endExpr = `(date "${asAppleScriptDate(end)}")`;
    return `
with timeout of 180 seconds
tell application "Calendar"
    set now to current date
    set windowStart to ${startExpr}
    set windowEnd to ${endExpr}
    set wanted to {${namesLiteral}}
    set out to ""
    repeat with cal in (every calendar)
        set calTitle to title of cal
        if wanted contains calTitle then
            try
                set evs to (every event of cal whose start date ≤ windowEnd and end date ≥ windowStart)
                repeat with e in evs
                    set t to summary of e
                    set s to start date of e
                    set en to end date of e
                    set isActive to (s ≤ now and en ≥ now)
                    set loc to ""
                    try
                        set loc to location of e
                    end try
                    set notesText to ""
                    try
                        set notesText to description of e
                    end try
                    set urlText to ""
                    try
                        set urlText to url of e
                    end try
                    set uidText to ""
                    try
                        set uidText to uid of e
                    end try
                    -- Strip pipes and newlines from free-text fields so our delimiter survives.
                    set safeNotes to my __scrub(notesText)
                    set safeLoc to my __scrub(loc)
                    set out to out & "TITLE:" & t & "||START:" & ((s as «class isot» as string)) & "||END:" & ((en as «class isot» as string)) & "||ACTIVE:" & (isActive as text) & "||LOC:" & safeLoc & "||URL:" & urlText & "||UID:" & uidText & "||NOTES:" & safeNotes & "||CAL:" & calTitle & ((ASCII character 10) as text)
                end repeat
            end try
        end if
    end repeat
    return out
end tell
end timeout

on __scrub(s)
    set s to s as text
    set AppleScript's text item delimiters to {"||"}
    set parts to text items of s
    set AppleScript's text item delimiters to {" "}
    set s to parts as text
    set AppleScript's text item delimiters to {(ASCII character 10), (ASCII character 13)}
    set parts to text items of s
    set AppleScript's text item delimiters to {" "}
    set s to parts as text
    set AppleScript's text item delimiters to {""}
    return s
end __scrub
`;
}

function parseOutput(out) {
    if (!out) return [];
    const events = [];
    for (const raw of out.split('\n')) {
        const line = raw.trim();
        if (!line.startsWith('TITLE:')) continue;
        const fields = {};
        for (const part of line.split('||')) {
            const idx = part.indexOf(':');
            if (idx > 0) fields[part.slice(0, idx).toLowerCase()] = part.slice(idx + 1);
        }
        if (!fields.title) continue;
        events.push({
            title: fields.title,
            start: fields.start || '',
            end: fields.end || '',
            isActive: (fields.active || '').toLowerCase() === 'true',
            location: fields.loc || '',
            url: fields.url || '',
            uid: fields.uid || '',
            notes: fields.notes || '',
            calendar: fields.cal || '',
        });
    }
    events.sort((a, b) => {
        if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
        return (a.start || '').localeCompare(b.start || '');
    });
    return events;
}

function fetchEvents(window) {
    // Bypass the in-flight singleton when an explicit window is requested
    // (e.g. for sidecar metadata at session close).
    if (!window && inflight) return inflight;
    const promise = new Promise((resolve) => {
        try {
            const p = spawn('/usr/bin/osascript', ['-e', buildAppleScript(window || {})], { stdio: ['ignore', 'pipe', 'pipe'] });
            let out = '';
            let err = '';
            p.stdout.on('data', (d) => { out += d.toString(); });
            p.stderr.on('data', (d) => { err += d.toString(); });
            let resolved = false;
            let timer = null;
            const finish = (events) => {
                if (resolved) return;
                resolved = true;
                if (timer) { clearTimeout(timer); timer = null; }
                inflight = null;
                resolve(events);
            };
            p.on('exit', (code) => {
                if (err && err.trim()) console.warn('[calendar] osascript stderr:', err.trim().slice(0, 200));
                const events = parseOutput(out);
                console.log(`[calendar] fetched ${events.length} event(s) (exit=${code})`);
                finish(events);
            });
            p.on('error', () => finish([]));
            timer = setTimeout(() => {
                console.warn('[calendar] osascript timeout 180s — killing');
                try { p.kill(); } catch (_) {}
                finish([]);
            }, 180000);
        } catch (_) {
            resolve([]);
        }
    });
    if (!window) inflight = promise.finally(() => { inflight = null; });
    return promise;
}

// Fetch events that overlapped a specific time window. Used by listenService
// at close time to write a sidecar JSON with the meeting that was being
// transcribed.
async function fetchEventsForWindow(startDate, endDate) {
    return fetchEvents({ start: startDate, end: endDate });
}

// Background-warm so a fire never has to await the slow osascript.
function startWarming() {
    const now = Date.now();
    if (cache.payload && (now - cache.ts) < TTL_MS) return; // still fresh
    fetchEvents().then((events) => { cache = { ts: Date.now(), payload: events }; });
}

// Returns cached events synchronously-as-promise. Never blocks longer than
// the cache check. Kicks a background re-fetch when stale.
async function getMeetingContext({ force = false, await: shouldAwait = false } = {}) {
    const now = Date.now();
    const fresh = cache.payload && (now - cache.ts) < TTL_MS;
    if (fresh && !force) return cache.payload;

    const fetchPromise = fetchEvents().then((events) => { cache = { ts: Date.now(), payload: events }; return events; });

    if (shouldAwait || force) return fetchPromise;
    // Fire-and-forget: return whatever we have now (may be empty on cold).
    return cache.payload || [];
}

function formatForPrompt(events) {
    if (!events || events.length === 0) return '';
    const e = events[0];
    const lines = [];
    lines.push(`Calendar context — ${e.isActive ? 'CURRENT MEETING' : 'NEXT MEETING'}: ${e.title || '(untitled)'}`);
    if (e.start && e.end) lines.push(`  When: ${e.start} → ${e.end}`);
    if (e.calendar) lines.push(`  Calendar: ${e.calendar}`);
    if (e.location) lines.push(`  Location: ${e.location}`);
    if (e.url) lines.push(`  URL: ${e.url}`);
    if (Array.isArray(e.attendees) && e.attendees.length) {
        lines.push(`  Attendees: ${e.attendees.slice(0, 12).join(', ')}${e.attendees.length > 12 ? ', …' : ''}`);
    }
    if (e.notes) {
        const trimmed = String(e.notes).replace(/\s+/g, ' ').slice(0, 500);
        lines.push(`  Notes: ${trimmed}`);
    }
    return lines.join('\n');
}

module.exports = { getMeetingContext, formatForPrompt, startWarming, fetchEventsForWindow };
