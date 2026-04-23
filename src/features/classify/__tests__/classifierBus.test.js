import { describe, it, expect, vi } from 'vitest';
import { ClassifierBus } from '../classifierBus.js';

describe('ClassifierBus', () => {
    it('falls back to regex when binary emits model-unavailable', async () => {
        const fakeSpawn = () => ({
            stdout: { on: () => {} },
            stderr: { on: (ev, cb) => { if (ev === 'data') setImmediate(() => cb('ERR: model-unavailable\n')); } },
            stdin: { write: () => {} },
            on: () => {},
            kill: () => {},
        });
        const bus = new ClassifierBus({ binaryPath: '/fake', spawnFn: fakeSpawn });
        bus.start();
        await new Promise((r) => setTimeout(r, 10));
        const result = await bus.classify('what does the auth service do?');
        expect(result.addressed).toBe(true);
        expect(result.question).toContain('auth service');
    });

    it('parses JSON line from child stdout in happy path', async () => {
        let stdoutCb;
        const fakeSpawn = () => ({
            stdout: { on: (ev, cb) => { if (ev === 'data') stdoutCb = cb; } },
            stderr: { on: () => {} },
            stdin: { write: () => {} },
            on: () => {},
            kill: () => {},
        });
        const bus = new ClassifierBus({ binaryPath: '/fake', spawnFn: fakeSpawn });
        bus.start();
        const p = bus.classify('does auth support SSO?');
        setImmediate(() => stdoutCb(Buffer.from('{"addressed":true,"question":"does auth support SSO?"}\n')));
        const result = await p;
        expect(result).toEqual({ addressed: true, question: 'does auth support SSO?' });
    });
});
