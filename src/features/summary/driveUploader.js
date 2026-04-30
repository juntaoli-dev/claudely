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
const { marked, Renderer } = require('marked');

function deriveTitle(markdown, fallback) {
    const m = (markdown || '').match(/^\s*#\s+(.+?)\s*$/m);
    return m ? m[1].trim() : fallback;
}

// Color palette matching the user's reference visa-guide doc:
//   H1 banner      — deep orange    (#9a3412 / amber-800)
//   H2 sections    — orange         (#b45309 / amber-700) with amber underline
//   H3 subsections — deep blue      (#1e40af / blue-800)
//   Tables         — amber-50 header bg + warm gray borders
//   Blockquotes    — amber pull-quote with light fill
//   Body           — Arial 11pt, gray-900 text
// Drive's HTML→Google Doc conversion respects color/font/border/background
// inline styles on h1/h2/h3, th/td, blockquote, and ul/ol, so we apply those
// directly via a marked Renderer override.
const STYLED_RENDERER = new Renderer();

const HEADING_STYLES = {
    1: 'font-family:Arial,sans-serif;font-size:24pt;font-weight:700;color:#9a3412;margin:6px 0 8px 0;letter-spacing:0.2px;',
    2: 'font-family:Arial,sans-serif;font-size:16pt;font-weight:700;color:#b45309;border-bottom:2px solid #f59e0b;padding-bottom:4px;margin:22px 0 10px 0;text-transform:none;',
    3: 'font-family:Arial,sans-serif;font-size:13pt;font-weight:700;color:#1e40af;margin:14px 0 4px 0;',
    4: 'font-family:Arial,sans-serif;font-size:11pt;font-weight:700;color:#374151;margin:10px 0 4px 0;',
    5: 'font-family:Arial,sans-serif;font-size:10pt;font-weight:700;color:#6b7280;margin:8px 0 4px 0;',
    6: 'font-family:Arial,sans-serif;font-size:10pt;font-weight:700;color:#6b7280;margin:8px 0 4px 0;',
};

STYLED_RENDERER.heading = function (text, level, raw, slugger) {
    const style = HEADING_STYLES[level] || HEADING_STYLES[3];
    return `<h${level} style="${style}">${text}</h${level}>\n`;
};

STYLED_RENDERER.blockquote = function (quote) {
    return `<blockquote style="border-left:4px solid #f59e0b;background-color:#fffbeb;padding:10px 14px;color:#374151;margin:12px 0;font-family:Arial,sans-serif;font-size:11pt;">${quote}</blockquote>\n`;
};

STYLED_RENDERER.tablecell = function (content, flags) {
    const align = flags.align ? `text-align:${flags.align};` : '';
    if (flags.header) {
        return `<th style="border:1px solid #d6d3d1;background-color:#fef3c7;color:#9a3412;font-weight:700;padding:6px 10px;text-align:${flags.align || 'left'};font-family:Arial,sans-serif;font-size:10pt;">${content}</th>\n`;
    }
    return `<td style="border:1px solid #d6d3d1;padding:6px 10px;vertical-align:top;${align}font-family:Arial,sans-serif;font-size:10pt;">${content}</td>\n`;
};

STYLED_RENDERER.table = function (header, body) {
    const bodyOut = body ? `<tbody>${body}</tbody>` : '';
    return `<table style="border-collapse:collapse;margin:10px 0;font-family:Arial,sans-serif;">\n<thead>${header}</thead>\n${bodyOut}</table>\n`;
};

STYLED_RENDERER.paragraph = function (text) {
    return `<p style="font-family:Arial,sans-serif;font-size:11pt;color:#111827;line-height:1.45;margin:6px 0;">${text}</p>\n`;
};

STYLED_RENDERER.list = function (body, ordered, start) {
    const tag = ordered ? 'ol' : 'ul';
    const startAttr = ordered && start !== 1 ? ` start="${start}"` : '';
    return `<${tag}${startAttr} style="font-family:Arial,sans-serif;font-size:11pt;color:#111827;margin:6px 0 6px 24px;line-height:1.45;">${body}</${tag}>\n`;
};

STYLED_RENDERER.listitem = function (text) {
    return `<li style="margin:3px 0;">${text}</li>\n`;
};

STYLED_RENDERER.strong = function (text) {
    return `<strong style="color:#111827;">${text}</strong>`;
};

STYLED_RENDERER.codespan = function (code) {
    return `<code style="font-family:'Roboto Mono',Menlo,monospace;background-color:#f3f4f6;color:#1f2937;padding:1px 4px;border-radius:3px;font-size:10pt;">${code}</code>`;
};

STYLED_RENDERER.hr = function () {
    return `<hr style="border:0;border-top:1px solid #e5e7eb;margin:18px 0;">\n`;
};

// Render the body with the styled renderer, then wrap in a minimal HTML
// document so Drive's converter has a full document to work with.
function renderHtml(markdown, title) {
    const body = marked.parse(markdown, { gfm: true, breaks: false, renderer: STYLED_RENDERER });
    return [
        '<!doctype html>',
        '<html><head><meta charset="utf-8"><title>',
        escapeHtml(title),
        '</title></head>',
        '<body style="font-family:Arial,sans-serif;font-size:11pt;color:#111827;line-height:1.45;">',
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

// Pull a YYYY-MM bucket from either the meta sidecar's recorded_from, the
// summary md filename pattern, or fall back to current month. Used to put
// the resulting Doc in <Meeting Summary>/<YYYY-MM>/ on Drive so the folder
// stays browsable as transcripts pile up.
function deriveMonthBucket(markdownPath) {
    try {
        const dir = path.dirname(markdownPath);
        const base = path.basename(markdownPath).replace(/\.summary\.md$/, '').replace(/\.md$/, '');
        const metaPath = path.join(dir, `${base}.meta.json`);
        if (fs.existsSync(metaPath)) {
            const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
            const ts = meta.recorded_from || meta.recorded_to;
            const m = ts && String(ts).match(/^(\d{4})-(\d{2})/);
            if (m) return `${m[1]}-${m[2]}`;
        }
        const m = base.match(/^(\d{4})-(\d{2})/);
        if (m) return `${m[1]}-${m[2]}`;
    } catch (_) { /* fall through */ }
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
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
    const monthBucket = deriveMonthBucket(markdownPath);

    const fetchFn = fetchImpl || globalThis.fetch;
    if (!fetchFn) throw new Error('fetch not available; need Node 18+');
    const res = await fetchFn(webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ secret, title, html, monthBucket }),
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
    return { skipped: false, id: payload.id, url: payload.url, title, monthBucket };
}

module.exports = { uploadSummary, renderHtml, deriveTitle, deriveMonthBucket };
