// src/features/listen/stt/sttService.js
//
// New Claudely STT pipeline: spawn audio-capture Swift helper via AudioBus,
// interleave its two PCM tracks into stereo Deepgram multichannel stream,
// surface diarized transcripts through onFinal / onInterim callbacks, and
// persist finals to a ring-buffered on-disk jsonl.

const path = require('path');
const os = require('os');
const { AudioBus } = require('../../audio/audioBus');
const { TranscriptStore } = require('../transcriptStore');

function start({ onFinal, onInterim, onState } = {}) {
    const key = process.env.DEEPGRAM_API_KEY;
    if (!key) throw new Error('DEEPGRAM_API_KEY missing');

    const persistPath = path.join(
        os.homedir(),
        'Library/Application Support/Claudely/transcripts',
        `${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`
    );
    const store = new TranscriptStore({ maxMinutes: 60, persistPath });

    const binaryPath = path.join(__dirname, '../../../ui/assets/bin/audio-capture');
    const bus = new AudioBus({ binaryPath });

    let live = null;
    let liveReady = false;
    let liveClosed = false;

    // Lazy import of @deepgram/sdk (it's ESM in newer versions; dynamic import works either way).
    (async () => {
        let createClient, LiveTranscriptionEvents;
        try {
            const mod = await import('@deepgram/sdk');
            createClient = mod.createClient;
            LiveTranscriptionEvents = mod.LiveTranscriptionEvents;
        } catch (e) {
            // fallback to require for CJS build
            const mod = require('@deepgram/sdk');
            createClient = mod.createClient;
            LiveTranscriptionEvents = mod.LiveTranscriptionEvents;
        }

        const deepgram = createClient(key);
        live = deepgram.listen.live({
            model: 'nova-3',
            diarize: true,
            multichannel: true,
            encoding: 'linear16',
            sample_rate: 16000,
            channels: 2,
            interim_results: true,
            smart_format: true,
        });

        live.on(LiveTranscriptionEvents.Open, () => {
            liveReady = true;
            onState?.({ type: 'listening' });
        });

        live.on(LiveTranscriptionEvents.Transcript, (payload) => {
            const alt = payload.channel?.alternatives?.[0];
            if (!alt?.transcript) return;
            const channel = payload.channel_index?.[0] ?? 0;
            const speaker = channel === 1
                ? 'me'
                : (alt.words?.[0]?.speaker !== undefined ? `them-${alt.words[0].speaker}` : 'them');
            const line = { text: alt.transcript, speaker, ts: Date.now() };
            if (payload.is_final) {
                store.append(line);
                onFinal?.(line);
            } else {
                onInterim?.(line);
            }
        });

        live.on(LiveTranscriptionEvents.Error, (e) => onState?.({ type: 'error', error: String(e?.message || e) }));
        live.on(LiveTranscriptionEvents.Close, () => { liveClosed = true; onState?.({ type: 'closed' }); });
    })().catch((e) => onState?.({ type: 'error', error: 'deepgram-init: ' + e.message }));

    // Interleave track-0 (them) and track-1 (me) into stereo PCM for Deepgram multichannel.
    const pending = { 0: Buffer.alloc(0), 1: Buffer.alloc(0) };
    bus.on('pcm', ({ track, pcm }) => {
        if (track !== 0 && track !== 1) return;
        pending[track] = Buffer.concat([pending[track], pcm]);
        const samples = Math.min(pending[0].length, pending[1].length) / 2;
        if (samples === 0) return;
        const bytes = samples * 2;
        const a = pending[0].subarray(0, bytes);
        const b = pending[1].subarray(0, bytes);
        pending[0] = pending[0].subarray(bytes);
        pending[1] = pending[1].subarray(bytes);
        const interleaved = Buffer.alloc(bytes * 2);
        for (let i = 0; i < samples; i++) {
            interleaved.writeInt16LE(a.readInt16LE(i * 2), i * 4);
            interleaved.writeInt16LE(b.readInt16LE(i * 2), i * 4 + 2);
        }
        if (liveReady && !liveClosed) {
            try { live.send(interleaved); } catch (e) { onState?.({ type: 'error', error: 'send: ' + e.message }); }
        }
    });
    bus.on('stderr', (s) => onState?.({ type: 'stderr', text: s }));
    bus.on('exit', (code) => onState?.({ type: 'capture-exit', code }));
    bus.start();

    return {
        store,
        stop() {
            try { bus.stop(); } catch (_) {}
            try { live?.finish?.(); } catch (_) {}
            try { store.close(); } catch (_) {}
        },
    };
}

module.exports = { start };

// Legacy class export kept for any stale listenService code path; throws if used.
class SttService {
    constructor() {
        console.warn('[SttService] legacy class instantiated; use start() instead.');
    }
    setCallbacks() {}
    initializeSttSessions() { throw new Error('Use sttService.start({onFinal,onInterim,onState})'); }
    closeSessions() { return Promise.resolve(); }
    isSessionActive() { return false; }
    isMacOSAudioRunning() { return false; }
    startMacOSAudioCapture() { throw new Error('not supported'); }
    stopMacOSAudioCapture() {}
    sendMicAudioContent() {}
    sendSystemAudioContent() { return { success: false }; }
}
module.exports.SttService = SttService;
