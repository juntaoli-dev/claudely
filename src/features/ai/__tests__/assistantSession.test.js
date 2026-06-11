import { describe, it, expect, vi } from 'vitest';
import { AssistantSession } from '../assistantSession.js';

describe('AssistantSession', () => {
    it('uses Codex first', async () => {
        const codexSession = { ask: vi.fn(async ({ onDelta }) => onDelta('codex answer')) };
        const claudeSession = { ask: vi.fn(async () => {}) };
        const session = new AssistantSession({ codexSession, claudeSession });

        const deltas = [];
        await session.ask({
            question: 'q',
            onDelta: (text) => deltas.push(text),
        });

        expect(deltas.join('')).toBe('codex answer');
        expect(codexSession.ask).toHaveBeenCalledOnce();
        expect(claudeSession.ask).not.toHaveBeenCalled();
    });

    it('falls back to Claude when Codex fails', async () => {
        const codexSession = { ask: vi.fn(async () => { throw new Error('missing binary'); }) };
        const claudeSession = { ask: vi.fn(async ({ onDelta, onEvent }) => {
            onEvent({ kind: 'provider', provider: { id: 'claude', name: 'Claude Code', status: 'running' } });
            onDelta('claude answer');
        }) };
        const session = new AssistantSession({ codexSession, claudeSession });

        const deltas = [];
        const providers = [];
        await session.ask({
            question: 'q',
            onDelta: (text) => deltas.push(text),
            onEvent: (event) => {
                if (event.kind === 'provider') providers.push(event.provider);
            },
        });

        expect(deltas.join('')).toBe('claude answer');
        expect(codexSession.ask).toHaveBeenCalledOnce();
        expect(claudeSession.ask).toHaveBeenCalledOnce();
        expect(providers.some((provider) => provider.id === 'codex' && provider.status === 'failed')).toBe(true);
        expect(providers.some((provider) => provider.id === 'claude' && provider.status === 'fallback')).toBe(true);
    });
});
