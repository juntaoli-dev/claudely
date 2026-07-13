#!/usr/bin/env node
// scripts/bulk-summarize.js
//
// One-shot helper: walks the configured transcript upload dir, generates a
// .summary.md (via Summarizer + Claude CLI) for every .jsonl that doesn't
// already have one, then uploads each .md as a Google Doc via the configured
// Apps Script webhook. Skips empty/tiny transcripts (<500B) so we don't burn
// tokens on noise.
//
// Run from the repo root:
//   node scripts/bulk-summarize.js
//
// Re-uploads existing .summary.md files too so the new HTML styling lands on
// previously-generated docs. Pass --no-reupload to skip that.

const fs = require('fs');
const path = require('path');
const cfg = require('../src/features/common/config/config');
const { Summarizer } = require('../src/features/summary/summarizer');
const { uploadSummary } = require('../src/features/summary/driveUploader');
const { buildSummaryIdentity } = require('../src/features/summary/summaryIdentity');
const { getDefaultRegistry } = require('../src/features/summary/summaryDocRegistry');

const MIN_BYTES = 500;
const REUPLOAD = !process.argv.includes('--no-reupload');

async function run() {
    const dst = cfg.get('transcriptUploadDir');
    if (!dst) { console.error('transcriptUploadDir not set'); process.exit(1); }
    if (!fs.existsSync(dst)) { console.error('upload dir missing:', dst); process.exit(1); }

    const files = fs.readdirSync(dst).filter(f => f.endsWith('.jsonl')).sort();
    console.log(`[bulk] ${files.length} .jsonl in ${dst}`);

    const summarizer = new Summarizer();

    for (const fname of files) {
        const transcriptPath = path.join(dst, fname);
        const stat = fs.statSync(transcriptPath);
        if (stat.size < MIN_BYTES) { console.log(`[bulk] skip ${fname} (${stat.size}B < ${MIN_BYTES}B)`); continue; }
        const baseName = fname.replace(/\.jsonl$/, '');
        const metaPath = path.join(dst, `${baseName}.meta.json`);
        const summaryPath = path.join(dst, `${baseName}.summary.md`);
        let meta = null;

        if (!fs.existsSync(metaPath)) {
            const stub = {
                schema: 2,
                transcript_file: fname,
                recorded_from: stubTimestampFromName(fname),
                recorded_to: new Date(stat.mtimeMs).toISOString(),
                duration_ms: null,
                session_id: null,
                events: [],
                qa: [],
                screenshots: [],
            };
            fs.writeFileSync(metaPath, JSON.stringify(stub, null, 2));
            console.log(`[bulk] stub meta → ${path.basename(metaPath)}`);
            meta = stub;
        } else {
            try {
                meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
            } catch (e) {
                console.warn(`[bulk] could not read meta for ${fname}: ${e.message}`);
                meta = null;
            }
        }

        if (!fs.existsSync(summaryPath)) {
            const t0 = Date.now();
            console.log(`[bulk] summarize ${fname} (${(stat.size / 1024).toFixed(1)}K)…`);
            try {
                const r = await summarizer.summarize({ transcriptPath, metaPath, outPath: summaryPath });
                console.log(`[bulk] → ${path.basename(summaryPath)} ${r.bytes}B in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
            } catch (e) {
                console.error(`[bulk] summarize ${fname} FAIL:`, e.message);
                continue;
            }
        } else {
            console.log(`[bulk] keep ${path.basename(summaryPath)} (already exists)`);
            if (!REUPLOAD) continue;
        }

        try {
            const identity = buildSummaryIdentity({
                events: meta?.events || [],
                recordedFrom: meta?.recorded_from || null,
                recordedTo: meta?.recorded_to || null,
                fallbackTitle: baseName,
                fallbackBaseName: baseName,
            });
            const registry = getDefaultRegistry();
            const docId = identity.kind === 'calendar' ? registry.getDocId(identity.key) : null;
            const r = await uploadSummary({
                markdownPath: summaryPath,
                fallbackTitle: baseName,
                webhookUrl: cfg.get('summaryWebhookUrl'),
                secret: cfg.get('summarySecret'),
                docId,
                titleOverride: identity.kind === 'calendar' ? identity.title : null,
                dedupeKey: identity.kind === 'calendar' ? identity.key : null,
            });
            if (r.skipped) console.log(`[bulk] upload skipped: ${r.reason}`);
            else {
                if (identity.kind === 'calendar') {
                    registry.remember(identity, r.id, {
                        url: r.url || '',
                        monthBucket: r.monthBucket || '',
                    });
                }
                console.log(`[bulk] uploaded → ${r.url}`);
            }
        } catch (e) {
            console.error(`[bulk] upload ${fname} FAIL:`, e.message);
        }
    }
}

function stubTimestampFromName(fname) {
    const m = fname.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/);
    if (!m) return null;
    return `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`;
}

run().catch((e) => { console.error('FATAL', e); process.exit(1); });
