import { describe, it, expect, vi } from 'vitest';
import { FireDispatcher } from '../fireDispatcher.js';

describe('FireDispatcher', () => {
    const makeDeps = (overrides = {}) => ({
        store: { tail: () => 'them: does our auth use SSO?' },
        classifier: { classify: vi.fn(async () => ({ addressed: true, question: 'does our auth use SSO?' })) },
        grabber: { grab: vi.fn(async () => '/tmp/screen.png') },
        claude: { ask: vi.fn(async () => {}) },
        config: { get: (k) => ({ autoAnswer: true, wakePhrases: ['hey claude'] }[k]) },
        onState: vi.fn(),
        ...overrides,
    });

    const flush = async () => {
        for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
    };

    it('fires when classifier returns addressed and auto-answer ON', async () => {
        const deps = makeDeps();
        const d = new FireDispatcher(deps);
        await d.maybeFire({ text: 'does our auth use SSO?', speaker: 'them-0', ts: Date.now() });
        await flush();
        expect(deps.claude.ask).toHaveBeenCalledOnce();
    });

    it('skips when auto-answer OFF and no wake phrase', async () => {
        const deps = makeDeps({ config: { get: () => false } });
        const d = new FireDispatcher(deps);
        await d.maybeFire({ text: 'does our auth use SSO?', speaker: 'them-0', ts: Date.now() });
        expect(deps.claude.ask).not.toHaveBeenCalled();
    });

    it('fires on wake phrase even when auto-answer OFF', async () => {
        const deps = makeDeps({ config: { get: (k) => (k === 'autoAnswer' ? false : ['hey claude']) } });
        const d = new FireDispatcher(deps);
        await d.maybeFire({ text: 'hey claude what time is it', speaker: 'me', ts: Date.now() });
        await flush();
        expect(deps.claude.ask).toHaveBeenCalledOnce();
        expect(deps.claude.ask.mock.calls[0][0].question).toBe('what time is it');
    });

    it('queues a second fire while first is in flight, caps at 3', async () => {
        let resolveFirst;
        const deps = makeDeps({
            claude: { ask: vi.fn(() => new Promise((r) => { resolveFirst = r; })) },
        });
        const d = new FireDispatcher(deps);
        d.maybeFire({ text: 'q1?', speaker: 'them', ts: 1 });
        await flush();
        d.maybeFire({ text: 'q2?', speaker: 'them', ts: 2 });
        d.maybeFire({ text: 'q3?', speaker: 'them', ts: 3 });
        d.maybeFire({ text: 'q4?', speaker: 'them', ts: 4 });
        d.maybeFire({ text: 'q5?', speaker: 'them', ts: 5 });
        await flush();
        expect(d.queueSize()).toBe(3);
        resolveFirst();
    });
});
