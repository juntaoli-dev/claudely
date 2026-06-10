// src/features/summary/summarizer.js
//
// Generate a per-session meeting summary by handing the recorded transcript +
// Q&A + calendar context + screenshots to a locked-style assistant prompt. Output
// is written to <base>.summary.md next to the transcript in the upload dir, so
// the synced Drive folder ends up with a polished doc instead of relying on
// Convey or another external summarizer.
//
// Style is locked via SUMMARY_STYLE_PROMPT below. Adjust the template there if
// you want every future summary to shift; do NOT pass per-session style
// overrides through the API or the output drifts.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { AssistantSession } = require('../ai/assistantSession');

// The style guide. Lifted from the user's reference doc structure:
//   • Banner header with TL;DR
//   • Numbered SECTION headings
//   • Lettered subsections inside each section
//   • Two-column tables for timelines, decisions, risks, budgets
//   • PRO TIP / WATCH OUT callouts
//   • "QUICK ACTION ITEMS" closer
// Modernized with an at-a-glance metadata strip, sentiment badges, and inline
// transcript citations (timestamp + speaker) so the summary stays auditable.
const SUMMARY_STYLE_PROMPT = `You are Claudely's summarizer. Produce a polished, self-contained Markdown
brief of one recorded meeting, written like a senior chief-of-staff would
hand it to an executive who missed the call. The reader has zero context.

The output is the FINAL DELIVERABLE. Do not narrate what you're doing, do not
ask questions, do not include a preamble. Start with the H1 banner and end
after QUICK ACTION ITEMS. Markdown only.

## STYLE — LOCKED

Use this exact skeleton, in this order, every time. Section numbers are
fixed. Section names may be reworded only if the meeting truly has nothing
for that section, in which case write "_None this session._" inside it.

\`\`\`
# <punchy meeting title in title case>

> **TL;DR.** <one or two sentences. punchy. concrete. no hedging.>

| Date | Duration | Attendees | Calendar Event |
|------|----------|-----------|----------------|
| <ISO date> | <Hh Mm> | <names if known, else speaker labels> | <event title or "—"> |

---

## SECTION 0: AT A GLANCE

- **Outcome:** <decided / aligned / blocked / discovery / status>
- **Energy:** <one short phrase, e.g. "focused", "tense", "scattered">
- **Coverage:** <comma-separated topics, ≤5>
- **Open threads:** <count>
- **Action items:** <count>

## SECTION 1: THE BIG PICTURE

<2–4 short paragraphs. What was this meeting actually about, what changed
because of it, and what's the next material decision point. Plain English.
No filler.>

### Why This Mattered

- <bullet — concrete consequence>
- <bullet>
- <bullet>

## SECTION 2: TIMELINE (How It Unfolded)

| WHEN | TOPIC | KEY MOMENT |
|------|-------|------------|
| <mm:ss> | <topic> | <what happened, including a short quoted phrase if it lands> |
| ... |

## SECTION 3: KEY DECISIONS

For each decision, lettered A, B, C... If none, write "_No firm decisions
landed this session._".

### A. <decision title>

- **Decision:** <what was decided>
- **Owner:** <who's accountable>
- **Rationale:** <why — pull from the actual discussion>
- **Trade-off accepted:** <what you gave up>
- **Reversible?** <yes / no / costly>

## SECTION 4: ACTION ITEMS

| # | OWNER | TASK | DUE | SOURCE |
|---|-------|------|-----|--------|
| 1 | <name> | <imperative task> | <date or "TBD"> | <mm:ss> |

## SECTION 5: KEY QUOTES

Pull 3–6 verbatim moments that capture the meeting's real signal — not just
the loudest line. Each quote ≤25 words.

> "<quote>" — <Speaker>, <mm:ss>

## SECTION 6: OPEN QUESTIONS / PARKED

- **<question>** — <why it's parked, who needs to weigh in>

## SECTION 7: SCREENSHOTS REFERENCED

If screenshots were captured during the session, reference each by filename
relative to the upload dir, with one line of context for what was on screen
at that moment. If none, write "_No screenshots this session._".

- \`<base>.screenshots/screen-<ts>.png\` — <one-line context>

## SECTION 8: WATCH OUTS / RISKS

| RISK | WHY IT MATTERS | MITIGATION |
|------|----------------|------------|

## SECTION 9: LINKS & RESOURCES

Pull every URL, doc, ticket, repo, person, or tool name mentioned. One per
bullet. Include calendar event deep link if provided.

- <thing> — <url or pointer>

## FINAL NOTES

<2–3 sentences. The thing the reader should remember a week from now.>

## QUICK ACTION ITEMS — DO THESE THIS WEEK

1. <imperative, owner-tagged>
2. <...>
3. <...>
\`\`\`

## RULES — LOCKED

1. Every claim must be supported by something in the transcript or Q&A. If
   the transcript doesn't say it, don't invent it. Mark genuine uncertainty
   with "_unclear from recording_" rather than guessing.
2. Speaker labels in the transcript are usually 0/1 channel tags (mic vs
   system). Map them to roles when context makes it obvious ("user" /
   "remote") rather than "Speaker 0".
3. Quotes must be verbatim. Trim with "..." if shortening.
4. Timestamps in the timeline + actions should be mm:ss relative to session
   start when derivable. If only absolute timestamps exist, convert.
5. Tables stay narrow. If a cell needs more than ~12 words, move it to a
   bullet under the relevant section instead.
6. No emoji except in SECTION 0 if energy/outcome warrants one. No filler.
7. Write in the voice of a senior operator. Active, terse, specific.

## INPUT

Below this line you'll receive: meeting metadata, calendar context, the
transcript .jsonl, every Q&A pair from the session, and screenshot paths.
Read them, then produce the brief in the locked style above. Output the
Markdown only.
`;

function fmt(d) {
    if (!d) return '—';
    const dt = typeof d === 'string' ? new Date(d) : d;
    if (Number.isNaN(dt.getTime())) return String(d);
    return dt.toISOString();
}

function buildInputBlock({ meta, transcriptText, qa, screenshotPaths }) {
    const events = (meta?.events || []).map((e) => {
        const lines = [`- ${e.title || '(untitled)'} (${e.calendar || 'unknown cal'})`];
        if (e.start && e.end) lines.push(`    when: ${e.start} → ${e.end}`);
        if (e.is_active_at_close) lines.push('    active when meeting ended: yes');
        if (e.location) lines.push(`    where: ${e.location}`);
        if (e.url) lines.push(`    url: ${e.url}`);
        if (e.google_calendar_link) lines.push(`    cal link: ${e.google_calendar_link}`);
        if (e.notes) lines.push(`    notes: ${String(e.notes).slice(0, 600)}`);
        return lines.join('\n');
    }).join('\n');

    const qaBlock = (qa || []).map((m, i) => {
        const role = m.role || 'unknown';
        const ts = m.ts || '';
        const content = (m.content || '').toString();
        return `[${i + 1}] (${ts}) ${role}: ${content}`;
    }).join('\n\n');

    const shotsBlock = (screenshotPaths || []).map((p) => `- ${p}`).join('\n');

    return [
        '=== META ===',
        `recorded_from: ${fmt(meta?.recorded_from)}`,
        `recorded_to:   ${fmt(meta?.recorded_to)}`,
        `duration_ms:   ${meta?.duration_ms ?? '—'}`,
        `session_id:    ${meta?.session_id ?? '—'}`,
        '',
        '=== CALENDAR EVENTS OVERLAPPING RECORDING ===',
        events || '(none)',
        '',
        '=== TRANSCRIPT (.jsonl, one final per line: {speaker,text,...}) ===',
        transcriptText || '(empty)',
        '',
        '=== Q&A DURING SESSION (oldest first) ===',
        qaBlock || '(none)',
        '',
        '=== SCREENSHOT FILES (relative paths) ===',
        shotsBlock || '(none)',
    ].join('\n');
}

class Summarizer {
    constructor({ session, model } = {}) {
        // Keep summarizer cwd OUT of the user's source repo so the assistant doesn't
        // accidentally Read codebase files while summarizing. tmpdir is fine —
        // we feed everything inline anyway.
        this.session = session || new AssistantSession({
            cwd: os.tmpdir(),
            codexModel: process.env.CLAUDELY_SUMMARY_CODEX_MODEL || null,
            claudeModel: model || process.env.CLAUDELY_SUMMARY_CLAUDE_MODEL || process.env.CLAUDELY_SUMMARY_MODEL || null,
        });
    }

    async summarize({ transcriptPath, metaPath, outPath, onProgress }) {
        const transcriptText = fs.existsSync(transcriptPath) ? fs.readFileSync(transcriptPath, 'utf8') : '';
        const meta = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, 'utf8')) : {};
        const qa = Array.isArray(meta.qa) ? meta.qa : [];
        const screenshotPaths = (meta.screenshots || []).map((s) => s.file || s);

        const inputBlock = buildInputBlock({ meta, transcriptText, qa, screenshotPaths });
        const question = `${SUMMARY_STYLE_PROMPT}\n\n${inputBlock}`;

        let full = '';
        await this.session.ask({
            question,
            onDelta: (text) => {
                full += text;
                onProgress?.(text);
            },
        });

        // Strip a leading code-fence wrapper if Claude returned the doc wrapped
        // (it sometimes does despite the "Markdown only" instruction).
        const stripped = full.replace(/^\s*```(?:markdown|md)?\s*\n/, '').replace(/\n```\s*$/, '');
        fs.writeFileSync(outPath, stripped);
        return { outPath, bytes: stripped.length };
    }
}

module.exports = { Summarizer, SUMMARY_STYLE_PROMPT };
