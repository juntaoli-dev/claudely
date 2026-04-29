// src/features/calendar/calendarContext.js
//
// Thin wrapper over the calendar-now Swift helper. EventKit is queried via
// the helper because Node has no first-class binding. Result cached for 60 s
// so back-to-back fires don't spawn the binary repeatedly.

const { spawn } = require('child_process');
const path = require('path');

const TTL_MS = 60 * 1000;
let cache = { ts: 0, payload: null };

function binaryPath() {
    return path.join(__dirname, '../../ui/assets/bin/calendar-now')
        .replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
}

function fetchEvents() {
    return new Promise((resolve) => {
        try {
            const p = spawn(binaryPath(), [], { stdio: ['ignore', 'pipe', 'pipe'] });
            let out = '';
            p.stdout.on('data', (d) => { out += d.toString(); });
            p.stderr.on('data', () => {}); // swallow; helper logs ERR: calendar-access-denied etc.
            p.on('exit', () => {
                try { resolve(JSON.parse((out || '[]').trim()) || []); }
                catch { resolve([]); }
            });
            p.on('error', () => resolve([]));
            // 5 s safety net so a hung helper can't stall a fire.
            setTimeout(() => { try { p.kill(); } catch (_) {} resolve([]); }, 5000);
        } catch (_) {
            resolve([]);
        }
    });
}

async function getMeetingContext({ force = false } = {}) {
    const now = Date.now();
    if (!force && cache.payload && (now - cache.ts) < TTL_MS) return cache.payload;
    const events = await fetchEvents();
    cache = { ts: now, payload: events };
    return events;
}

function formatForPrompt(events) {
    if (!events || events.length === 0) return '';
    const e = events[0];
    const lines = [];
    lines.push(`Calendar context — ${e.isActive ? 'CURRENT MEETING' : 'NEXT MEETING'}: ${e.title || '(untitled)'}`);
    if (e.start && e.end) lines.push(`  When: ${e.start} → ${e.end}`);
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

module.exports = { getMeetingContext, formatForPrompt };
