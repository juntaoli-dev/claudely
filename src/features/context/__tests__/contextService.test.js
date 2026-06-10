import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ContextService, normalizeContextPath } from '../contextService.js';

function makeConfig(initial = {}) {
    const values = { ...initial };
    return {
        get: vi.fn((key) => values[key]),
        set: vi.fn((key, value) => {
            values[key] = value;
        }),
        saveUserConfig: vi.fn(),
        values,
    };
}

describe('ContextService', () => {
    it('validates and normalizes folders before switching context', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudely-context-'));
        expect(normalizeContextPath(dir)).toBe(fs.realpathSync(dir));
        expect(() => normalizeContextPath(path.join(dir, 'missing'))).toThrow(/does not exist/);
    });

    it('persists the active context, tracks recents, and emits one changed event', () => {
        const first = fs.mkdtempSync(path.join(os.tmpdir(), 'claudely-context-a-'));
        const second = fs.mkdtempSync(path.join(os.tmpdir(), 'claudely-context-b-'));
        const config = makeConfig({ projectCwd: first, recentProjectCwds: [first] });
        const bridge = new EventEmitter();
        bridge.emit = vi.fn(bridge.emit.bind(bridge));
        const service = new ContextService({ configStore: config, bridge, env: {} });
        const changed = vi.fn();
        service.on('changed', changed);

        const result = service.setActiveContext(second);

        expect(result.changed).toBe(true);
        expect(result.active.cwd).toBe(fs.realpathSync(second));
        expect(config.set).toHaveBeenCalledWith('projectCwd', fs.realpathSync(second));
        expect(config.values.recentProjectCwds[0]).toBe(fs.realpathSync(second));
        expect(config.saveUserConfig).toHaveBeenCalledOnce();
        expect(changed).toHaveBeenCalledOnce();
        expect(bridge.emit).toHaveBeenCalledWith('ai-context:changed', expect.objectContaining({
            active: expect.objectContaining({ cwd: fs.realpathSync(second) }),
        }));
    });

    it('keeps a filtered switch history for transcript sidecars', () => {
        const first = fs.mkdtempSync(path.join(os.tmpdir(), 'claudely-context-c-'));
        const second = fs.mkdtempSync(path.join(os.tmpdir(), 'claudely-context-d-'));
        const config = makeConfig({ projectCwd: first, recentProjectCwds: [] });
        const service = new ContextService({ configStore: config, bridge: new EventEmitter(), env: {} });

        const before = new Date(Date.now() - 1000);
        service.setActiveContext(second);
        const after = new Date(Date.now() + 1000);

        const switches = service.getSwitchesBetween(before, after);
        expect(switches).toHaveLength(1);
        expect(switches[0].active.cwd).toBe(fs.realpathSync(second));
        expect(service.getSwitchesBetween(after, new Date(Date.now() + 2000))).toHaveLength(0);
    });
});
