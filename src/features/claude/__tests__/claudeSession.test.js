import { describe, it, expect, vi } from 'vitest';
import { ClaudeSession } from '../claudeSession.js';

describe('ClaudeSession', () => {
  it('streams assistant tokens to onDelta and resolves on completion', async () => {
    const fakeQuery = vi.fn(async function* () {
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'hello ' }] } };
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'world' }] } };
      yield { type: 'result', subtype: 'success' };
    });

    const session = new ClaudeSession({
      cwd: '/tmp',
      model: 'claude-sonnet-4-6',
      queryFn: fakeQuery,
    });

    const deltas = [];
    await session.ask({
      question: 'hi',
      transcriptTail: '',
      imagePath: null,
      onDelta: (t) => deltas.push(t),
    });

    expect(deltas.join('')).toBe('hello world');
    expect(fakeQuery).toHaveBeenCalledOnce();
  });
});
