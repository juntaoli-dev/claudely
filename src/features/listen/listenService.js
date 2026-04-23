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

class ListenService {
    constructor() {
        this.active = null;          // { stop, store } from stt.start
        this.currentSessionId = null;
        this.isInitializing = false;
        console.log('[ListenService] Service instance created.');
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
        } finally {
            this.isInitializing = false;
            this.sendToRenderer('change-listen-capture-state', { status: 'start' });
        }
    }

    isSessionActive() {
        return !!this.active;
    }

    async closeSession() {
        this.sendToRenderer('change-listen-capture-state', { status: 'stop' });
        try {
            this.active?.stop();
        } catch (e) {
            console.warn('[ListenService] stop error:', e.message);
        }
        this.active = null;
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
