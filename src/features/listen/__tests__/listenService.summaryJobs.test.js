import { describe, it, expect } from 'vitest';
import listenServiceModule from '../listenService.js';

const { ListenService } = listenServiceModule;

describe('ListenService summary jobs', () => {
    it('waits for tracked summary jobs before shutdown continues', async () => {
        const service = new ListenService();
        let finish;
        const job = new Promise((resolve) => {
            finish = resolve;
        });

        service._trackSummaryJob(job, 'test summary');
        expect(service.pendingSummaryCount()).toBe(1);

        const wait = service.waitForPendingSummaries({ timeoutMs: 1000 });
        await Promise.resolve();
        expect(service.pendingSummaryCount()).toBe(1);

        finish();
        const result = await wait;

        expect(result).toEqual({ completed: true, count: 1 });
        expect(service.pendingSummaryCount()).toBe(0);
    });
});
