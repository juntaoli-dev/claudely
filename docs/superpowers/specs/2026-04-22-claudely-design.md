# Claudely — Design Spec

**Date:** 2026-04-22
**Owner:** juntao.li@pmg.com
**Status:** design approved, pending implementation plan

## Problem

Solution-design meetings on Zoom are slow because nobody recalls what the repo already does. Pulling up code mid-discussion breaks flow. A meeting assistant that hears the call, sees the shared screen, and answers repo-aware questions in real time would make these meetings materially more efficient.

## Goal

Build `Claudely`, a macOS overlay app that:

1. Captures Zoom audio + laptop mic.
2. Transcribes both in real time with speaker diarization.
3. Detects when an utterance is addressed to the assistant and auto-answers using Claude Code's tooling against a pinned project folder.
4. Also supports manual typed questions.
5. Surfaces answers in a Cluely-style floating overlay that is invisible to screen recording.

## Non-Goals

- Post-meeting summarization (out of scope for v1, transcript is saved for later tooling).
- Cross-platform support. macOS only.
- TTS/voice answers. Text-only in overlay.
- Write access to repos during a meeting. Read-only session.
- Automatic joining of Zoom as a bot. User runs the app on their own machine.

## Stack

| Layer | Choice |
|---|---|
| Shell | Electron (fork of `pickle-com/glass`) |
| UI | Next.js + Tailwind, reuses Glass overlay |
| Orchestration | TypeScript in Electron main |
| Audio capture | Swift binary, ScreenCaptureKit per-app + CoreAudio mic |
| Transcription | Deepgram streaming, diarized, multichannel |
| Utterance classifier | Swift binary, Apple FoundationModels (on-device, free) |
| LLM | Claude Agent SDK (TypeScript), Enterprise OAuth from local `claude` CLI |
| Default model | `claude-sonnet-4-6`, opt-in `claude-opus-4-7` |
| Screen capture for vision | Electron `desktopCapturer` |

## Repo

`~/Documents/GitHub/Claudely/`

Fork of Glass, renamed, trimmed of Glass-specific branding and LLM provider code. `claude-agent-sdk` replaces Gemini/OpenAI integration.

## Architecture

Three processes, one user-facing window.

```
┌─────────────────────────────────────────────────┐
│  Electron main (TS)                             │
│   ├─ UI renderer: Next.js pill overlay          │
│   └─ orchestrator:                              │
│       ├─ spawns audio-capture helper (Swift)    │
│       ├─ spawns classifier helper (Swift)       │
│       ├─ Deepgram WS client                     │
│       ├─ Claude Agent SDK session               │
│       └─ ScreenGrabber, TranscriptStore         │
└─────────────────────────────────────────────────┘
        │                                │
        ▼                                ▼
 ┌──────────────┐              ┌────────────────────┐
 │ audio-capture│              │ classifier         │
 │ .swift       │              │ .swift             │
 │ SCK → PCM on │              │ stdin utterance    │
 │ stdout       │              │ stdout {ask:y,q:…} │
 └──────────────┘              └────────────────────┘
```

Electron main is the hub. Swift helpers are dumb pipes, kept in Swift because SCK and FoundationModels are Swift-only APIs. Claude Agent SDK runs in-process in Electron main via its TypeScript binding, session `cwd` pinned to `~/Documents/creative_studio_repo/`, uses Enterprise OAuth from local `claude` CLI (no API key needed, no per-token billing).

## Components

### audio-capture (Swift binary)

- SCK stream, per-app filter = `us.zoom.xos`. Fallback: system-wide display audio if Zoom not running.
- CoreAudio default-input tap for mic, separate track.
- Output: two PCM streams, 16 kHz mono, multiplexed as length-prefixed frames on stdout with a 1-byte track id (0 = them, 1 = me).
- Dependencies: stdlib only. `swift build -c release` produces `bin/audio-capture`.
- Permission failure: emits `ERR: screen-recording-permission` on stderr, Electron catches and opens the System Settings pane.

### classifier (Swift binary)

- Reads newline-delimited JSON from stdin: `{utterance, speaker}`.
- Pipes through `FoundationModels.LanguageModelSession` with a constrained JSON output schema: `{addressed: bool, question: string|null}`.
- System prompt: "Given an utterance from a meeting, decide if it is addressed to a repo-aware AI assistant and needs answering. Extract the question if yes."
- Emits schema JSON on stdout per input.
- Cold start ~200 ms, subsequent ~50 ms.
- Fallback: if FoundationModels unavailable (older macOS or Apple Intelligence off), exits with `ERR: model-unavailable`. Electron falls back to regex heuristic: utterance ending in `?` or starting with what/how/can/does/why/is.

### Electron main (TypeScript)

- `AudioBus`: spawns audio-capture, demuxes tracks, streams to Deepgram WS with `diarize=true, multichannel=true`.
- `TranscriptStore`: rolling 60 min diarized transcript in memory. Flushes to `~/Library/Application Support/Claudely/transcripts/<meeting-ts>.jsonl` on exit.
- `ClassifierBus`: spawns classifier, pushes each Deepgram-final utterance to classifier stdin. On `addressed: true` AND auto-answer ON, fires. Always fires if utterance starts with a wake phrase.
- `ClaudeSession`: single long-lived Claude Agent SDK session. `cwd = ~/Documents/creative_studio_repo/`. Permissions: `Read, Grep, Glob, Bash(fd *), WebFetch`. Explicitly no `Edit/Write` (read-only during meetings).
- `ScreenGrabber`: on fire, captures current screen PNG via Electron `desktopCapturer`.
- `FireDispatcher`: packages `{image, transcript_tail_30s, question}` as a Claude user turn, streams tokens back to the renderer.

### Renderer (Next.js inside Electron)

- Glass's pill overlay, reskinned: "Claudely" wordmark, Anthropic-tone accent.
- Panes: transcript (top), answer stream (middle), input box (bottom).
- State badges: `AUTO-ANSWER ON/OFF`, `LISTENING`, `THINKING`, `ANSWERING`.
- Hotkeys:
  - `Cmd+\` show/hide (from Glass)
  - `Cmd+Enter` manual ask (from Glass)
  - `Cmd+R` clear session (from Glass)
  - `Cmd+Shift+A` toggle auto-answer (new)
  - `Cmd+Shift+M` panic mute, stop all capture (new)
- Screen-share invisibility: `BrowserWindow.setContentProtection(true)`.

### Config

File: `~/.config/claudely/config.json`.

```json
{
  "project_cwd": "~/Documents/creative_studio_repo/",
  "deepgram_api_key": "env:DEEPGRAM_API_KEY",
  "model": "claude-sonnet-4-6",
  "auto_answer_default": false,
  "zoom_bundle_id": "us.zoom.xos",
  "wake_phrases": ["hey claude", "hey claudely"]
}
```

## Data flow

Single fire path (auto-answer ON, someone asks a repo question):

```
Zoom audio → audio-capture.swift → Electron AudioBus
  → Deepgram (diarized, multichannel)
  → TranscriptStore (append) + on-disk jsonl
  → ClassifierBus → classifier.swift (FoundationModels)
  → FireDispatcher (gate: auto_answer ON OR wake matched)
    ├─ ScreenGrabber → screen.png
    ├─ TranscriptStore.tail(30s)
    └─ question
  → ClaudeSession (Agent SDK, cwd=creative_studio_repo)
      Claude runs Grep, Read, WebFetch as needed
  → Streaming tokens → Renderer answer pane
```

Manual type path: `Cmd+Enter` → input box content → FireDispatcher directly (bypasses classifier, reuses ScreenGrabber and transcript tail).

Wake phrase path: utterance starts with a wake phrase → FireDispatcher directly, even if auto-answer OFF, even if classifier says `addressed: false`.

### State signals (renderer listens on IPC)

| Event | Trigger | UI change |
|---|---|---|
| `transcript:delta` | Deepgram interim | transcript pane live-updates |
| `transcript:final` | Deepgram final | line locks, classifier fires |
| `state:listening` | audio frames flowing | mic dot pulses |
| `state:thinking` | FireDispatcher dispatched | shimmer on answer pane |
| `state:answering` | first token from Claude | streaming cursor |
| `state:idle` | stop token | dot calm |

### Back-pressure

- If Claude is mid-answer and another question fires, queue it. Badge `1 queued`. Do not interrupt current answer.
- If queue exceeds 3, drop oldest and toast `dropped queued question`.

### Auto-answer toggle

- Default OFF at launch. Explicit opt-in per meeting.
- When OFF: transcript still streams and saves, classifier is paused, no auto-fires. Manual typing and wake phrase still work.
- Pill border glows when ON, dim when OFF.

## Error handling

All errors are non-fatal. App never crash-exits during a meeting. Worst case degrades to text-only with no vision or transcript save.

| Failure | Detection | Response |
|---|---|---|
| TCC screen-recording denied | audio-capture stderr `ERR: permission` | Toast + open System Settings pane |
| TCC mic denied | CoreAudio `kAudioHardwareBadDeviceError` | Same pattern, mic-specific |
| Deepgram WS drops | close event or no frames in 5 s | Backoff reconnect (1/2/4/8/16 s), badge `RECONNECTING` |
| Deepgram auth fails | 401 on connect | Banner `BAD DEEPGRAM KEY`, prompt settings |
| FoundationModels unavailable | classifier exits `ERR: model-unavailable` | Silent fallback to regex heuristic, log once |
| Classifier crashes | exit != 0 | Respawn once, else regex fallback |
| Claude SDK auth expired | `UnauthorizedError` | Banner `claude login required`, pause fires |
| Claude rate limited / 529 | SDK throws | Queue up to 3, retry after 10 s |
| Zoom not running at launch | SCK process filter empty | Fall to system-wide audio, badge `CAPTURING ALL AUDIO` |
| Screenshot fails | `desktopCapturer` rejects | Fire without image, log |
| Disk full | fs error on transcript flush | Disable on-disk flush, in-memory only, toast |

## Testing

- **Unit (Vitest):** ClassifierBus wake-phrase match, FireDispatcher queue logic, TranscriptStore tail windowing, diarization speaker mapping.
- **Swift unit (XCTest):** classifier JSON schema contract, audio-capture frame format.
- **Integration (pseudo-live):** replay fixture Zoom audio file into audio-capture stdin mock, assert Deepgram → classifier → FireDispatcher sequence produces the expected payload. Stub Claude SDK.
- **E2E smoke (manual):** launch app, start real Zoom with a test participant, speak "hey claude what's in the backend repo", verify answer streams into overlay. Documented runbook, not automated.
- **Dry-run mode:** `ANTHROPIC_DRY_RUN=1` env flag makes Claude SDK log the request payload without calling the model, for snapshot tests.

## Open questions (post-v1)

- Participant consent banner before recording. Legal review needed if used outside personal context.
- Post-meeting summary tool (separate, reads saved transcripts).
- Multi-meeting memory: should Claudely remember prior meetings?
- Opus escalation: allow Claude itself to decide when to escalate to Opus based on question difficulty.
