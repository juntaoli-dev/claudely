import { describe, it, expect } from 'vitest';
import { TranscriptStore } from '../transcriptStore.js';

describe('TranscriptStore', () => {
  it('returns only lines within the last N seconds in tail()', () => {
    const store = new TranscriptStore({ maxMinutes: 60 });
    store.append({ text: 'old', speaker: 'A', ts: 1000 });
    store.append({ text: 'new', speaker: 'B', ts: 60_000 });
    const tail = store.tail({ now: 60_000, seconds: 30 });
    expect(tail).toBe('B: new');
  });

  it('drops oldest when over maxMinutes', () => {
    const store = new TranscriptStore({ maxMinutes: 1 });
    store.append({ text: 'old', speaker: 'A', ts: 0 });
    store.append({ text: 'new', speaker: 'B', ts: 120_000 });
    expect(store.all().length).toBe(1);
    expect(store.all()[0].text).toBe('new');
  });
});
