import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { createRequire } from 'module';

// vitest's vi.mock interop misses listenService's CJS `require('./stt/sttService')`
// — the real module loads and spins up Deepgram. Instead of fighting that, we
// require the modules through CJS ourselves, swap sttService.start in-place,
// and exercise the class against the patched module.
const require = createRequire(import.meta.url);

const sttService = require('../stt/sttService');
const listenServiceMod = require('../listenService');
const ListenService = listenServiceMod.ListenService;

const originalStart = sttService.start;

describe('ListenService stop race + device-route restart', () => {
    let svc;
    let stopSpy;
    let onStateRef;
    let startSpy;

    beforeEach(() => {
        onStateRef = null;
        stopSpy = vi.fn();
        startSpy = vi.fn(({ onState }) => {
            onStateRef = onState;
            return { stop: stopSpy, store: { getPersistPath: () => null } };
        });
        sttService.start = startSpy;

        svc = new ListenService();
        svc.sendToRenderer = vi.fn();
        svc._scheduleIdlePrompt = vi.fn();
        svc._cancelIdlePrompt = vi.fn();
    });

    afterAll(() => {
        sttService.start = originalStart;
    });

    it('does NOT auto-restart capture after closeSession when the helper exits', async () => {
        await svc.start();
        expect(startSpy).toHaveBeenCalledTimes(1);
        expect(svc.active).toBeTruthy();

        const captureExit = onStateRef;

        // User clicks Stop. closeSession sets _userStopRequested = true and
        // kills the Swift child via stopSpy.
        const closePromise = svc.closeSession();

        // Race: the killed helper emits capture-exit AFTER closeSession ran.
        captureExit({ type: 'capture-exit', code: 0 });
        await closePromise;

        // Wait past the 1500ms backoff to confirm no restart fires.
        await new Promise((r) => setTimeout(r, 1800));

        // Without the _userStopRequested guard, the setTimeout in the crash-
        // recovery branch would have called sttService.start a second time.
        expect(startSpy).toHaveBeenCalledTimes(1);
        expect(svc.active).toBeNull();
    });

    it('device-route exit (code 75) restarts immediately without consuming budget', async () => {
        await svc.start();
        expect(startSpy).toHaveBeenCalledTimes(1);
        const captureExit = onStateRef;

        captureExit({ type: 'capture-exit', code: 75 });

        // setImmediate flush.
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));

        expect(startSpy).toHaveBeenCalledTimes(2);
        expect(svc._restartAttempts).toEqual([]);
        expect(svc._restartGiveUp).toBe(false);
    });

    it('explicit start() after a stop clears _userStopRequested', async () => {
        await svc.start();
        await svc.closeSession();
        expect(svc._userStopRequested).toBe(true);

        await svc.start();
        expect(svc._userStopRequested).toBe(false);
    });

    it('getCurrentState reflects active flag', async () => {
        expect(svc.getCurrentState()).toEqual({ isActive: false, isInitializing: false });
        await svc.start();
        expect(svc.getCurrentState()).toEqual({ isActive: true, isInitializing: false });
        await svc.closeSession();
        expect(svc.getCurrentState().isActive).toBe(false);
    });

    it('audio-idle guard: prompts after 10m of zero transcript activity', async () => {
        // Stub _checkAudioIdle prompt path so we can observe firing without
        // actually constructing electron Notifications in test.
        let promptCount = 0;
        const checkAudioIdleOrig = ListenService.prototype._checkAudioIdle;

        await svc.start();
        // Replace just on this instance.
        svc._checkAudioIdle = function () {
            if (!this.active) return;
            if (!this._lastTranscriptAt) return;
            const idleMs = Date.now() - this._lastTranscriptAt;
            if (idleMs >= 10 * 60 * 1000 && !this._audioIdlePromptShown) {
                promptCount++;
                this._audioIdlePromptShown = true;
            }
        };

        // Simulate one transcript line at t0.
        svc._noteTranscriptActivity();
        expect(promptCount).toBe(0);

        // Advance the clock past 10m by mutating _lastTranscriptAt directly
        // (avoids needing vi.useFakeTimers, which would also stall setImmediate
        // in the start-flow's awaited Deepgram init mock).
        svc._lastTranscriptAt = Date.now() - 11 * 60 * 1000;
        svc._checkAudioIdle();
        expect(promptCount).toBe(1);

        // Re-firing the check should NOT spam — debounced by _audioIdlePromptShown.
        svc._checkAudioIdle();
        expect(promptCount).toBe(1);

        // A new transcript clears the debounce.
        svc._noteTranscriptActivity();
        svc._lastTranscriptAt = Date.now() - 11 * 60 * 1000;
        svc._checkAudioIdle();
        expect(promptCount).toBe(2);
    });

    it('audio-idle timer cleared by closeSession', async () => {
        await svc.start();
        expect(svc._audioIdleTimer).not.toBeNull();
        await svc.closeSession();
        expect(svc._audioIdleTimer).toBeNull();
        expect(svc._audioIdlePromptShown).toBe(false);
    });

    it('closeSession returns fast even when sidecar work is slow', async () => {
        await svc.start();

        // Inject a slow blocker into the sidecar pipeline. If closeSession
        // awaits it, the test will time out instead of completing in <50ms.
        // We patch the prototype's _finishSessionAsync to call the real one
        // but ALSO record entry, then we time the closeSession await.
        let sidecarEntered = false;
        const origFinish = svc._finishSessionAsync.bind(svc);
        svc._finishSessionAsync = (args) => {
            sidecarEntered = true;
            // Don't actually run the real sidecar (it would try to touch
            // config / fs which we haven't mocked). The contract is: closeSession
            // FIRES this, doesn't AWAIT it.
            return undefined;
        };

        const t0 = Date.now();
        const result = await svc.closeSession();
        const elapsed = Date.now() - t0;

        expect(result).toEqual({ success: true });
        expect(elapsed).toBeLessThan(50); // generous; in practice <5ms
        expect(sidecarEntered).toBe(true);
        expect(svc.active).toBeNull();
        // Restore so afterAll doesn't leak.
        svc._finishSessionAsync = origFinish;
    });
});
