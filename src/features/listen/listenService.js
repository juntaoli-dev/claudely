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
        console.log('[ListenService] Service instance created.');
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
        this.sendToRenderer('update-status', 'Starting capture…');

        try {
            // DB session for transcript persistence link
            try {
                this.currentSessionId = await sessionRepository.getOrCreateActive('listen');
            } catch (e) {
                console.warn('[ListenService] Could not open DB session:', e.message);
                this.currentSessionId = null;
            }

            this.active = stt.start({
                onFinal: (line) => {
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
                onInterim: (line) => this._pushStt(line, false),
                onState: (s) => {
                    if (s.type === 'listening') this.sendToRenderer('update-status', 'Listening…');
                    else if (s.type === 'error') this.sendToRenderer('update-status', `ERR: ${s.error}`);
                    else if (s.type === 'stderr') console.warn('[ListenService][stderr]', s.text.trim());
                    else if (s.type === 'capture-exit') console.warn('[ListenService] capture exited', s.code);
                },
            });
            this.sendToRenderer('update-status', 'Connected');
            this.sessionStartedAt = Date.now();
            this._scheduleIdlePrompt();
        } finally {
            this.isInitializing = false;
            this.sendToRenderer('change-listen-capture-state', { status: 'start' });
        }
    }

    isSessionActive() {
        return !!this.active;
    }

    async closeSession() {
        this._cancelIdlePrompt();
        const recordedFrom = this.sessionStartedAt ? new Date(this.sessionStartedAt) : null;
        const recordedTo = new Date();
        this.sessionStartedAt = null;
        this.sendToRenderer('change-listen-capture-state', { status: 'stop' });
        const finishedStore = this.active?.store || null;
        try {
            this.active?.stop();
        } catch (e) {
            console.warn('[ListenService] stop error:', e.message);
        }
        this.active = null;

        // Copy this session's transcript .jsonl + a meta sidecar (calendar
        // event(s) that overlapped the recording) + Q&A history + screenshots
        // into the sync folder so each upload carries full meeting context.
        try {
            const path = require('path');
            const fs = require('fs');
            const os = require('os');
            const config = require('../common/config/config');
            const dst = config.get('transcriptUploadDir');
            const src = finishedStore?.getPersistPath?.();
            if (dst && src && fs.existsSync(src)) {
                fs.mkdirSync(dst, { recursive: true });
                const targetTranscript = path.join(dst, path.basename(src));
                fs.copyFileSync(src, targetTranscript);
                console.log(`[ListenService] transcript copied → ${targetTranscript}`);

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
                            const shotsDir = path.join(dst, `${baseName}.screenshots`);
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
                                        file: path.relative(dst, target),
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
                    session_id: this.currentSessionId || null,
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
                const metaPath = path.join(dst, `${baseName}.meta.json`);
                fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
                console.log(`[ListenService] meta sidecar → ${metaPath} (${events.length} event(s), ${qa.length} qa msg, ${screenshotsCopied.length} shot(s))`);

                // Fire-and-forget Claude-generated summary. Runs in the
                // background so closeSession() returns immediately; the .md
                // lands next to the transcript when ready (typically 15-60s),
                // and if Drive webhook is configured, also gets uploaded as a
                // real Google Doc into the Meeting Summary folder.
                // Disable with CLAUDELY_DISABLE_SUMMARY=1 for tests / debugging.
                if (process.env.CLAUDELY_DISABLE_SUMMARY !== '1') {
                    const summaryPath = path.join(dst, `${baseName}.summary.md`);
                    (async () => {
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
                            console.log(`[ListenService] summary written ${res.bytes}B in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
                        } catch (e) {
                            console.warn('[ListenService] summary failed:', e.message);
                            return;
                        }
                        try {
                            const { uploadSummary } = require('../summary/driveUploader');
                            const cfg = require('../common/config/config');
                            const result = await uploadSummary({
                                markdownPath: summaryPath,
                                fallbackTitle: baseName,
                                webhookUrl: cfg.get('summaryWebhookUrl'),
                                secret: cfg.get('summarySecret'),
                            });
                            if (result.skipped) {
                                console.log(`[ListenService] summary upload skipped: ${result.reason}`);
                            } else {
                                console.log(`[ListenService] summary uploaded → ${result.url}`);
                            }
                        } catch (e) {
                            console.warn('[ListenService] summary upload failed:', e.message);
                        }
                    })();
                }
            }
        } catch (e) {
            console.warn('[ListenService] transcript copy failed:', e.message);
        }

        if (this.currentSessionId) {
            try { await sessionRepository.end(this.currentSessionId); } catch (_) {}
            this.currentSessionId = null;
        }
        return { success: true };
    }

    // Back-compat no-ops for old featureBridge channels that still get wired:
    async handleSendMicAudioContent() { return { success: false, error: 'Mic audio now captured by Swift helper.' }; }
    async handleStartMacosAudio() { return { success: false, error: 'macOS audio now captured by Swift helper.' }; }
    async handleStopMacosAudio() { return { success: true }; }
    get sttService() { return { sendSystemAudioContent: async () => ({ success: false }) }; }
}

const listenService = new ListenService();
module.exports = listenService;
