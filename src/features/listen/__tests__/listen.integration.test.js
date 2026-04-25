import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { TranscriptStore } from '../transcriptStore.js';
import { FireDispatcher } from '../../fire/fireDispatcher.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('listen integration', () => {
    it('fires exactly twice on the fixture stream: the SSO question + wake phrase', async () => {
        const store = new TranscriptStore({ maxMinutes: 60 });
        const classifier = {
            classify: async (u) => ({
                addressed: /\?$/.test(u) || /SSO/.test(u),
                question: u,
            }),
        };
        const claude = { ask: vi.fn(async () => {}) };
        const config = { get: (k) => ({ autoAnswer: true, wakePhrases: ['hey claude'] }[k]) };
        const grabber = { grab: async () => null };

        const d = new FireDispatcher({ store, classifier, grabber, claude, config, onState: () => {} });

        const fixturePath = path.join(__dirname, '../../../../test/fixtures/utterance-stream.jsonl');
        const lines = fs.readFileSync(fixturePath, 'utf8').trim().split('\n').map(JSON.parse);

        for (const line of lines) {
            store.append(line);
            await d.maybeFire(line);
        }

        // Drain the queue: maybeFire returns immediately after queueing the
        // second hit, so wait for in-flight + queued to settle.
        for (let i = 0; i < 50 && (claude.ask.mock.calls.length < 2 || d.queueSize() > 0); i++) {
            await new Promise((r) => setImmediate(r));
        }

        expect(claude.ask).toHaveBeenCalledTimes(2);
    });
});
