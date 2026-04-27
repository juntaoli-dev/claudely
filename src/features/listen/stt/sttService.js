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
const { ClassifierBus } = require('../../classify/classifierBus');
const { matchWake } = require('../../classify/wakePhrase');
const { buildDispatcher, setActiveListenContext, clearActiveListenContext } = require('../../fire/instance');
const config = require('../../common/config/config');

function start({ onFinal, onInterim, onState } = {}) {
    const key = process.env.DEEPGRAM_API_KEY || config.get('deepgramApiKey');
    if (!key) throw new Error('DEEPGRAM_API_KEY missing — set env var or deepgramApiKey in ~/.claudely/config.json');

    const persistPath = path.join(
        os.homedir(),
        'Library/Application Support/Claudely/transcripts',
        `${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`
    );
    const store = new TranscriptStore({ maxMinutes: 60, persistPath });

    // In a packaged app the path lands inside app.asar (not executable). The
    // binary is copied to app.asar.unpacked via electron-builder asarUnpack —
    // remap it here so spawn() sees the unpacked Mach-O.
    const binaryPath = path.join(__dirname, '../../../ui/assets/bin/audio-capture')
        .replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
    const bundleId = process.env.CLAUDELY_ZOOM_BUNDLE_ID || config.get('zoomBundleId') || 'us.zoom.xos';
    const bus = new AudioBus({ binaryPath, bundleId });

    // Classifier + FireDispatcher are constructed here so a single listen session
    // owns the full pipeline. Phase 5 replaces the FireDispatcher stub with the
    // real queue + wake-phrase + auto-answer gated dispatcher.
    const classifierPath = path.join(__dirname, '../../../ui/assets/bin/classifier')
        .replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
    const classifier = new ClassifierBus({ binaryPath: classifierPath });
    classifier.start();
    // Real dispatcher now: passes store + classifier + real Claude + real
    // screen grabber. onState surfaces delta/done/error/queued up to the
    // renderer via the same channel STT uses.
    // Register live store + classifier so any manual ask sees the same
    // transcript history.
    setActiveListenContext({ store, classifier });
    const fireDispatcher = buildDispatcher({ store, classifier, onState });

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
        // Mono fallback is the default for now; multichannel adds fragility when
        // the mic track is silent (Electron headless) and Deepgram idle-closes.
        // Phase 6/7 can re-enable multichannel once mic input is reliable.
        const mono = process.env.CLAUDELY_STT_MONO === '1';
        live = deepgram.listen.live({
            model: 'nova-3',
            diarize: true,
            multichannel: !mono,
            encoding: 'linear16',
            sample_rate: 16000,
            channels: mono ? 1 : 2,
            interim_results: true,
            smart_format: true,
        });
        console.log(`[sttService] Deepgram live channels=${mono ? 1 : 2} diarize=true multichannel=${!mono}`);

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

                // Phase 4: every final line gets passed through the dispatcher.
                // Wake-phrase always fires. If auto-answer is on, classifier
                // verdict fires. FireDispatcher stub no-ops until Phase 5.
                Promise.resolve().then(async () => {
                    try {
                        const wake = matchWake(line.text, config.get('wakePhrases'));
                        if (wake) {
                            onState?.({ type: 'fired', reason: 'wake', question: wake });
                            if (typeof fireDispatcher.maybeFire === 'function') {
                                await fireDispatcher.maybeFire(line);
                            }
                            return;
                        }
                        if (!config.get('autoAnswer')) return;
                        const verdict = await classifier.classify(line.text);
                        if (verdict.addressed) {
                            onState?.({ type: 'fired', reason: 'auto', question: verdict.question || line.text });
                            if (typeof fireDispatcher.maybeFire === 'function') {
                                await fireDispatcher.maybeFire(line);
                            }
                        }
                    } catch (e) {
                        onState?.({ type: 'error', error: 'classify: ' + e.message });
                    }
                });
            } else {
                onInterim?.(line);
            }
        });

        live.on(LiveTranscriptionEvents.Error, (e) => onState?.({ type: 'error', error: String(e?.message || e) }));
        live.on(LiveTranscriptionEvents.Close, () => { liveClosed = true; onState?.({ type: 'closed' }); });
    })().catch((e) => onState?.({ type: 'error', error: 'deepgram-init: ' + e.message }));

    // In mono mode: send track-0 straight through. Skip track-1 (mic).
    // In multichannel mode: interleave track-0 and track-1 into stereo PCM.
    const mono = process.env.CLAUDELY_STT_MONO === '1';
    const pending = { 0: Buffer.alloc(0), 1: Buffer.alloc(0) };
    const trackBytes = { 0: 0, 1: 0 };
    bus.on('pcm', ({ track, pcm }) => {
        if (track !== 0 && track !== 1) return;
        trackBytes[track] += pcm.length;

        if (mono) {
            if (track !== 0) return; // drop mic in mono mode
            if (liveReady && !liveClosed) {
                try { live.send(pcm); } catch (e) { onState?.({ type: 'error', error: 'send: ' + e.message }); }
            }
            return;
        }

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

    // Every 2s, emit a track byte-count snapshot so we can diagnose starvation.
    const statsTimer = setInterval(() => {
        onState?.({ type: 'stats', track0: trackBytes[0], track1: trackBytes[1] });
    }, 2000);
    bus.on('stderr', (s) => onState?.({ type: 'stderr', text: s }));
    bus.on('exit', (code) => onState?.({ type: 'capture-exit', code }));
    bus.start();

    return {
        store,
        classifier,
        fireDispatcher,
        stop() {
            try { clearInterval(statsTimer); } catch (_) {}
            try { bus.stop(); } catch (_) {}
            try { classifier.stop(); } catch (_) {}
            try { live?.finish?.(); } catch (_) {}
            try { store.close(); } catch (_) {}
            try { clearActiveListenContext(); } catch (_) {}
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
