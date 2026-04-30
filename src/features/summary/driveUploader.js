// src/features/summary/driveUploader.js
//
// POSTs a generated summary to a user-deployed Google Apps Script Web App,
// which converts the HTML to a real Google Doc and drops it into the
// "Meeting Summary" folder under the user's "Claudely Transcripts" Drive
// folder. The .md file we already write to the synced Drive folder stays as
// a local audit-trail copy; the Google Doc is the polished deliverable.
//
// Setup is documented in scripts/apps-script/SummaryUploader.gs. After the
// user deploys it once, two config keys make it auto-fire forever:
//   summaryWebhookUrl: "https://script.google.com/macros/s/AKfy.../exec"
//   summarySecret:     "<same long random string baked into the script>"
//
// If either key is missing we silently skip (no-op), so users who don't want
// Google Doc upload pay zero overhead.

const fs = require('fs');
const path = require('path');
const { marked } = require('marked');

function deriveTitle(markdown, fallback) {
    const m = (markdown || '').match(/^\s*#\s+(.+?)\s*$/m);
    return m ? m[1].trim() : fallback;
}

// Wrap the rendered <body> fragment in a tiny HTML shell. Drive's converter
// preserves headings, lists, blockquotes, and tables faithfully, but it
// expects a full document; passing only fragments occasionally drops the
// first heading.
function renderHtml(markdown, title) {
    const body = marked.parse(markdown, { gfm: true, breaks: false });
    return [
        '<!doctype html>',
        '<html><head><meta charset="utf-8"><title>',
        escapeHtml(title),
        '</title></head><body>',
        body,
        '</body></html>',
    ].join('');
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
    }[c]));
}

async function uploadSummary({ markdownPath, fallbackTitle, webhookUrl, secret, fetchImpl }) {
    if (!webhookUrl || !secret) {
        return { skipped: true, reason: 'missing summaryWebhookUrl or summarySecret in config' };
    }
    if (!fs.existsSync(markdownPath)) {
        return { skipped: true, reason: 'markdown file not found' };
    }
    const markdown = fs.readFileSync(markdownPath, 'utf8');
    const title = deriveTitle(markdown, fallbackTitle || path.basename(markdownPath, '.md'));
    const html = renderHtml(markdown, title);

    const fetchFn = fetchImpl || globalThis.fetch;
    if (!fetchFn) throw new Error('fetch not available; need Node 18+');
    const res = await fetchFn(webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ secret, title, html }),
        redirect: 'follow',
    });

    const text = await res.text();
    let payload;
    try { payload = JSON.parse(text); }
    catch (_) { payload = { ok: false, error: `non-JSON response: ${text.slice(0, 300)}` }; }
    if (!res.ok || !payload.ok) {
        const err = payload.error || `HTTP ${res.status}`;
        const e = new Error(`Drive upload failed: ${err}`);
        e.status = res.status;
        e.payload = payload;
        throw e;
    }
    return { skipped: false, id: payload.id, url: payload.url, title };
}

module.exports = { uploadSummary, renderHtml, deriveTitle };
