import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { parseOutput } = require('../calendarContext.js');

describe('calendarContext', () => {
    it('drops OOO and PTO events at ingestion while retaining the real meeting', () => {
        const output = [
            'TITLE:Caleb OOO||START:2026-07-13T00:00:00||END:2026-07-17T23:59:59||ACTIVE:true||UID:ooo||CAL:juntao.li@pmg.com',
            'TITLE:Jay PTO||START:2026-07-16T00:00:00||END:2026-07-16T23:59:59||ACTIVE:true||UID:pto||CAL:juntao.li@pmg.com',
            'TITLE:PMG All Hands||START:2026-07-16T10:30:00||END:2026-07-16T11:45:00||ACTIVE:true||UID:meeting||CAL:juntao.li@pmg.com',
        ].join('\n');

        const events = parseOutput(output);

        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
            title: 'PMG All Hands',
            uid: 'meeting',
            matchedWindow: true,
        });
    });
});
