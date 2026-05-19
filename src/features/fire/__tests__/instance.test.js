import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';

// Use CJS require so we don't fight ESM interop on the singleton state.
const require = createRequire(import.meta.url);
const instance = require('../instance');

describe('fire/instance active-listen-context partial updates', () => {
    beforeEach(() => {
        instance.clearActiveListenContext();
    });

    it('setActiveListenContext({store, classifier}) does NOT wipe listenSessionId', () => {
        instance.updateActiveListenSessionId('listen-row-id-1');
        expect(instance.getActiveListenSessionId()).toBe('listen-row-id-1');

        // sttService's call shape: store + classifier, no listenSessionId key.
        const fakeStore = { since: () => '' };
        const fakeClassifier = { classify: async () => ({}) };
        instance.setActiveListenContext({ store: fakeStore, classifier: fakeClassifier });

        expect(instance.getActiveListenSessionId()).toBe('listen-row-id-1');
        expect(instance.getActiveStore()).toBe(fakeStore);
        expect(instance.getActiveClassifier()).toBe(fakeClassifier);
    });

    it('updateActiveListenSessionId(id) does NOT wipe store or classifier', () => {
        const fakeStore = { since: () => '' };
        const fakeClassifier = { classify: async () => ({}) };
        instance.setActiveListenContext({ store: fakeStore, classifier: fakeClassifier });

        instance.updateActiveListenSessionId('listen-row-id-2');

        expect(instance.getActiveStore()).toBe(fakeStore);
        expect(instance.getActiveClassifier()).toBe(fakeClassifier);
        expect(instance.getActiveListenSessionId()).toBe('listen-row-id-2');
    });

    it('clearActiveListenContext wipes everything', () => {
        instance.setActiveListenContext({
            store: { since: () => '' },
            classifier: {},
            listenSessionId: 'x',
        });
        instance.clearActiveListenContext();
        expect(instance.getActiveStore()).toBeNull();
        expect(instance.getActiveClassifier()).toBeNull();
        expect(instance.getActiveListenSessionId()).toBeNull();
    });
});
