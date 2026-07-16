import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { buildSummaryIdentity, selectCalendarEvent } = require('../summaryIdentity.js');

describe('summaryIdentity', () => {
    it('uses the calendar event title and occurrence as the summary identity', () => {
        const event = {
            title: 'Creative Engine Scrum',
            uid: 'recurring-series-uid',
            calendar: 'juntao.li@pmg.com',
            start: '2026-07-13T15:00:00.000Z',
            end: '2026-07-13T15:30:00.000Z',
        };

        const identity = buildSummaryIdentity({
            events: [event],
            recordedFrom: '2026-07-13T15:04:00.000Z',
            recordedTo: '2026-07-13T15:24:00.000Z',
            fallbackTitle: '2026-07-13T15-04-00-000Z',
            fallbackBaseName: '2026-07-13T15-04-00-000Z',
        });

        expect(identity.kind).toBe('calendar');
        expect(identity.title).toBe('Creative Engine Scrum');
        expect(identity.key).toMatch(/^calendar:/);
    });

    it('does not collapse recurring event instances that share the same uid', () => {
        const base = {
            title: 'Creative Engine Scrum',
            uid: 'recurring-series-uid',
            calendar: 'juntao.li@pmg.com',
        };
        const monday = buildSummaryIdentity({
            events: [{ ...base, start: '2026-07-13T15:00:00.000Z', end: '2026-07-13T15:30:00.000Z' }],
            recordedFrom: '2026-07-13T15:05:00.000Z',
            recordedTo: '2026-07-13T15:25:00.000Z',
            fallbackTitle: 'monday',
            fallbackBaseName: 'monday',
        });
        const tuesday = buildSummaryIdentity({
            events: [{ ...base, start: '2026-07-14T15:00:00.000Z', end: '2026-07-14T15:30:00.000Z' }],
            recordedFrom: '2026-07-14T15:05:00.000Z',
            recordedTo: '2026-07-14T15:25:00.000Z',
            fallbackTitle: 'tuesday',
            fallbackBaseName: 'tuesday',
        });

        expect(monday.key).not.toBe(tuesday.key);
    });

    it('does not collapse matched recurring occurrences when Calendar.app returns the master date', () => {
        const recurringMaster = {
            title: 'Creative Engine Scrum',
            uid: 'recurring-series-uid',
            calendar: 'juntao.li@pmg.com',
            start: '2026-06-12T15:00:00.000Z',
            end: '2026-06-12T15:30:00.000Z',
            matchedWindow: true,
        };
        const monday = buildSummaryIdentity({
            events: [recurringMaster],
            recordedFrom: '2026-07-13T15:05:00.000Z',
            recordedTo: '2026-07-13T15:25:00.000Z',
            fallbackTitle: 'monday',
            fallbackBaseName: 'monday',
        });
        const tuesday = buildSummaryIdentity({
            events: [recurringMaster],
            recordedFrom: '2026-07-14T15:05:00.000Z',
            recordedTo: '2026-07-14T15:25:00.000Z',
            fallbackTitle: 'tuesday',
            fallbackBaseName: 'tuesday',
        });

        expect(monday.key).not.toBe(tuesday.key);
    });

    it('selects the event with the strongest overlap', () => {
        const selected = selectCalendarEvent([
            {
                title: 'Near Miss',
                start: '2026-07-13T14:00:00.000Z',
                end: '2026-07-13T14:30:00.000Z',
            },
            {
                title: 'Actual Meeting',
                start: '2026-07-13T15:00:00.000Z',
                end: '2026-07-13T16:00:00.000Z',
            },
        ], '2026-07-13T15:15:00.000Z', '2026-07-13T15:45:00.000Z');

        expect(selected.title).toBe('Actual Meeting');
    });

    it('excludes overlapping OOO and PTO blocks before selecting a meeting', () => {
        const selected = selectCalendarEvent([
            {
                title: 'Caleb OOO',
                start: '2026-07-13T00:00:00.000Z',
                end: '2026-07-17T23:59:59.000Z',
                isActive: true,
                matchedWindow: true,
            },
            {
                title: 'Juntao PTO',
                start: '2026-07-13T00:00:00.000Z',
                end: '2026-07-13T23:59:59.000Z',
                isActive: true,
                matchedWindow: true,
            },
            {
                title: 'Creative Engine Scrum',
                uid: 'recurring-series-uid',
                // Calendar.app can return the recurring series' original
                // timestamp even though its query matched today's occurrence.
                start: '2026-06-12T15:00:00.000Z',
                end: '2026-06-12T15:30:00.000Z',
                matchedWindow: true,
            },
        ], '2026-07-13T15:15:00.000Z', '2026-07-13T15:45:00.000Z');

        expect(selected.title).toBe('Creative Engine Scrum');
    });

    it('falls back to a session identity when availability blocks are the only matches', () => {
        const identity = buildSummaryIdentity({
            events: [{
                title: 'Out of Office',
                start: '2026-07-13T00:00:00.000Z',
                end: '2026-07-17T23:59:59.000Z',
                isActive: true,
                matchedWindow: true,
            }],
            recordedFrom: '2026-07-13T15:15:00.000Z',
            recordedTo: '2026-07-13T15:45:00.000Z',
            fallbackTitle: '2026-07-13T15-15-00-000Z',
            fallbackBaseName: '2026-07-13T15-15-00-000Z',
        });

        expect(identity.kind).toBe('session');
        expect(identity.title).toBe('2026-07-13T15-15-00-000Z');
    });

    it('falls back to a session identity when no calendar event matches', () => {
        const identity = buildSummaryIdentity({
            events: [],
            recordedFrom: '2026-07-13T15:15:00.000Z',
            recordedTo: '2026-07-13T15:45:00.000Z',
            fallbackTitle: 'Generated AI Headline',
            fallbackBaseName: '2026-07-13T15-15-00-000Z',
        });

        expect(identity.kind).toBe('session');
        expect(identity.title).toBe('Generated AI Headline');
        expect(identity.key).toMatch(/^session:/);
    });
});
