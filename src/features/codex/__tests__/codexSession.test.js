import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import { CodexSession, buildCodexEnv } from '../codexSession.js';

function makeChild({ stdout = 'answer', stderr = 'thinking\n', code = 0 } = {}) {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();
    setImmediate(() => {
        if (stderr) child.stderr.emit('data', stderr);
        if (stdout) child.stdout.emit('data', stdout);
        child.emit('close', code);
    });
    return child;
}

describe('CodexSession', () => {
    it('runs codex exec through the local CLI and strips OpenAI API env vars', async () => {
        const spawnFn = vi.fn(() => makeChild());
        const spawnSyncFn = vi.fn(() => ({ status: 0, stdout: 'codex 1.0.0\n', stderr: '' }));
        const session = new CodexSession({
            cwd: '/tmp/repo',
            processCwd: '/tmp',
            cliPath: '/usr/local/bin/codex',
            spawnFn,
            spawnSyncFn,
        });

        const deltas = [];
        const events = [];
        await session.ask({
            question: 'what changed?',
            transcriptTail: 'me: hello',
            imagePath: '/tmp/screen.png',
            onDelta: (text) => deltas.push(text),
            onEvent: (event) => events.push(event),
        });

        expect(deltas.join('')).toBe('answer');
        expect(spawnFn).toHaveBeenCalledOnce();
        const [cmd, args, options] = spawnFn.mock.calls[0];
        expect(cmd).toBe('/usr/local/bin/codex');
        expect(args[0]).toBe('exec');
        expect(args).toContain('--cd');
        expect(args).toContain('/tmp/repo');
        expect(args).toContain('--skip-git-repo-check');
        expect(args).toContain('--sandbox');
        expect(args).toContain('read-only');
        expect(args).toContain('--color');
        expect(args).toContain('never');
        expect(args).toContain('-o');
        expect(args).toContain('forced_login_method="chatgpt"');
        expect(options.cwd).toBe('/tmp');
        expect(options.env.OPENAI_API_KEY).toBeUndefined();
        expect(events.some((event) => event.kind === 'provider' && event.provider.id === 'codex')).toBe(true);
    });

    it('removes OpenAI API billing environment variables', () => {
        const env = buildCodexEnv({
            PATH: '/bin',
            OPENAI_API_KEY: 'sk-test',
            OPENAI_BASE_URL: 'https://api.example',
            OPENAI_PROJECT_ID: 'proj',
        });

        expect(env.PATH).toBe('/bin');
        expect(env.OPENAI_API_KEY).toBeUndefined();
        expect(env.OPENAI_BASE_URL).toBeUndefined();
        expect(env.OPENAI_PROJECT_ID).toBeUndefined();
    });
});
