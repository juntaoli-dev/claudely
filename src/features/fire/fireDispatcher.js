// src/features/fire/fireDispatcher.js
//
// Real FireDispatcher. Gates fires on auto-answer or wake phrase, captures the
// current screen + 30 s transcript tail, and streams a Claude answer back via
// onState delta events. Queues up to 3 backlogged fires; drops oldest over cap.

const { matchWake } = require('../classify/wakePhrase');

class FireDispatcher {
    constructor({ store, classifier, grabber, claude, config, onState, claudeContextProvider } = {}) {
        this.store = store;
        this.classifier = classifier;
        this.grabber = grabber;
        this.claude = claude;
        this.config = config;
        this.onState = onState || (() => {});
        // Per-Listen-session Claude resume bookkeeping. Provider returns
        // { get: () => ({ sessionId, lastTranscriptSentTs }), set: (ctx) => void }
        // and is null in non-Listen contexts (one-shot ask without a Listen
        // session in progress), in which case we fall back to the legacy 30s-
        // tail behaviour with no resumption.
        this.claudeContextProvider = claudeContextProvider || null;
        this._inFlight = false;
        this._queue = [];
    }

    queueSize() { return this._queue.length; }

    async maybeFire(line) {
        const wakePhrases = this.config?.get?.('wakePhrases') || [];
        const auto = !!this.config?.get?.('autoAnswer');

        let question = matchWake(line.text, wakePhrases);
        if (!question && auto) {
            try {
                const verdict = await this.classifier.classify(line.text);
                if (verdict?.addressed) question = verdict.question || line.text;
            } catch (_) {}
        }
        if (!question) return null;

        if (this._inFlight) {
            if (this._queue.length >= 3) {
                this._queue.shift();
                this.onState({ type: 'drop-queued' });
            }
            this._queue.push({ line, question });
            this.onState({ type: 'queued', size: this._queue.length });
            return 'queued';
        }

        this._fireWithDrain({ line, question });
        return 'fired';
    }

    async manualFire({ question, transcriptTail, imagePath }) {
        if (this._inFlight) {
            if (this._queue.length >= 3) {
                this._queue.shift();
                this.onState({ type: 'drop-queued' });
            }
            this._queue.push({ line: { ts: Date.now() }, question, transcriptTail, imagePath, manual: true });
            this.onState({ type: 'queued', size: this._queue.length });
            return 'queued';
        }
        this._fireWithDrain({ line: { ts: Date.now() }, question, transcriptTail, imagePath, manual: true });
        return 'fired';
    }

    // Fire then drain the queue. Not awaited by maybeFire so queueing tests can
    // observe backlog while the first fire is still pending.
    _fireWithDrain(item) {
        (async () => {
            await this._fire(item);
            while (this._queue.length) await this._fire(this._queue.shift());
        })();
    }

    async _fire({ line, question, transcriptTail, imagePath, manual }) {
        this._inFlight = true;
        this.onState({ type: 'thinking' });
        if (!imagePath) {
            try { imagePath = await this.grabber?.grab(); } catch (_) { imagePath = null; }
        }

        // Resolve Claude resume context (per-Listen-session). When present:
        // - First ask in the session: full transcript so far, no resume id.
        // - Later asks: only the delta lines newer than lastTranscriptSentTs,
        //   plus the resume id so Claude continues the same conversation.
        let resumeSessionId = null;
        let isFirstAsk = true;
        let claudeCtx = null;
        if (this.claudeContextProvider) {
            try { claudeCtx = this.claudeContextProvider.get(); } catch (_) { claudeCtx = null; }
        }
        if (claudeCtx?.claudeSessionId) {
            resumeSessionId = claudeCtx.claudeSessionId;
            isFirstAsk = false;
        }

        if (transcriptTail === undefined) {
            try {
                if (claudeCtx && this.store?.since) {
                    // Delta mode: send only lines newer than what Claude has
                    // already seen. On first ask lastTranscriptSentTs is null,
                    // so since(0) returns the whole in-memory window.
                    transcriptTail = this.store.since(claudeCtx.lastTranscriptSentTs || 0) || '';
                } else {
                    transcriptTail = this.store?.tail({ now: line.ts || Date.now(), seconds: 30 }) || '';
                }
            } catch (_) { transcriptTail = ''; }
        }

        // Prepend meeting context (calendar event title, attendees, agenda)
        // so Claude knows which meeting we're in without the user repeating it.
        // Skipped in tests (Vitest) and when CLAUDELY_SKIP_CALENDAR=1, since
        // spawning the EventKit helper would slow unit tests by ~200 ms each.
        if (!process.env.VITEST && process.env.CLAUDELY_SKIP_CALENDAR !== '1') {
            try {
                const { getMeetingContext, formatForPrompt } = require('../calendar/calendarContext');
                const events = await getMeetingContext();
                const ctx = formatForPrompt(events);
                if (ctx) transcriptTail = `${ctx}\n\n${transcriptTail || ''}`.trim();
            } catch (_) { /* calendar is optional context */ }
        }
        // Persist the question + assistant reply to ai_messages so the
        // listenService close-time sidecar can bundle every Q&A that happened
        // during a recording, not just the ones routed through askService.
        // sendMessage. Manual asks are persisted by askService itself so we
        // skip them here to avoid duplicate rows. Wrapped in try/catch so a DB
        // failure never breaks fire.
        let askSessionId = null;
        try {
            if (!process.env.VITEST && !manual) {
                const sessionRepository = require('../common/repositories/session');
                askSessionId = await sessionRepository.getOrCreateActive('ask');
                const askRepository = require('../ask/repositories');
                await askRepository.addAiMessage({ sessionId: askSessionId, role: 'user', content: question });
            }
        } catch (_) { /* persistence best-effort */ }

        let assistantText = '';
        try {
            const result = await this.claude.ask({
                question,
                transcriptTail,
                imagePath,
                resumeSessionId,
                isFirstAsk,
                onDelta: (text) => {
                    assistantText += text;
                    this.onState({ type: 'delta', text });
                },
                onEvent: (e) => {
                    // Forward structured progress events so the renderer can
                    // show tool-call activity separately from answer text.
                    if (e.kind === 'tool_use') this.onState({ type: 'tool', name: e.name, summary: e.summary });
                    else if (e.kind === 'tool_result') this.onState({ type: 'tool-done', isError: e.isError, summary: e.summary });
                    else if (e.kind === 'thinking') this.onState({ type: 'thinking-text', text: e.text });
                },
            });

            // Persist updated Claude resume context so the next ask in this
            // Listen session sends only the delta and resumes the same
            // conversation. Only do this when we have a context provider —
            // i.e. a Listen session is active and the dispatcher knows where
            // to stash the ids.
            if (this.claudeContextProvider && result?.sessionId) {
                try {
                    this.claudeContextProvider.set({
                        claudeSessionId: result.sessionId,
                        lastTranscriptSentTs: Date.now(),
                    });
                } catch (e) {
                    console.warn('[FireDispatcher] could not persist Claude resume context:', e.message);
                }
            }

            try {
                if (askSessionId && assistantText) {
                    const askRepository = require('../ask/repositories');
                    await askRepository.addAiMessage({ sessionId: askSessionId, role: 'assistant', content: assistantText });
                }
            } catch (_) { /* persistence best-effort */ }
            this.onState({ type: 'done' });
        } catch (e) {
            this.onState({ type: 'error', error: 'claude: ' + e.message });
        }
        this._inFlight = false;
    }
}

module.exports = { FireDispatcher };
