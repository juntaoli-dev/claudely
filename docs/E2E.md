# Claudely E2E smoke

## Prereqs
- macOS 15+ with Apple Intelligence enabled (for FoundationModels classifier; otherwise the regex fallback is used).
- Zoom installed and signed in.
- `claude` CLI logged in to the Enterprise account (`claude --version` works; credentials live in Keychain or `~/.claude/.credentials.json`).
- `DEEPGRAM_API_KEY` exported in the shell that runs `npm start`.
- `~/Documents/creative_studio_repo/` exists and contains the Alli sub-repos.
- Screen Recording **and** Microphone TCC permissions granted to the host app
  (in dev: `node_modules/electron/dist/Electron.app`; in a packaged build:
  `Claudely.app`).

## Build
```
npm install
npm run build:native    # swiftc audio-capture + classifier
npm run build:renderer  # esbuild + copies native binaries into src/ui/assets/bin/
```

## Steps
1. `DEEPGRAM_API_KEY=… npm start`
2. Grant Screen Recording + Microphone TCC dialogs the first time. Restart the app after granting.
3. Start a Zoom test meeting, play an audio clip in it asking "does our auth service handle SSO".
4. In Claudely, press `Cmd+Shift+A` to enable auto-answer. Badge goes ON.
5. Expected: transcript line shows `them-0: does our auth service handle SSO`, then Claudely enters THINKING, then streams an answer that references files in `alli-creativestudio-backend`.
6. Press `Cmd+Enter`, type `list the subfolders`. Expected: streamed list of sub-repos.
7. Say aloud "hey claude what is in the frontend repo". Expected: auto-fires regardless of auto-answer state, labelled `me:`.
8. Verify Claudely invisible: share your screen in Zoom to a second device. The Claudely overlay should not appear in the share.
9. Press `Cmd+Shift+M` to panic-mute. All capture stops.

## Headless smoke (no UI clicking, useful in CI / dev)
- `CLAUDELY_DEBUG_AUDIO=us.zoom.xos npm start` — spawns the Swift helper, logs the first 200 PCM frames, exits.
- `CLAUDELY_DEBUG_STT=1 CLAUDELY_DEBUG_STT_MS=20000 DEEPGRAM_API_KEY=… npm start` — runs the full STT pipeline for 20 s and prints diarized finals + interims to stdout.
- `CLAUDELY_DEBUG_ASK="list the subfolders" npm start` — fires `manualFire` through the FireDispatcher (screenshot + transcript tail + ClaudeSession) and exits when done.
- `ANTHROPIC_DRY_RUN=1` — skips the real Claude SDK call; ClaudeSession prints `[DRY-RUN] {...}` and returns.

## Env knobs
| Env | Purpose |
|---|---|
| `DEEPGRAM_API_KEY` | Required for STT. |
| `CLAUDELY_PROJECT_CWD` | Override the Agent SDK `cwd` (default `~/Documents/creative_studio_repo`). |
| `CLAUDELY_MODEL` | Override Claude model (default `claude-sonnet-4-6`). |
| `CLAUDELY_ZOOM_BUNDLE_ID` | SCK app filter (default `us.zoom.xos`). Bogus value forces full-display audio. |
| `CLAUDELY_STT_MONO` | `1` forces mono Deepgram channel; default is multichannel stereo (mic = ch1). |
| `CLAUDELY_DISABLE_CP` | `1` turns off `setContentProtection` so screen-record tools can capture the overlay (dev only). |
| `ANTHROPIC_DRY_RUN` | `1` short-circuits ClaudeSession.ask. |

## Known limitations
- If Apple Intelligence is off, the classifier exits with `ERR: model-unavailable` and ClassifierBus falls back to the regex heuristic. Wake phrase still works either way.
- If Zoom is not the frontmost app when capture starts, SCK falls back to full-display audio (your speakers / headphones output).
- Multichannel diarization in mono mode collapses everything into `them-N`; speak-vs-listen separation requires multichannel + working mic input.
