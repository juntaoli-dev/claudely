# Claudely

Repo-aware meeting assistant for macOS. Captures Zoom audio + your mic, transcribes both in real time with Deepgram, and answers repo-aware questions via the Claude Agent SDK pinned to a project folder. Cluely-style floating overlay, invisible to screen-share.

Fork of [pickle-com/glass](https://github.com/pickle-com/glass), stripped of Firebase / Gemini / OpenAI / summary code, rebuilt around Claude.

## Stack

| Layer | Choice |
|---|---|
| Shell | Electron 30 (forked from Glass) |
| UI | Lit web components inside Electron renderer |
| Orchestration | TypeScript / Node in Electron main |
| Audio capture | Swift binary, ScreenCaptureKit (system audio) + AVCaptureSession (mic) |
| Transcription | Deepgram streaming (multichannel + diarized) |
| Utterance classifier | Swift binary, Apple FoundationModels (on-device, free) — falls back to a regex heuristic when Apple Intelligence is off |
| LLM | `@anthropic-ai/claude-agent-sdk` running against your local `claude` CLI Enterprise OAuth |
| Hold-to-move | uiohook-napi global key hook (needs Accessibility TCC) |

## Components

```
┌─────────────────────────────────────────────────┐
│  Electron main                                  │
│   ├─ Lit pill overlay (header + listen + ask)   │
│   └─ orchestrator                               │
│       ├─ AudioBus → spawns audio-capture.swift  │
│       ├─ ClassifierBus → spawns classifier.swift│
│       ├─ Deepgram WS (linear16, 16 kHz, ch=2)   │
│       ├─ TranscriptStore (60 min ring + .jsonl) │
│       ├─ FireDispatcher (queue cap 3)           │
│       ├─ ScreenGrabber (Electron desktopCapturer)│
│       └─ ClaudeSession (Agent SDK)              │
└─────────────────────────────────────────────────┘
        │                                │
        ▼                                ▼
 ┌──────────────┐              ┌────────────────────┐
 │ audio-capture│              │ classifier         │
 │ (Swift)      │              │ (Swift)            │
 │ SCK + mic →  │              │ stdin utterance →  │
 │ Int16 frames │              │ JSON addressed?    │
 └──────────────┘              └────────────────────┘
```

## Hotkeys

| Combo | Action |
|---|---|
| `Cmd+\` | Show / hide overlay |
| `Cmd+Enter` | Manual ask (focus input) |
| `Shift+←/→/↑/↓` (hold) | Glide overlay (continuous) |
| `Cmd+Shift+A` | Toggle auto-answer |
| `Cmd+Shift+M` | Panic mute (stops capture) |
| `Cmd+Shift+I` | Toggle invisibility (content protection) |

## Quick start (dev)

```bash
git clone <this-repo> && cd claudely
npm install
cd web && npm install && cd ..
npm run build:native    # swiftc audio-capture + classifier
npm run build:renderer  # esbuild renderer + copy native binaries
DEEPGRAM_API_KEY=... npm start
```

`claude` CLI must be installed and Enterprise-authed (`claude --version` works). Agent SDK inherits that auth automatically.

## Packaged app

```bash
npm run package
codesign --force --deep --sign "Claudely Dev Local" --entitlements entitlements.plist --options runtime dist/mac-arm64/Claudely.app
cp -R dist/mac-arm64/Claudely.app /Applications/
```

Signing with the self-signed "Claudely Dev Local" keychain identity (instead of
ad-hoc `-`) keeps the signature stable across rebuilds, so macOS TCC grants
(mic, screen recording, Automation) persist. The dev-shell Electron is kept
signed the same way by `scripts/sign-dev-electron.sh`, which runs on
`npm install` (postinstall). See `docs/E2E.md` for the full runbook.

## Config

`~/.claudely/config.json`:

```json
{
  "deepgramApiKey": "<your-key>",
  "autoListen": true,
  "autoAnswer": false,
  "wakePhrases": ["hey claude", "hey claudely"],
  "model": "",
  "transcriptUploadDir": "/path/to/Drive-synced/folder"
}
```

`model: ""` defers to whatever your `claude` CLI is configured for (Opus / Sonnet / etc).

## TCC permissions

First launch will prompt for:

- **Microphone** — your voice (channel 1).
- **Screen Recording** — system audio + ScreenGrabber screenshots.
- **Files & Folders** (Documents) — Claude Agent SDK reading repo files.
- **Accessibility** — uiohook for hold-to-move (manual add via System Settings).

## Tests

```bash
npm test           # vitest, 16 unit tests
DEEPGRAM_API_KEY=... CLAUDELY_DEBUG_STT=1 npm start  # 20-second STT smoke
CLAUDELY_DEBUG_ASK="..." npm start                   # manual-ask smoke
ANTHROPIC_DRY_RUN=1 ...                              # short-circuit Claude calls
```

## Docs

- Design: `docs/superpowers/specs/2026-04-22-claudely-design.md`
- Implementation plan: `docs/superpowers/plans/2026-04-22-claudely-impl.md`
- E2E smoke runbook: `docs/E2E.md`
- Original handoff brief: `HANDOFF.md`

## Status

MVP. Fully working: STT pipeline, wake-phrase detection, manual ask, screenshot context, transcript persistence, hold-to-move, invisibility toggle, auto-listen, transcript upload via Drive sync.

License: GPL-3.0 (inherited from Glass).
