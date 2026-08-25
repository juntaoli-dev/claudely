import { describe, it, expect, vi } from 'vitest';
import { TranscriptStore } from '../transcriptStore.js';
import { FireDispatcher } from '../../fire/fireDispatcher.js';

describe('Claude resume context flow', () => {
    it('first ask sends full transcript without resume id; second ask sends only the delta with resume id', async () => {
        const store = new TranscriptStore({ maxMinutes: 60 });
        // Old lines must have ts < Date.now() at first-ask completion so the
        // second-ask delta correctly excludes them.
        const baseTs = Date.now() - 10_000;
        store.append({ ts: baseTs + 0, speaker: 'them', text: 'kickoff intro' });
        store.append({ ts: baseTs + 1000, speaker: 'them', text: 'agenda overview' });

        // Provider backed by an in-memory cell so the dispatcher's write
        // shows up on the next read.
        const cell = { claudeSessionId: null, lastTranscriptSentTs: null };
        const provider = {
            get: () => ({ ...cell }),
            set: (ctx) => { cell.claudeSessionId = ctx.claudeSessionId; cell.lastTranscriptSentTs = ctx.lastTranscriptSentTs; },
        };

        const askCalls = [];
        const claude = {
            ask: vi.fn(async (args) => {
                askCalls.push({ ...args });
                return { sessionId: 'claude-sess-A1' };
            }),
        };
        const config = { get: () => null };
        const grabber = { grab: async () => null };

        const d = new FireDispatcher({
            store, classifier: null, grabber, claude, config,
            onState: () => {},
            claudeContextProvider: provider,
        });

        // First manual ask.
        await d.manualFire({ question: 'What is the agenda?' });
        for (let i = 0; i < 200 && (askCalls.length < 1 || !cell.claudeSessionId); i++) {
            await new Promise((r) => setImmediate(r));
        }

        expect(askCalls).toHaveLength(1);
        expect(askCalls[0].resumeSessionId).toBeNull();
        expect(askCalls[0].isFirstAsk).toBe(true);
        // Full transcript so far on first ask.
        expect(askCalls[0].transcriptTail).toContain('kickoff intro');
        expect(askCalls[0].transcriptTail).toContain('agenda overview');
        // Provider was updated with the captured session id.
        expect(cell.claudeSessionId).toBe('claude-sess-A1');
        expect(typeof cell.lastTranscriptSentTs).toBe('number');

        // New transcript line lands AFTER the first ask completed.
        const afterFirstAskTs = cell.lastTranscriptSentTs;
        // Ensure subsequent line ts is strictly > stored cutoff. Date.now()
        // may equal afterFirstAskTs on fast machines; bump by 1 ms.
        store.append({ ts: afterFirstAskTs + 1, speaker: 'me', text: 'follow-up decision item' });

        // Update claude mock to return a new session id (resume keeps same id
        // in production; tests simulate either case fine).
        claude.ask.mockImplementationOnce(async (args) => {
            askCalls.push({ ...args });
            return { sessionId: 'claude-sess-A1' };
        });

        await d.manualFire({ question: 'Summarise the decision' });
        for (let i = 0; i < 200 && askCalls.length < 2; i++) {
            await new Promise((r) => setImmediate(r));
        }

        expect(askCalls).toHaveLength(2);
        expect(askCalls[1].resumeSessionId).toBe('claude-sess-A1');
        expect(askCalls[1].isFirstAsk).toBe(false);
        // Delta only — old lines must not appear in the second prompt.
        expect(askCalls[1].transcriptTail).toContain('follow-up decision item');
        expect(askCalls[1].transcriptTail).not.toContain('kickoff intro');
        expect(askCalls[1].transcriptTail).not.toContain('agenda overview');
    });

    it('delta mode also carries transcriptFull so non-resuming providers see the whole window', async () => {
        const store = new TranscriptStore({ maxMinutes: 60 });
        const baseTs = Date.now() - 10_000;
        store.append({ ts: baseTs, speaker: 'them', text: 'kickoff intro' });

        // Simulate: a Claude ask already happened and advanced the cursor.
        const cell = { claudeSessionId: 'claude-sess-A1', lastTranscriptSentTs: baseTs };
        const provider = {
            get: () => ({ ...cell }),
            set: (ctx) => { cell.claudeSessionId = ctx.claudeSessionId; cell.lastTranscriptSentTs = ctx.lastTranscriptSentTs; },
        };
        store.append({ ts: baseTs + 1000, speaker: 'me', text: 'follow-up decision item' });

        const askCalls = [];
        const claude = { ask: vi.fn(async (args) => { askCalls.push({ ...args }); return { sessionId: 'claude-sess-A1' }; }) };

        const d = new FireDispatcher({
            store, classifier: null, grabber: { grab: async () => null }, claude,
            config: { get: () => null },
            onState: () => {},
            claudeContextProvider: provider,
        });

        await d.manualFire({ question: 'q' });
        for (let i = 0; i < 200 && askCalls.length < 1; i++) {
            await new Promise((r) => setImmediate(r));
        }

        expect(askCalls).toHaveLength(1);
        // Delta excludes the already-seen line, full window includes it.
        expect(askCalls[0].transcriptTail).toContain('follow-up decision item');
        expect(askCalls[0].transcriptTail).not.toContain('kickoff intro');
        expect(askCalls[0].transcriptFull).toContain('kickoff intro');
        expect(askCalls[0].transcriptFull).toContain('follow-up decision item');
    });

    it('advances lastTranscriptSentTs to the newest line at fire time, not answer completion', async () => {
        const store = new TranscriptStore({ maxMinutes: 60 });
        const baseTs = Date.now() - 10_000;
        store.append({ ts: baseTs, speaker: 'them', text: 'kickoff intro' });

        const cell = { claudeSessionId: null, lastTranscriptSentTs: null };
        const provider = {
            get: () => ({ ...cell }),
            set: (ctx) => { cell.claudeSessionId = ctx.claudeSessionId; cell.lastTranscriptSentTs = ctx.lastTranscriptSentTs; },
        };

        const askCalls = [];
        // Slow answer: a line lands while the assistant is still streaming.
        const claude = {
            ask: vi.fn(async (args) => {
                askCalls.push({ ...args });
                store.append({ ts: Date.now(), speaker: 'them', text: 'spoken during answer' });
                return { sessionId: 'claude-sess-A1' };
            }),
        };

        const d = new FireDispatcher({
            store, classifier: null, grabber: { grab: async () => null }, claude,
            config: { get: () => null },
            onState: () => {},
            claudeContextProvider: provider,
        });

        await d.manualFire({ question: 'q1' });
        for (let i = 0; i < 200 && (askCalls.length < 1 || !cell.claudeSessionId); i++) {
            await new Promise((r) => setImmediate(r));
        }

        // Cursor points at the newest line included in the tail (baseTs), so
        // the line spoken during the answer is still ahead of the cursor.
        expect(cell.lastTranscriptSentTs).toBe(baseTs);

        await d.manualFire({ question: 'q2' });
        for (let i = 0; i < 200 && askCalls.length < 2; i++) {
            await new Promise((r) => setImmediate(r));
        }

        // The mid-answer line reaches the next ask instead of being lost.
        expect(askCalls[1].transcriptTail).toContain('spoken during answer');
    });

    it('falls back to 30s tail when no claude context provider is wired (e.g. manual ask outside Listen)', async () => {
        const store = new TranscriptStore({ maxMinutes: 60 });
        const now = Date.now();
        store.append({ ts: now - 40_000, speaker: 'them', text: 'old line' });
        store.append({ ts: now - 5_000, speaker: 'them', text: 'recent line' });

        const askCalls = [];
        const claude = { ask: vi.fn(async (args) => { askCalls.push({ ...args }); return { sessionId: null }; }) };
        const config = { get: () => null };
        const grabber = { grab: async () => null };

        const d = new FireDispatcher({
            store, classifier: null, grabber, claude, config,
            onState: () => {},
            claudeContextProvider: null,
        });

        await d.manualFire({ question: 'q' });
        for (let i = 0; i < 200 && askCalls.length < 1; i++) {
            await new Promise((r) => setImmediate(r));
        }

        expect(askCalls).toHaveLength(1);
        expect(askCalls[0].resumeSessionId).toBeNull();
        expect(askCalls[0].isFirstAsk).toBe(true);
        // 30s tail only.
        expect(askCalls[0].transcriptTail).toContain('recent line');
        expect(askCalls[0].transcriptTail).not.toContain('old line');
    });
});
