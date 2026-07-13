import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const { SummaryDocRegistry } = require('../summaryDocRegistry.js');

describe('SummaryDocRegistry', () => {
    it('persists doc ids by summary identity key', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudely-registry-test-'));
        const filePath = path.join(dir, 'registry.json');
        const identity = {
            kind: 'calendar',
            key: 'calendar:test-key',
            title: 'Creative Engine Scrum',
            event: {
                title: 'Creative Engine Scrum',
                start: '2026-07-13T15:00:00.000Z',
                end: '2026-07-13T15:30:00.000Z',
                uid: 'uid-1',
                calendar: 'juntao.li@pmg.com',
            },
        };

        const registry = new SummaryDocRegistry({ filePath });
        registry.remember(identity, 'doc-123', { url: 'https://docs.example/doc-123' });

        const reloaded = new SummaryDocRegistry({ filePath });
        expect(reloaded.getDocId(identity.key)).toBe('doc-123');
        expect(JSON.parse(fs.readFileSync(filePath, 'utf8')).docs[identity.key].title).toBe('Creative Engine Scrum');
    });
});
