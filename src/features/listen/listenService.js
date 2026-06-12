// src/features/listen/listenService.js
//
// Thin wrapper over the new stt.start() pipeline. Keeps the IPC surface
// existing Glass renderer still uses (listen:changeSession, session-state-changed,
// stt-update) while delegating the heavy lifting to Claudely's AudioBus +
// Deepgram pipeline.

const stt = require('./stt/sttService');
const sessionRepository = require('../common/repositories/session');
const sttRepository = require('./stt/repositories');
const internalBridge = require('../../bridge/internalBridge');

const IDLE_PROMPT_MS = Number(process.env.CLAUDELY_IDLE_PROMPT_MS) || 60 * 60 * 1000; // 1 hour
const SUMMARY_SHUTDOWN_WAIT_MS = Number(process.env.CLAUDELY_SUMMARY_SHUTDOWN_WAIT_MS) || 240_000;
// Separate "no speech detected" guard: meeting ended but the helper is still
// piping silence to Deepgram (Deepgram emits no transcripts on pure silence,
// so byte-counters keep climbing but nothing useful happens). Prompt the user
// after this many ms of zero finals/interims so the session doesn't sit open
// burning Deepgram minutes after the call ended.
const AUDIO_IDLE_PROMPT_MS = Number(process.env.CLAUDELY_AUDIO_IDLE_PROMPT_MS) || 10 * 60 * 1000; // 10 minutes
const AUDIO_IDLE_CHECK_MS = Number(process.env.CLAUDELY_AUDIO_IDLE_CHECK_MS) || 60 * 1000; // re-evaluate once a minute

// Google Calendar exposes events at https://www.google.com/calendar/event?eid=<base64>
// where <base64> is base64(`${icsUid} ${calendarId}`). We don't have the
// calendar id here, but the uid alone is often enough for users since it's
// unique per event in Google's system. Returns empty when uid missing.
function buildGoogleCalLinkFromIcsUid(uid) {
    if (!uid) return '';
    try {
        const b64 = Buffer.from(uid, 'utf8').toString('base64').replace(/=+$/, '');
        return `https://calendar.google.com/calendar/u/0/r/eventedit/${b64}`;
    } catch {
        return '';
    }
}

class ListenService {
    constructor() {
        this.active = null;          // { stop, store } from stt.start
        this.currentSessionId = null;
        this.isInitializing = false;
        this.idleTimer = null;
        this.sessionStartedAt = null;
        this._stoppingCapture = false;
        this._shuttingDown = false;
        // Restart-attempt accounting. If the Swift audio-capture helper keeps
        // dying (TCC denied, dead binary, kernel oom), we'd otherwise respawn
        // it forever — every loop allocates a fresh child process + Deepgram
        // WebSocket + TranscriptStore write stream + .jsonl file. After a
        // night that's thousands of leaked allocations, multi-GB RSS, and an
        // unkillable app. We give up after MAX in WINDOW_MS.
        this._restartAttempts = [];   // ms timestamps
        this._restartGiveUp = false;
        this._summaryJobs = new Set();
        // User-initiated stop must not race with the capture-exit auto-restart.
        // Without this flag: user clicks Stop → closeSession() kills the Swift
        // child → bus emits 'exit' → setTimeout(start, delay) fires → fresh
        // session boots and transcripts resume while the UI is still showing
        // "stopping…". Set on closeSession, cleared by any explicit start().
        this._userStopRequested = false;
        // Audio-idle guard state. Updated every time Deepgram emits a final or
        // interim line; checked once a minute by _audioIdleTimer.
        this._lastTranscriptAt = null;
        this._audioIdleTimer = null;
        this._audioIdlePromptShown = false;
        // Live-summary state. While a session runs, a timer re-summarizes the
        // transcript-so-far every CLAUDELY_LIVE_SUMMARY_MS and updates ONE
        // Google Doc in place (docId). Survives auto-restarts within the same
        // DB session so the meeting stays a single Doc; reset on a fresh
        // session. { timer, running, docId, lastSize, sessionId }.
        this._liveSummary = null;
        console.log('[ListenService] Service instance created.');
    }

    _scheduleAudioIdleCheck() {
        if (this._audioIdleTimer) clearInterval(this._audioIdleTimer);
        this._audioIdleTimer = setInterval(() => this._checkAudioIdle(), AUDIO_IDLE_CHECK_MS);
    }

    _cancelAudioIdleCheck() {
        if (this._audioIdleTimer) {
            clearInterval(this._audioIdleTimer);
            this._audioIdleTimer = null;
        }
        this._audioIdlePromptShown = false;
    }

    _noteTranscriptActivity() {
        this._lastTranscriptAt = Date.now();
        this._audioIdlePromptShown = false;
    }

    _checkAudioIdle() {
        if (!this.active) return;
        if (this._audioIdlePromptShown) return;
        if (!this._lastTranscriptAt) return;
        const idleMs = Date.now() - this._lastTranscriptAt;
        if (idleMs < AUDIO_IDLE_PROMPT_MS) return;

        const { Notification } = require('electron');
        const minutes = Math.floor(idleMs / 60_000);
        const title = `No speech detected for ${minutes}m`;
        const body = `Claudely hasn't picked up any speech in ${minutes}m. Pause the session, or keep listening?`;
        try {
            const n = new Notification({
                title,
                body,
                actions: [{ type: 'button', text: 'Pause' }, { type: 'button', text: 'Keep listening' }],
                closeButtonText: 'Dismiss',
            });
            this._audioIdlePromptShown = true;
            n.on('action', (event, index) => {
                if (index === 0) {
                    console.log('[ListenService] audio-idle prompt → user paused');
                    this.closeSession().catch(() => {});
                } else {
                    console.log('[ListenService] audio-idle prompt → keep listening');
                    // Reset the clock so we re-prompt after another full window
                    // of silence rather than immediately re-firing next minute.
                    this._lastTranscriptAt = Date.now();
                    this._audioIdlePromptShown = false;
                }
            });
            n.on('click', () => {
                this._lastTranscriptAt = Date.now();
                this._audioIdlePromptShown = false;
            });
            n.on('close', () => {
                this._lastTranscriptAt = Date.now();
                this._audioIdlePromptShown = false;
            });
            n.show();
        } catch (e) {
            console.warn('[ListenService] could not show audio-idle notification:', e.message);
            this._lastTranscriptAt = Date.now();
            this._audioIdlePromptShown = false;
        }
    }

    _scheduleIdlePrompt() {
        if (this.idleTimer) clearTimeout(this.idleTimer);
        this.idleTimer = setTimeout(() => this._showIdlePrompt(), IDLE_PROMPT_MS);
    }

    _cancelIdlePrompt() {
        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }
    }

    _showIdlePrompt() {
        const { Notification } = require('electron');
        const elapsedMs = Date.now() - (this.sessionStartedAt || Date.now());
        const hours = Math.floor(elapsedMs / 3_600_000);
        const title = `Claudely has been recording for ${hours}h`;
        const body = `Are you still in the meeting? If not, consider pausing the transcribing.`;
        try {
            const n = new Notification({
                title,
                body,
                actions: [{ type: 'button', text: 'Pause' }, { type: 'button', text: 'Keep recording' }],
                closeButtonText: 'Dismiss',
            });
            n.on('action', (event, index) => {
                if (index === 0) {
                    console.log('[ListenService] idle prompt → user paused');
                    this.closeSession().catch(() => {});
                } else {
                    console.log('[ListenService] idle prompt → keep recording');
                    this._scheduleIdlePrompt();
                }
            });
            n.on('click', () => {
                // No specific action button → re-arm so user gets reminded again later.
                this._scheduleIdlePrompt();
            });
            n.on('close', () => {
                // Dismissed without action → also re-arm.
                this._scheduleIdlePrompt();
            });
            n.show();
        } catch (e) {
            console.warn('[ListenService] could not show idle notification:', e.message);
            // If notifications fail, at least re-arm so we keep checking.
            this._scheduleIdlePrompt();
        }
    }

    sendToRenderer(channel, data) {
        const { windowPool } = require('../../window/windowManager');
        const listenWindow = windowPool?.get('listen');
        if (listenWindow && !listenWindow.isDestroyed()) {
            listenWindow.webContents.send(channel, data);
        }
    }

    // Push the canonical "is the session active right now" state to BOTH the
    // header (listen:stateReconcile, drives the Listen/Stop/Done button text)
    // and the listen pane (session-state-changed, drives the "Claudely is
    // Listening" timer). Used by start/closeSession and by the powerMonitor
    // resume handler so the two UI surfaces never disagree about whether STT
    // is running.
    broadcastCanonicalState() {
        const { windowPool } = require('../../window/windowManager');
        const state = this.getCurrentState();
        const header = windowPool?.get('header');
        const listenWindow = windowPool?.get('listen');
        if (header && !header.isDestroyed()) {
            header.webContents.send('listen:stateReconcile', state);
        }
        if (listenWindow && !listenWindow.isDestroyed()) {
            listenWindow.webContents.send('session-state-changed', { isActive: state.isActive });
        }
    }

    _pushStt(line, isFinal) {
        // Renderer SttView contract: { speaker, text, isFinal, isPartial }
        this.sendToRenderer('stt-update', {
            speaker: line.speaker,
            text: line.text,
            isFinal: !!isFinal,
            isPartial: !isFinal,
        });
    }

    async initialize() {}

    _trackSummaryJob(job, label = 'summary') {
        const tracked = Promise.resolve(job)
            .catch((e) => {
                console.warn(`[ListenService] ${label} failed:`, e.message);
            })
            .finally(() => {
                this._summaryJobs.delete(tracked);
            });
        this._summaryJobs.add(tracked);
        return tracked;
    }

    pendingSummaryCount() {
        return this._summaryJobs.size;
    }

    async waitForPendingSummaries({ timeoutMs = SUMMARY_SHUTDOWN_WAIT_MS } = {}) {
        const jobs = Array.from(this._summaryJobs);
        if (!jobs.length) return { completed: true, count: 0 };

        console.log(`[ListenService] waiting for ${jobs.length} pending summary job(s) before shutdown`);
        let timeout;
        const timeoutPromise = new Promise((resolve) => {
            timeout = setTimeout(() => resolve({ timedOut: true }), Math.max(1, timeoutMs));
        });

        const result = await Promise.race([
            Promise.allSettled(jobs).then(() => ({ timedOut: false })),
            timeoutPromise,
        ]);
        clearTimeout(timeout);

        if (result.timedOut) {
            console.warn(`[ListenService] summary wait timed out after ${Math.round(timeoutMs / 1000)}s; continuing shutdown`);
            return { completed: false, count: jobs.length };
        }

        console.log('[ListenService] pending summary jobs completed');
        return { completed: true, count: jobs.length };
    }

    async handleListenRequest(listenButtonText) {
        const { windowPool } = require('../../window/windowManager');
        const listenWindow = windowPool?.get('listen');
        const header = windowPool?.get('header');

        try {
            switch (listenButtonText) {
                case 'Listen':
                    console.log('[ListenService] Listen');
                    internalBridge.emit('window:requestVisibility', { name: 'listen', visible: true });
                    await this.start();
                    if (listenWindow && !listenWindow.isDestroyed()) {
                        listenWindow.webContents.send('session-state-changed', { isActive: true });
                    }
                    break;

                case 'Stop':
                    console.log('[ListenService] Stop');
                    await this.closeSession();
                    if (listenWindow && !listenWindow.isDestroyed()) {
                        listenWindow.webContents.send('session-state-changed', { isActive: false });
                    }
                    break;

                case 'Done':
                    console.log('[ListenService] Done');
                    internalBridge.emit('window:requestVisibility', { name: 'listen', visible: false });
                    if (listenWindow && !listenWindow.isDestroyed()) {
                        listenWindow.webContents.send('session-state-changed', { isActive: false });
                    }
                    break;

                default:
                    throw new Error(`[ListenService] unknown listenButtonText: ${listenButtonText}`);
            }
            if (header && !header.isDestroyed()) header.webContents.send('listen:changeSessionResult', { success: true });
        } catch (error) {
            console.error('[ListenService] error in handleListenRequest:', error);
            if (header && !header.isDestroyed()) header.webContents.send('listen:changeSessionResult', { success: false, error: error.message });
            throw error;
        }
    }

    async start() {
        if (this.active) return;
        if (this.isInitializing) return;
        this.isInitializing = true;
        this._stoppingCapture = false;
        // Manual or initial start clears the give-up flag and the rolling
        // attempt window so a fresh user-driven session gets a clean budget.
        this._restartGiveUp = false;
        this._restartAttempts = [];
        this._userStopRequested = false;
        this.sendToRenderer('update-status', 'Starting capture…');

        try {
            // DB session for transcript persistence link
            try {
                this.currentSessionId = await sessionRepository.getOrCreateActive('listen');
            } catch (e) {
                console.warn('[ListenService] Could not open DB session:', e.message);
                this.currentSessionId = null;
            }

            // Tell the fire instance which DB row to use for Claude resume
            // bookkeeping. Cleared on closeSession so a manual ask after stop
            // doesn't accidentally resume a Listen-session conversation.
            try {
                const { updateActiveListenSessionId } = require('../fire/instance');
                updateActiveListenSessionId(this.currentSessionId);
            } catch (_) { /* fire instance optional */ }

            // Fresh Listen session starts with a fresh Claude conversation —
            // wipe any stale resume id from this DB row in case the user is
            // restarting an old session that has one persisted. Also tell the
            // ask window so it drops its Q+A scrollback: those bubbles point
            // at the old --resume id Claude no longer knows about, and
            // leaving them visible makes follow-up asks look continuous when
            // they really aren't.
            if (this.currentSessionId) {
                try {
                    sessionRepository.setClaudeContext(this.currentSessionId, {
                        claudeSessionId: null,
                        lastTranscriptSentTs: null,
                    });
                } catch (_) {}
            }
            try {
                const { windowPool } = require('../../window/windowManager');
                const askWindow = windowPool?.get('ask');
                if (askWindow && !askWindow.isDestroyed()) {
                    askWindow.webContents.send('listen:sessionReset');
                }
            } catch (_) { /* ask window may not exist yet */ }

            this.active = stt.start({
                onFinal: (line) => {
                    this._noteTranscriptActivity();
                    this._pushStt(line, true);
                    if (this.currentSessionId) {
                        try {
                            sessionRepository.touch(this.currentSessionId);
                            sttRepository.addTranscript({
                                sessionId: this.currentSessionId,
                                speaker: line.speaker,
                                text: line.text,
                            });
                        } catch (e) {
                            // swallow; persistence is best-effort
                        }
                    }
                },
                onInterim: (line) => {
                    this._noteTranscriptActivity();
                    this._pushStt(line, false);
                },
                onState: (s) => {
                    if (s.type === 'listening') this.sendToRenderer('update-status', 'Listening…');
                    else if (s.type === 'error') this.sendToRenderer('update-status', `ERR: ${s.error}`);
                    else if (s.type === 'provider') this.sendToRenderer('ai-provider-update', s.provider);
                    else if (s.type === 'stderr') console.warn('[ListenService][stderr]', s.text.trim());
                    else if (s.type === 'capture-exit') {
                        // Swift audio-capture helper died (codesign hiccup,
                        // TCC race, kernel oom, …). Tear down and try a
                        // bounded number of restarts with backoff. After too
                        // many failures in a window we give up — without this
                        // a permanently-broken helper would respawn child
                        // processes + Deepgram sockets + new .jsonl streams
                        // forever, leaking RAM until the app is unkillable.
                        const code = s.code;
                        const wasActive = this.active;
                        this.active = null;
                        try { wasActive?.stop?.(); } catch (_) {}

                        if (this._shuttingDown || this._stoppingCapture) {
                            console.log(`[ListenService] capture exited during ${this._shuttingDown ? 'shutdown' : 'intentional stop'} — not restarting`);
                            this._stoppingCapture = false;
                            this.sendToRenderer('update-status', this._shuttingDown ? 'Shutting down' : 'Stopped');
                            this.sendToRenderer('session-state-changed', { isActive: false });
                            this.sendToRenderer('change-listen-capture-state', { status: 'stop' });
                            return;
                        }

                        // User clicked Stop. closeSession() killed the child;
                        // the resulting exit must NOT auto-restart and resurrect
                        // the session under the user's feet.
                        if (this._userStopRequested) {
                            console.log('[ListenService] capture exited after user stop; not restarting');
                            return;
                        }

                        // Exit code 64 = source app (Zoom/Meet/Teams) quit. The
                        // user's meeting is over, so don't auto-restart against
                        // a closed app — that's exactly the failure mode that
                        // pegged main at 88% CPU overnight. End the session.
                        if (code === 64) {
                            console.log('[ListenService] source app quit — ending listen session');
                            this.sendToRenderer('update-status', 'Meeting ended — listen stopped');
                            this.sendToRenderer('session-state-changed', { isActive: false });
                            this.sendToRenderer('change-listen-capture-state', { status: 'stop' });
                            this.closeSession().catch((e) => console.warn('[ListenService] auto-close failed:', e.message));
                            return;
                        }

                        // Device-route change exit (exit code 75 from the Swift
                        // helper). User plugged in AirPods or switched output
                        // device; respawn immediately and don't consume the
                        // crash-loop budget.
                        if (code === 75) {
                            console.log('[ListenService] capture exited for device-route change — restarting immediately');
                            this.sendToRenderer('update-status', 'Audio device changed, reattaching…');
                            setImmediate(() => {
                                if (this.active || this._userStopRequested) return;
                                this.start().then(() => {
                                    // Non-click restart bypasses
                                    // changeSessionResult, so sync the UI
                                    // canonically.
                                    this.broadcastCanonicalState();
                                }).catch((e) => {
                                    console.warn('[ListenService] route-change restart failed:', e.message);
                                    this.sendToRenderer('update-status', `restart failed: ${e.message}`);
                                });
                            });
                            return;
                        }

                        const MAX = 3;
                        const WINDOW_MS = 60_000;
                        const now = Date.now();
                        this._restartAttempts = this._restartAttempts.filter((t) => now - t < WINDOW_MS);
                        this._restartAttempts.push(now);

                        if (this._restartAttempts.length > MAX) {
                            this._restartGiveUp = true;
                            console.warn(`[ListenService] capture exited code=${code}, ${this._restartAttempts.length} restarts in ${WINDOW_MS}ms — giving up`);
                            this.sendToRenderer('update-status', `capture keeps dying (code ${code}); stopped retrying. Click Listen to try again.`);
                            this.sendToRenderer('session-state-changed', { isActive: false });
                            this.sendToRenderer('change-listen-capture-state', { status: 'stop' });
                            this.broadcastCanonicalState();
                            return;
                        }

                        // Backoff: 1.5s, 5s, 15s.
                        const delays = [1500, 5000, 15000];
                        const delay = delays[Math.min(this._restartAttempts.length - 1, delays.length - 1)];
                        console.warn(`[ListenService] capture exited code=${code} — restart #${this._restartAttempts.length} in ${delay}ms`);
                        this.sendToRenderer('update-status', `capture exited (${code}) — restarting in ${(delay / 1000).toFixed(1)}s`);
                        setTimeout(() => {
                            if (this.active) return;       // user already restarted
                            if (this._restartGiveUp) return;
                            if (this._userStopRequested) return;
                            this.start().then(() => {
                                this.broadcastCanonicalState();
                            }).catch((e) => {
                                console.warn('[ListenService] auto-restart failed:', e.message);
                                this.sendToRenderer('update-status', `restart failed: ${e.message}`);
                                this.sendToRenderer('session-state-changed', { isActive: false });
                            });
                        }, delay);
                    }
                },
            });
            this.sendToRenderer('update-status', 'Connected');
            this.sessionStartedAt = Date.now();
            this._lastTranscriptAt = Date.now();
            this._audioIdlePromptShown = false;
            this._scheduleIdlePrompt();
            this._scheduleAudioIdleCheck();
            this._startLiveSummary();

            // Spam-protection: a closeSession() call that fired WHILE this
            // start() was awaiting DB / stt boot set _userStopRequested=true
            // and ran its teardown against a still-null this.active. Without
            // this check the freshly-spun STT would be orphaned — running,
            // appending to a jsonl with no DB row linkage, immune to Stop.
            if (this._userStopRequested) {
                console.warn('[ListenService] start() saw _userStopRequested set mid-init; tearing down');
                try { this.active?.stop?.(); } catch (_) {}
                this.active = null;
                this.sessionStartedAt = null;
                this._cancelIdlePrompt();
                this._cancelAudioIdleCheck();
                this._stopLiveSummary();
                this._liveSummary = null;
                if (this.currentSessionId) {
                    try { sessionRepository.end(this.currentSessionId); } catch (_) {}
                    this.currentSessionId = null;
                }
                try {
                    const { updateActiveListenSessionId } = require('../fire/instance');
                    updateActiveListenSessionId(null);
                } catch (_) {}
            }
        } finally {
            this.isInitializing = false;
            this.sendToRenderer('change-listen-capture-state', { status: 'start' });
            // Single source of truth for the header button. The renderer
            // dropped the cycle-based state machine, so broadcasting
            // canonical state here is now safe and required.
            this.broadcastCanonicalState();
        }
    }

    isSessionActive() {
        return !!this.active;
    }

    // Canonical state for UI reconcile (e.g. after a lid-close suspend dropped
    // the listen:changeSessionResult IPC and left the header stuck on the
    // "stopping…" ellipsis).
    getCurrentState() {
        return {
            isActive: !!this.active,
            isInitializing: !!this.isInitializing,
        };
    }

    // Start the live re-summary timer for the current session. Re-summarizes
    // the transcript-so-far every CLAUDELY_LIVE_SUMMARY_MS (default 2 min) and
    // updates ONE Google Doc in place. Disabled when the period is <= 0 or
    // summaries are off. Preserves the Doc id across auto-restarts within the
    // same DB session so a reconnect doesn't spawn a second Doc.
    _startLiveSummary() {
        const periodMs = process.env.CLAUDELY_LIVE_SUMMARY_MS != null
            ? Number(process.env.CLAUDELY_LIVE_SUMMARY_MS)
            : 120_000;
        if (!Number.isFinite(periodMs) || periodMs <= 0) return;
        if (process.env.CLAUDELY_DISABLE_SUMMARY === '1') return;

        const sameSession = this._liveSummary && this._liveSummary.sessionId === this.currentSessionId;
        if (!sameSession) {
            this._liveSummary = { timer: null, running: false, docId: null, lastSize: 0, sessionId: this.currentSessionId };
        }
        if (this._liveSummary.timer) return; // already ticking
        this._liveSummary.timer = setInterval(() => {
            this._runLiveSummary().catch((e) => console.warn('[ListenService] live summary tick error:', e.message));
        }, periodMs);
        console.log(`[ListenService] live summary timer started (${periodMs}ms)`);
    }

    _stopLiveSummary() {
        if (this._liveSummary?.timer) {
            clearInterval(this._liveSummary.timer);
            this._liveSummary.timer = null;
            console.log('[ListenService] live summary timer cleared');
        }
    }

    // One live-summary cycle. Cheap-guards first (no active session, run in
    // flight, transcript too short, nothing new since last run), then
    // summarizes the partial transcript and creates/updates the session's Doc.
    async _runLiveSummary() {
        const ls = this._liveSummary;
        if (!ls || ls.running || !this.active) return;
        const fs = require('fs');
        const path = require('path');
        const os = require('os');
        const src = this.active?.store?.getPersistPath?.();
        if (!src || !fs.existsSync(src)) return;

        let size = 0;
        try { size = fs.statSync(src).size; } catch (_) { return; }
        const MIN_BYTES = Number(process.env.CLAUDELY_LIVE_SUMMARY_MIN_BYTES) || 800;
        if (size < MIN_BYTES) return;       // too little said yet — summary would be junk
        if (size === ls.lastSize) return;   // nothing new since last cycle — skip the spend

        ls.running = true;
        try {
            const stageDir = path.join(os.homedir(), 'Library/Application Support/Claudely/summaries');
            fs.mkdirSync(stageDir, { recursive: true });
            const baseName = path.basename(src).replace(/\.jsonl$/, '');
            const summaryPath = path.join(stageDir, `${baseName}.summary.md`);
            // Live cycles summarize transcript-only with a light meta sidecar;
            // the final summary at Stop rebuilds meta with calendar/Q&A/shots.
            const metaPath = path.join(stageDir, `${baseName}.meta.json`);
            if (!fs.existsSync(metaPath)) {
                fs.writeFileSync(metaPath, JSON.stringify({
                    schema: 2,
                    transcript_file: path.basename(src),
                    live: true,
                }, null, 2));
            }

            const { Summarizer } = require('../summary/summarizer');
            const t0 = Date.now();
            const res = await new Summarizer().summarize({ transcriptPath: src, metaPath, outPath: summaryPath });
            console.log(`[ListenService] live summary ${res.bytes}B in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

            const { uploadSummary } = require('../summary/driveUploader');
            const cfg = require('../common/config/config');
            const hadDoc = !!ls.docId;
            const result = await uploadSummary({
                markdownPath: summaryPath,
                fallbackTitle: baseName,
                webhookUrl: cfg.get('summaryWebhookUrl'),
                secret: cfg.get('summarySecret'),
                docId: ls.docId,
            });
            if (result.skipped) {
                console.log(`[ListenService] live summary upload skipped: ${result.reason}`);
            } else {
                if (result.id) ls.docId = result.id;
                console.log(`[ListenService] live summary ${hadDoc ? 'updated' : 'created'} → ${result.url}`);
            }
            ls.lastSize = size;
        } catch (e) {
            console.warn('[ListenService] live summary cycle failed:', e.message);
        } finally {
            ls.running = false;
        }
    }

    async closeSession({ waitForSummary = false, shutdown = false } = {}) {
        if (shutdown) this._shuttingDown = true;
        // Idempotent: if there's nothing to clean up, skip cleanly so a
        // double-Stop click is a no-op. We DO proceed when isInitializing is
        // true even with no active yet — that's the mid-init race the
        // tail-end check in start() relies on (_userStopRequested must be
        // visible by the time start() returns).
        if (!this.active && !this.currentSessionId && !this.idleTimer && !this._audioIdleTimer && !this.isInitializing) {
            if (waitForSummary) await this.waitForPendingSummaries();
            return { success: true };
        }
        this._cancelIdlePrompt();
        this._cancelAudioIdleCheck();
        // Stop the live re-summary timer; the final summary below reuses the
        // Doc it created so the meeting stays a single, finalized Doc.
        this._stopLiveSummary();
        // Block the capture-exit handler from auto-restarting the session we're
        // tearing down. Cleared by the next explicit start().
        this._userStopRequested = true;
        const recordedFrom = this.sessionStartedAt ? new Date(this.sessionStartedAt) : null;
        const recordedTo = new Date();
        this.sessionStartedAt = null;
        this.sendToRenderer('change-listen-capture-state', { status: 'stop' });
        const finishedStore = this.active?.store || null;
        const hadActiveCapture = !!this.active;
        if (hadActiveCapture) this._stoppingCapture = true;
        try {
            this.active?.stop();
        } catch (e) {
            console.warn('[ListenService] stop error:', e.message);
        }
        this.active = null;
        if (hadActiveCapture) {
            setTimeout(() => {
                if (!this._shuttingDown) this._stoppingCapture = false;
            }, 2_000);
        }
        // Canonical broadcast — renderer is now race-free without the
        // legacy cycle, so always sync. Critical for non-click paths like
        // the idle-prompt-pause action where the header has no other way
        // to learn that the backend just stopped.
        this.broadcastCanonicalState();

        // End the DB row + clear bookkeeping NOW so the UI's Stop click
        // resolves instantly. The Stop button used to "load" for several
        // seconds because everything below (transcript copy, calendar lookup,
        // screenshot scan, meta sidecar write, summary fire) blocked the
        // returned Promise. Capture the session id before clearing so the
        // background sidecar work still has it.
        const sessionIdAtClose = this.currentSessionId;
        if (this.currentSessionId) {
            try { sessionRepository.end(this.currentSessionId); } catch (_) {}
            this.currentSessionId = null;
        }
        try {
            const { updateActiveListenSessionId } = require('../fire/instance');
            updateActiveListenSessionId(null);
        } catch (_) {}

        // Fire-and-forget the sidecar pipeline. Errors surface in console
        // only; the user-facing stop is already done. Shutdown is the one
        // caller that awaits: Codex CLI summaries take long enough that
        // app.exit() would otherwise kill them mid-write.
        // Hand the live Doc id to the final summary so it updates the same
        // Doc instead of spawning a duplicate, then clear live state.
        const liveDocId = this._liveSummary?.docId || null;
        this._liveSummary = null;
        const sidecarDone = this._finishSessionAsync({
            finishedStore,
            recordedFrom,
            recordedTo,
            sessionIdAtClose,
            liveDocId,
        });

        if (waitForSummary) {
            await sidecarDone;
            await this.waitForPendingSummaries();
        }

        return { success: true };
    }

    // Background tail of closeSession(): transcript copy → calendar lookup →
    // screenshot scan → meta sidecar write → Claude summary → Drive upload.
    // Each step is best-effort and logs to console on failure. Runs detached
    // from the IPC reply so the Stop button never spins.
    //
    // Spam guard: if the user just stop/start-cycled (or hit Stop before any
    // audio came in), we skip the entire pipeline. Otherwise spamming Stop
    // would fire one `claude` CLI subprocess per cycle to summarise a
    // ~0-second session, burning CC subscription budget on empty .jsonls and
    // dumping junk .summary.md files into the sync folder. Threshold is
    // intentionally generous so a quick "pause-to-check-something-then-resume"
    // also gets silently dropped.
    _finishSessionAsync({ finishedStore, recordedFrom, recordedTo, sessionIdAtClose, liveDocId = null }) {
        const MIN_SESSION_MS = Number(process.env.CLAUDELY_MIN_SIDECAR_MS) || 30_000;
        const durationMs = recordedFrom ? (recordedTo - recordedFrom) : 0;
        if (!recordedFrom || durationMs < MIN_SESSION_MS) {
            console.log(`[ListenService] skipping sidecar — session too short (${durationMs}ms < ${MIN_SESSION_MS}ms threshold)`);
            return;
        }
        return (async () => {
            try {
            const path = require('path');
            const fs = require('fs');
            const os = require('os');
            const config = require('../common/config/config');
            const mirrorDst = config.get('transcriptUploadDir');
            const src = finishedStore?.getPersistPath?.();
            // Build artifacts in a LOCAL stage dir, never directly in the Drive
            // mount. transcriptUploadDir is a Google Drive File Stream path that
            // periodically throws EPERM while its daemon restarts; writing there
            // as the first step let a transient hiccup swallow the whole pipeline
            // (no transcript, no summary, no Doc). Stage local → upload Doc over
            // HTTP → mirror into Drive best-effort.
            const stageDir = path.join(os.homedir(), 'Library/Application Support/Claudely/summaries');
            if (src && fs.existsSync(src)) {
                fs.mkdirSync(stageDir, { recursive: true });
                const targetTranscript = src; // summarize from the local original; no pre-copy into the flaky mount
                console.log(`[ListenService] staging sidecar → ${stageDir} (src ${path.basename(src)})`);

                const baseName = path.basename(src).replace(/\.jsonl$/, '');

                // Build sidecar with calendar events that overlapped the window.
                let events = [];
                if (recordedFrom) {
                    try {
                        const cal = require('../calendar/calendarContext');
                        events = await cal.fetchEventsForWindow(recordedFrom, recordedTo);
                    } catch (e) {
                        console.warn('[ListenService] calendar lookup for sidecar failed:', e.message);
                    }
                }

                // Q&A history that happened during the recording. Manual asks
                // and auto-fires both write to ai_messages keyed by sent_at.
                let qa = [];
                if (recordedFrom) {
                    try {
                        const askRepo = require('./../ask/repositories');
                        const fromSec = Math.floor(recordedFrom.getTime() / 1000);
                        // +60s slop catches replies that streamed past stop click.
                        const toSec = Math.floor((recordedTo.getTime() + 60_000) / 1000);
                        qa = askRepo.getAiMessagesBetween(fromSec, toSec).map((m) => ({
                            ts: m.sent_at ? new Date(m.sent_at * 1000).toISOString() : null,
                            role: m.role,
                            content: m.content,
                            model: m.model || null,
                            session_id: m.session_id,
                        }));
                    } catch (e) {
                        console.warn('[ListenService] Q&A lookup for sidecar failed:', e.message);
                    }
                }

                // Screenshots taken during fires live in os.tmpdir()/claudely/
                // as screen-<ms>.png. Copy any whose mtime falls in the window
                // into <base>.screenshots/ next to the transcript.
                const screenshotsCopied = [];
                if (recordedFrom) {
                    try {
                        const tmpDir = path.join(os.tmpdir(), 'claudely');
                        if (fs.existsSync(tmpDir)) {
                            const fromMs = recordedFrom.getTime();
                            const toMs = recordedTo.getTime() + 60_000; // slop for trailing fires
                            const shotsDir = path.join(stageDir, `${baseName}.screenshots`);
                            for (const name of fs.readdirSync(tmpDir)) {
                                if (!/^screen-\d+\.png$/.test(name)) continue;
                                const full = path.join(tmpDir, name);
                                let stat;
                                try { stat = fs.statSync(full); } catch (_) { continue; }
                                const t = stat.mtimeMs;
                                if (t < fromMs || t > toMs) continue;
                                if (!screenshotsCopied.length) fs.mkdirSync(shotsDir, { recursive: true });
                                const target = path.join(shotsDir, name);
                                try {
                                    fs.copyFileSync(full, target);
                                    screenshotsCopied.push({
                                        file: path.relative(stageDir, target),
                                        captured_at: new Date(t).toISOString(),
                                        bytes: stat.size,
                                    });
                                } catch (e) {
                                    console.warn('[ListenService] screenshot copy skip:', name, e.message);
                                }
                            }
                        }
                    } catch (e) {
                        console.warn('[ListenService] screenshot scan failed:', e.message);
                    }
                }

                const meta = {
                    schema: 2,
                    transcript_file: path.basename(src),
                    recorded_from: recordedFrom ? recordedFrom.toISOString() : null,
                    recorded_to: recordedTo.toISOString(),
                    duration_ms: recordedFrom ? (recordedTo - recordedFrom) : null,
                    session_id: sessionIdAtClose || null,
                    code_context: (() => {
                        try {
                            return require('../context/contextService').getActiveContext();
                        } catch (_) {
                            return null;
                        }
                    })(),
                    context_switches: (() => {
                        try {
                            return recordedFrom
                                ? require('../context/contextService').getSwitchesBetween(recordedFrom, recordedTo)
                                : [];
                        } catch (_) {
                            return [];
                        }
                    })(),
                    events: events.map((e) => ({
                        title: e.title,
                        start: e.start,
                        end: e.end,
                        is_active_at_close: e.isActive,
                        location: e.location || '',
                        url: e.url || '',
                        uid: e.uid || '',
                        notes: e.notes || '',
                        calendar: e.calendar || '',
                        // Best-effort Google Calendar deep link from the event UID.
                        google_calendar_link: buildGoogleCalLinkFromIcsUid(e.uid),
                    })),
                    qa,
                    screenshots: screenshotsCopied,
                };
                const metaPath = path.join(stageDir, `${baseName}.meta.json`);
                fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
                console.log(`[ListenService] meta sidecar → ${metaPath} (${events.length} event(s), ${qa.length} qa msg, ${screenshotsCopied.length} shot(s))`);

                // Assistant-generated summary. Normal Stop keeps this in the
                // background so UI control returns immediately, but shutdown
                // waits on tracked jobs because Codex CLI summaries often take
                // long enough that app.exit() would otherwise kill them.
                // Disable with CLAUDELY_DISABLE_SUMMARY=1 for tests / debugging.
                if (process.env.CLAUDELY_DISABLE_SUMMARY !== '1') {
                    const summaryPath = path.join(stageDir, `${baseName}.summary.md`);
                    const summaryJob = this._trackSummaryJob((async () => {
                        let summaryOk = false;
                        try {
                            const { Summarizer } = require('../summary/summarizer');
                            const summarizer = new Summarizer();
                            console.log(`[ListenService] summarizing → ${summaryPath}`);
                            const t0 = Date.now();
                            const res = await summarizer.summarize({
                                transcriptPath: targetTranscript,
                                metaPath,
                                outPath: summaryPath,
                            });
                            summaryOk = true;
                            console.log(`[ListenService] summary written ${res.bytes}B in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
                        } catch (e) {
                            console.warn('[ListenService] summary failed:', e.message);
                        }
                        // Upload the Doc FIRST — plain HTTP, independent of the
                        // Drive mount, so it lands even while File Stream flaps.
                        if (summaryOk) {
                            try {
                                const { uploadSummary } = require('../summary/driveUploader');
                                const cfg = require('../common/config/config');
                                const result = await uploadSummary({
                                    markdownPath: summaryPath,
                                    fallbackTitle: baseName,
                                    webhookUrl: cfg.get('summaryWebhookUrl'),
                                    secret: cfg.get('summarySecret'),
                                    docId: liveDocId, // update the live Doc in place, if any
                                });
                                if (result.skipped) {
                                    console.log(`[ListenService] summary upload skipped: ${result.reason}`);
                                } else {
                                    console.log(`[ListenService] summary uploaded → ${result.url}`);
                                }
                            } catch (e) {
                                console.warn('[ListenService] summary upload failed:', e.message);
                            }
                        }
                        // Mirror artifacts into the synced Drive folder,
                        // best-effort with retry. Doc already shipped over HTTP;
                        // originals stay in stageDir if the mount is down.
                        await this._mirrorToDrive({
                            mirrorDst, stageDir, src, metaPath,
                            summaryPath: summaryOk ? summaryPath : null,
                            screenshotsCopied,
                        });
                    })(), `summary ${baseName}`);
                    void summaryJob; // tracked in _summaryJobs; shutdown awaits via waitForPendingSummaries
                } else {
                    // Summary disabled — still mirror transcript + meta to Drive.
                    await this._mirrorToDrive({ mirrorDst, stageDir, src, metaPath, summaryPath: null, screenshotsCopied });
                }
            }
            } catch (e) {
                console.warn('[ListenService] sidecar pipeline failed:', e.message);
            }
        })();
    }

    // Copy session artifacts from the local stage dir into the synced Google
    // Drive folder. The mount (Google Drive File Stream) intermittently throws
    // EPERM while its daemon restarts, so each file gets a few retries with
    // backoff. Best-effort and never throws: the Google Doc is the real
    // deliverable and ships over HTTP regardless; these are audit copies.
    async _mirrorToDrive({ mirrorDst, stageDir, src, metaPath, summaryPath, screenshotsCopied }) {
        if (!mirrorDst) {
            console.log('[ListenService] no transcriptUploadDir configured; skipping Drive mirror');
            return;
        }
        const path = require('path');
        const fs = require('fs');
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

        const items = [[src, path.basename(src)], [metaPath, path.basename(metaPath)]];
        if (summaryPath) items.push([summaryPath, path.basename(summaryPath)]);
        for (const s of (screenshotsCopied || [])) {
            items.push([path.join(stageDir, s.file), s.file]);
        }

        let copied = 0;
        let failed = 0;
        for (const [absSrc, relName] of items) {
            if (!absSrc || !fs.existsSync(absSrc)) continue;
            let ok = false;
            for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
                try {
                    const dest = path.join(mirrorDst, relName);
                    fs.mkdirSync(path.dirname(dest), { recursive: true });
                    fs.copyFileSync(absSrc, dest);
                    ok = true;
                } catch (e) {
                    if (attempt === 3) {
                        failed++;
                        console.warn(`[ListenService] Drive mirror failed (${relName}) after 3 tries: ${e.message} — Doc already uploaded; original kept in ${stageDir}`);
                    } else {
                        await sleep(attempt * 2_000);
                    }
                }
            }
            if (ok) copied++;
        }
        console.log(`[ListenService] Drive mirror → ${mirrorDst}: ${copied} copied, ${failed} failed`);
    }

    // Back-compat no-ops for old featureBridge channels that still get wired:
    async handleSendMicAudioContent() { return { success: false, error: 'Mic audio now captured by Swift helper.' }; }
    async handleStartMacosAudio() { return { success: false, error: 'macOS audio now captured by Swift helper.' }; }
    async handleStopMacosAudio() { return { success: true }; }
    get sttService() { return { sendSystemAudioContent: async () => ({ success: false }) }; }
}

const listenService = new ListenService();
module.exports = listenService;
module.exports.ListenService = ListenService;
module.exports.SUMMARY_SHUTDOWN_WAIT_MS = SUMMARY_SHUTDOWN_WAIT_MS;
