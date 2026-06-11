import { describe, it, expect } from 'vitest';
import { matchWake } from '../wakePhrase.js';

describe('matchWake', () => {
    const phrases = ['hey codex', 'hey claude', 'hey claudely'];
    it('matches at start, case-insensitive', () => {
        expect(matchWake('Hey Claude, what is 2+2', phrases)).toBe('what is 2+2');
    });
    it('matches Codex wake phrase', () => {
        expect(matchWake('hey codex look at the frontend repo', phrases)).toBe('look at the frontend repo');
    });
    it('returns null when no phrase', () => {
        expect(matchWake('random chatter', phrases)).toBeNull();
    });
    it('strips trailing comma and whitespace', () => {
        expect(matchWake('hey claudely   does X work?', phrases)).toBe('does X work?');
    });
});
