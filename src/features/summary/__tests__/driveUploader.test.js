import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const { uploadSummary } = require('../driveUploader.js');

describe('driveUploader', () => {
    it('uses calendar title override and sends update identity to the webhook', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudely-upload-test-'));
        const summaryPath = path.join(dir, 'meeting.summary.md');
        fs.writeFileSync(summaryPath, '# Generated AI Headline\n\nBody');

        let requestBody = null;
        const fetchImpl = async (url, options) => {
            requestBody = JSON.parse(options.body);
            return {
                ok: true,
                status: 200,
                text: async () => JSON.stringify({
                    ok: true,
                    id: 'existing-doc',
                    url: 'https://docs.example/existing-doc',
                    updated: true,
                    supportsDedupe: true,
                }),
            };
        };

        const result = await uploadSummary({
            markdownPath: summaryPath,
            fallbackTitle: 'fallback title',
            webhookUrl: 'https://script.example/exec',
            secret: 'secret',
            fetchImpl,
            docId: 'existing-doc',
            titleOverride: 'Creative Engine Scrum',
            dedupeKey: 'calendar:abc123',
        });

        expect(result.title).toBe('Creative Engine Scrum');
        expect(result.updateHonored).toBe(true);
        expect(result.supportsDedupe).toBe(true);
        expect(requestBody).toMatchObject({
            title: 'Creative Engine Scrum',
            docId: 'existing-doc',
            dedupeKey: 'calendar:abc123',
        });
    });
});
