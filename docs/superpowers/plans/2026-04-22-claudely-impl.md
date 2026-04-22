# Claudely Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a macOS overlay app that captures Zoom audio, transcribes it with Deepgram, detects repo-aware questions with on-device Apple FoundationModels, and answers them via Claude Agent SDK pinned to `~/Documents/creative_studio_repo/`, with a Cluely-style floating UI forked from Glass.

**Architecture:** Fork `pickle-com/glass` (Electron + Next.js), strip Firebase/OpenAI/Gemini/Summary, wire a Claude Agent SDK TS session, add two Swift helper binaries (audio-capture via ScreenCaptureKit, classifier via FoundationModels). Auto-answer toggle + wake phrase "hey claude". Read-only permissions during meetings.

**Tech Stack:** Electron 30+, Next.js 14, TypeScript, `@anthropic-ai/claude-agent-sdk` (TS), `@deepgram/sdk` v4, Swift 5.9+, ScreenCaptureKit, FoundationModels, Vitest, XCTest.

**Spec:** `docs/superpowers/specs/2026-04-22-claudely-design.md`

---

## Phase 0: Bootstrap

### Task 0.1: Fork Glass and rename

**Files:**
- Create: everything under `~/Documents/GitHub/Claudely/` (except existing `docs/`)

- [ ] **Step 1: Clone Glass into a staging dir, then copy into Claudely without clobbering docs**

```bash
cd /tmp
rm -rf glass-src
git clone --depth 1 https://github.com/pickle-com/glass glass-src
cd glass-src
rm -rf .git
cd ~/Documents/GitHub/Claudely
# Preserve existing docs/ and .git/
rsync -a --exclude docs --exclude .git /tmp/glass-src/ ./
```

- [ ] **Step 2: Update package.json identity**

Edit `package.json`:
```json
{
  "name": "claudely",
  "productName": "Claudely",
  "version": "0.1.0",
  "description": "Repo-aware meeting assistant powered by Claude",
  "author": { "name": "Juntao Li" },
  "license": "GPL-3.0"
}
```

Keep existing scripts for now. Remove `keywords` array entries, replace with `["claudely", "claude", "meeting", "assistant"]`.

- [ ] **Step 3: Update electron-builder.yml**

Replace `productName`, `appId`, and icon paths:
```yaml
appId: com.juntaoli.claudely
productName: Claudely
```

- [ ] **Step 4: Install dependencies, confirm baseline build**

Run:
```bash
npm install
cd pickleglass_web && npm install && cd ..
```

Expected: no errors. Native deps (`better-sqlite3`, `keytar`, `sharp`) rebuild for Electron.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: fork Glass as Claudely baseline"
```

### Task 0.2: Strip Firebase, summary, multi-provider AI

**Files:**
- Delete: `src/features/listen/summary/summaryService.js`
- Delete: `src/ui/listen/summary/SummaryView.js`
- Delete: `src/features/ask/repositories/firebase.repository.js`
- Delete: `src/features/settings/repositories/firebase.repository.js`
- Delete: `functions/`
- Delete: `firebase.json`, `firestore.indexes.json`, `.firebaserc`
- Delete: `pickleglass_web/utils/firebase.ts`, `pickleglass_web/utils/firestore.ts`
- Modify: `src/features/common/ai/factory.js` (reduce to Claude only)
- Modify: `src/features/ask/repositories/index.js` (drop Firebase branch)
- Modify: `src/features/settings/repositories/index.js` (drop Firebase branch)
- Modify: `package.json` (remove firebase deps)

- [ ] **Step 1: Delete summary feature files**

```bash
rm src/features/listen/summary/summaryService.js
rm -r src/ui/listen/summary
```

- [ ] **Step 2: Delete Firebase repos and backends**

```bash
rm src/features/ask/repositories/firebase.repository.js
rm src/features/settings/repositories/firebase.repository.js
rm -r functions
rm firebase.json firestore.indexes.json .firebaserc
rm pickleglass_web/utils/firebase.ts pickleglass_web/utils/firestore.ts
```

- [ ] **Step 3: Drop Firebase branch in repo index files**

Open `src/features/ask/repositories/index.js`, remove any `require('./firebase.repository')` branch and any `if (backend === 'firebase')` code path. Default to SQLite only. Repeat for `src/features/settings/repositories/index.js`.

- [ ] **Step 4: Remove Firebase, Google, OpenAI, Portkey deps**

Edit `package.json` dependencies, delete:
- `firebase`
- `firebase-admin`
- `@google/genai`
- `@google/generative-ai`
- `openai`
- `portkey-ai`

Run:
```bash
rm -rf node_modules package-lock.json
npm install
```

- [ ] **Step 5: Reduce ai/factory.js to Claude only**

Rewrite `src/features/common/ai/factory.js` so the exported factory returns exactly one provider (Claude). This is a stub; Phase 1 replaces it with the Agent SDK session.

```javascript
// src/features/common/ai/factory.js
function createAIProvider() {
  throw new Error('Claude Agent SDK provider wired in Phase 1');
}
module.exports = { createAIProvider };
```

Remove any imports of `@google/*` or `openai` or `portkey-ai` in this file and anywhere else that fails `npm run lint`.

- [ ] **Step 6: Run build to confirm no broken imports**

Run:
```bash
npm run build:renderer
```

Expected: build completes. If any file still imports a deleted module, delete that import or the whole file if it's Firebase/summary scoped.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor: strip Firebase, summary, multi-provider AI from fork"
```

### Task 0.3: Rebrand UI text and assets

**Files:**
- Modify: `src/ui/app/header.html`
- Modify: `src/ui/app/content.html`
- Modify: `src/ui/app/WelcomeHeader.js`
- Modify: `README.md`
- Modify: asset filenames under `src/ui/assets/` for any `glass*` names

- [ ] **Step 1: Find-replace Glass strings**

Run:
```bash
grep -rIl "Glass\|pickle-glass\|pickleglass" src/ public/ pickleglass_web/ | xargs sed -i '' 's/Glass/Claudely/g; s/pickle-glass/claudely/g; s/pickleglass/claudely/g'
```

Inspect diff with `git diff --stat`. Revert any false positive (e.g., inside a URL that must stay canonical).

- [ ] **Step 2: Rename pickleglass_web directory**

```bash
git mv pickleglass_web web
```

Update `package.json` scripts that reference `pickleglass_web` → `web`. Update `src/features/common/config/config.js` if it references the path.

- [ ] **Step 3: Write a minimal README**

Overwrite `README.md`:
```markdown
# Claudely

Repo-aware meeting assistant. Fork of Glass, powered by Claude Code.

## Quick start
npm install && npm start

## Docs
- Design: `docs/superpowers/specs/2026-04-22-claudely-design.md`
- Plan: `docs/superpowers/plans/2026-04-22-claudely-impl.md`
```

- [ ] **Step 4: Verify app still launches**

Run:
```bash
npm start
```

Expected: overlay window appears. Any runtime errors about missing Firebase/Google/OpenAI code paths → fix by deleting the offending code (it should have been scrubbed in Task 0.2).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: rebrand fork from Glass to Claudely"
```

---

## Phase 1: Claude Agent SDK wiring (manual ask path only)

Goal: get a "type a question, Claude answers in overlay" loop working end to end, before we bring audio in.

### Task 1.1: Install Claude Agent SDK, confirm auth

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install SDK**

```bash
npm install @anthropic-ai/claude-agent-sdk
```

- [ ] **Step 2: Confirm Enterprise auth works**

Run:
```bash
claude --version
cat ~/.claude/.credentials.json 2>/dev/null | head -c 50
```

Expected: `claude` CLI exists and credentials file present. The Agent SDK auto-reads `~/.claude/.credentials.json` when `ANTHROPIC_API_KEY` is unset, so Enterprise OAuth is inherited for free.

- [ ] **Step 3: Smoke test SDK from a throwaway script**

Create `scratch/sdk-smoke.js`:
```javascript
const { query } = require('@anthropic-ai/claude-agent-sdk');
(async () => {
  for await (const msg of query({
    prompt: 'say hi in 3 words',
    options: { model: 'claude-sonnet-4-6', cwd: process.env.HOME + '/Documents/creative_studio_repo' }
  })) {
    if (msg.type === 'assistant') console.log(msg.message.content);
  }
})();
```

Run:
```bash
mkdir -p scratch && node scratch/sdk-smoke.js
```

Expected: three-word greeting printed. Delete `scratch/` afterward or add to `.gitignore`.

- [ ] **Step 4: Commit**

```bash
echo "scratch/" >> .gitignore
git add package.json package-lock.json .gitignore
git commit -m "feat: add claude-agent-sdk dependency, verify Enterprise auth"
```

### Task 1.2: Write failing test for ClaudeSession module

**Files:**
- Create: `src/features/claude/__tests__/claudeSession.test.js`

- [ ] **Step 1: Install Vitest**

```bash
npm install -D vitest
```

Add to `package.json` scripts:
```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 2: Write failing test**

Create `src/features/claude/__tests__/claudeSession.test.js`:
```javascript
import { describe, it, expect, vi } from 'vitest';
import { ClaudeSession } from '../claudeSession.js';

describe('ClaudeSession', () => {
  it('streams assistant tokens to onDelta and resolves on completion', async () => {
    const fakeQuery = vi.fn(async function* () {
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'hello ' }] } };
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'world' }] } };
      yield { type: 'result', subtype: 'success' };
    });

    const session = new ClaudeSession({
      cwd: '/tmp',
      model: 'claude-sonnet-4-6',
      queryFn: fakeQuery,
    });

    const deltas = [];
    await session.ask({
      question: 'hi',
      transcriptTail: '',
      imagePath: null,
      onDelta: (t) => deltas.push(t),
    });

    expect(deltas.join('')).toBe('hello world');
    expect(fakeQuery).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 3: Run test, expect fail**

Run:
```bash
npm test
```

Expected: fail with `Cannot find module '../claudeSession.js'`.

### Task 1.3: Implement ClaudeSession

**Files:**
- Create: `src/features/claude/claudeSession.js`

- [ ] **Step 1: Write module**

```javascript
// src/features/claude/claudeSession.js
const { query: realQuery } = require('@anthropic-ai/claude-agent-sdk');

class ClaudeSession {
  constructor({ cwd, model = 'claude-sonnet-4-6', queryFn = realQuery }) {
    this.cwd = cwd;
    this.model = model;
    this._query = queryFn;
  }

  async ask({ question, transcriptTail, imagePath, onDelta }) {
    const content = [];
    if (imagePath) {
      content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: null, path: imagePath } });
    }
    const context = transcriptTail ? `Recent transcript:\n${transcriptTail}\n\nQuestion: ${question}` : question;
    content.push({ type: 'text', text: context });

    const iterator = this._query({
      prompt: { role: 'user', content },
      options: {
        cwd: this.cwd,
        model: this.model,
        allowedTools: ['Read', 'Grep', 'Glob', 'Bash', 'WebFetch'],
        disallowedTools: ['Edit', 'Write', 'NotebookEdit'],
      },
    });

    for await (const msg of iterator) {
      if (msg.type === 'assistant') {
        for (const block of msg.message.content) {
          if (block.type === 'text' && block.text) onDelta(block.text);
        }
      }
    }
  }
}

module.exports = { ClaudeSession };
```

- [ ] **Step 2: Run test, expect pass**

Run:
```bash
npm test
```

Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add src/features/claude/ package.json package-lock.json
git commit -m "feat: add ClaudeSession with Agent SDK streaming"
```

### Task 1.4: Wire ClaudeSession into existing Ask service

**Files:**
- Modify: `src/features/ask/askService.js`

- [ ] **Step 1: Open askService.js, find the LLM call site**

Look for the place the current code calls `aiFactory.createAIProvider()` or equivalent and awaits a completion. Replace with ClaudeSession.

- [ ] **Step 2: Rewrite ask entry point**

Replace the LLM invocation block with:
```javascript
const { ClaudeSession } = require('../claude/claudeSession');

let session;
function getSession() {
  if (!session) {
    session = new ClaudeSession({
      cwd: process.env.CLAUDELY_PROJECT_CWD || require('os').homedir() + '/Documents/creative_studio_repo',
      model: 'claude-sonnet-4-6',
    });
  }
  return session;
}

async function ask({ question, transcriptTail = '', imagePath = null, onDelta }) {
  return getSession().ask({ question, transcriptTail, imagePath, onDelta });
}

module.exports = { ask };
```

Preserve any existing exports that IPC consumers rely on; add new ones side by side if needed, don't remove until callers updated.

- [ ] **Step 3: Update IPC bridge to stream deltas**

Find the existing ask IPC handler in `src/bridge/featureBridge.js`. Replace its call with:
```javascript
const { ask } = require('../features/ask/askService');

ipcMain.handle('ask:question', async (event, { question }) => {
  await ask({
    question,
    onDelta: (text) => event.sender.send('ask:delta', text),
  });
  event.sender.send('ask:done');
});
```

- [ ] **Step 4: Update renderer AskView to listen for deltas**

Open `src/ui/ask/AskView.js`, find the existing answer rendering code. Replace the one-shot receive with:
```javascript
const { ipcRenderer } = require('electron');
ipcRenderer.on('ask:delta', (_, text) => appendToAnswer(text));
ipcRenderer.on('ask:done', () => markAnswerDone());
```

Where `appendToAnswer` pushes to the existing answer DOM element.

- [ ] **Step 5: Manual smoke test**

Run:
```bash
CLAUDELY_PROJECT_CWD=$HOME/Documents/creative_studio_repo npm start
```

In the overlay, press `Cmd+Enter`, type `list the subfolders in the current project folder`, press Enter.

Expected: Claude streams an answer listing `alli-creativestudio-backend`, `alli-frontend-creativestudio`, etc.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: wire Ask feature to ClaudeSession with streaming IPC"
```

---

## Phase 2: Audio capture (Swift helper)

### Task 2.1: Create Swift package for audio-capture

**Files:**
- Create: `native/audio-capture/Package.swift`
- Create: `native/audio-capture/Sources/audio-capture/main.swift`

- [ ] **Step 1: Scaffold Swift package**

```bash
mkdir -p native/audio-capture
cd native/audio-capture
swift package init --type executable --name audio-capture
```

- [ ] **Step 2: Write main.swift**

Replace `Sources/audio-capture/main.swift` with:
```swift
import Foundation
import AVFoundation
import ScreenCaptureKit
import CoreAudio

// Protocol: length-prefixed frames on stdout.
// Frame format: [UInt32 BE length][UInt8 track (0=them,1=me)][Int16 LE PCM samples @16kHz mono]

@main
struct AudioCapture {
    static func main() async {
        let bundleID = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "us.zoom.xos"
        do {
            try await runSCKStream(bundleID: bundleID, track: 0)
        } catch {
            FileHandle.standardError.write("ERR: \(error.localizedDescription)\n".data(using: .utf8)!)
            exit(2)
        }
    }

    static func runSCKStream(bundleID: String, track: UInt8) async throws {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        let target = content.applications.first { $0.bundleIdentifier == bundleID }

        let filter: SCContentFilter
        if let target {
            filter = SCContentFilter(display: content.displays.first!, including: [target], exceptingWindows: [])
        } else {
            FileHandle.standardError.write("WARN: bundle \(bundleID) not running, capturing full display audio\n".data(using: .utf8)!)
            filter = SCContentFilter(display: content.displays.first!, excludingApplications: [], exceptingWindows: [])
        }

        let config = SCStreamConfiguration()
        config.capturesAudio = true
        config.sampleRate = 16000
        config.channelCount = 1

        let stream = SCStream(filter: filter, configuration: config, delegate: nil)
        let out = StdoutSink(track: track)
        try stream.addStreamOutput(out, type: .audio, sampleHandlerQueue: .main)
        try await stream.startCapture()

        // Also tap mic on a background task as track 1
        Task.detached { try? MicCapture.run(track: 1) }

        dispatchMain()
    }
}

final class StdoutSink: NSObject, SCStreamOutput {
    let track: UInt8
    init(track: UInt8) { self.track = track }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio, let bb = sampleBuffer.dataBuffer else { return }
        var lengthOut = 0
        var dataOut: UnsafeMutablePointer<Int8>?
        CMBlockBufferGetDataPointer(bb, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &lengthOut, dataPointerOut: &dataOut)
        guard let dataOut else { return }
        writeFrame(track: track, bytes: UnsafeBufferPointer(start: dataOut, count: lengthOut))
    }
}

enum MicCapture {
    static func run(track: UInt8) throws {
        let engine = AVAudioEngine()
        let input = engine.inputNode
        let format = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true)!
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
            guard let raw = buffer.int16ChannelData?.pointee else { return }
            let byteCount = Int(buffer.frameLength) * 2
            raw.withMemoryRebound(to: Int8.self, capacity: byteCount) { ptr in
                writeFrame(track: track, bytes: UnsafeBufferPointer(start: ptr, count: byteCount))
            }
        }
        try engine.start()
        RunLoop.current.run()
    }
}

func writeFrame(track: UInt8, bytes: UnsafeBufferPointer<Int8>) {
    var header = UInt32(bytes.count + 1).bigEndian
    let stdout = FileHandle.standardOutput
    withUnsafeBytes(of: &header) { stdout.write(Data($0)) }
    stdout.write(Data([track]))
    stdout.write(Data(buffer: bytes))
}
```

- [ ] **Step 3: Update Package.swift platform requirement**

```swift
// native/audio-capture/Package.swift
// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "audio-capture",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(name: "audio-capture", path: "Sources/audio-capture"),
    ]
)
```

- [ ] **Step 4: Build**

```bash
cd native/audio-capture
swift build -c release
ls .build/release/audio-capture
```

Expected: binary exists. First run on a real machine will need Screen Recording + Microphone permissions granted to the parent app (Electron) in System Settings.

- [ ] **Step 5: Commit**

```bash
cd ~/Documents/GitHub/Claudely
echo "native/audio-capture/.build/" >> .gitignore
git add native/audio-capture .gitignore
git commit -m "feat: add Swift audio-capture helper using ScreenCaptureKit"
```

### Task 2.2: Electron AudioBus spawns helper and demuxes frames

**Files:**
- Create: `src/features/audio/audioBus.js`
- Create: `src/features/audio/__tests__/audioBus.test.js`
- Modify: `build.js` (copy Swift binary to app resources at build time)

- [ ] **Step 1: Write failing test for frame parser**

Create `src/features/audio/__tests__/audioBus.test.js`:
```javascript
import { describe, it, expect } from 'vitest';
import { parseFrames } from '../audioBus.js';

describe('parseFrames', () => {
  it('emits one frame per length-prefixed chunk', () => {
    // two frames: track 0, 4 PCM bytes; track 1, 2 PCM bytes
    const buf = Buffer.concat([
      Buffer.from([0, 0, 0, 5, 0, 0xaa, 0xbb, 0xcc, 0xdd]),
      Buffer.from([0, 0, 0, 3, 1, 0xee, 0xff]),
    ]);
    const frames = [];
    const remaining = parseFrames(buf, (track, pcm) => frames.push({ track, pcm: [...pcm] }));
    expect(frames).toEqual([
      { track: 0, pcm: [0xaa, 0xbb, 0xcc, 0xdd] },
      { track: 1, pcm: [0xee, 0xff] },
    ]);
    expect(remaining.length).toBe(0);
  });

  it('returns leftover bytes when a frame is truncated', () => {
    const buf = Buffer.from([0, 0, 0, 5, 0, 0xaa, 0xbb]); // needs 5 payload bytes, only 3
    const frames = [];
    const remaining = parseFrames(buf, (t, p) => frames.push({ t, p }));
    expect(frames.length).toBe(0);
    expect(remaining.length).toBe(7);
  });
});
```

- [ ] **Step 2: Run test, expect fail**

```bash
npm test -- audioBus
```

Expected: module not found.

- [ ] **Step 3: Implement audioBus.js**

```javascript
// src/features/audio/audioBus.js
const { spawn } = require('child_process');
const path = require('path');
const EventEmitter = require('events');

function parseFrames(buffer, emit) {
  let offset = 0;
  while (buffer.length - offset >= 5) {
    const totalLen = buffer.readUInt32BE(offset);
    if (buffer.length - offset - 4 < totalLen) break;
    const track = buffer[offset + 4];
    const pcm = buffer.subarray(offset + 5, offset + 4 + totalLen);
    emit(track, pcm);
    offset += 4 + totalLen;
  }
  return buffer.subarray(offset);
}

class AudioBus extends EventEmitter {
  constructor({ binaryPath, bundleId = 'us.zoom.xos' }) {
    super();
    this.binaryPath = binaryPath;
    this.bundleId = bundleId;
    this._buffer = Buffer.alloc(0);
    this._proc = null;
  }

  start() {
    this._proc = spawn(this.binaryPath, [this.bundleId]);
    this._proc.stdout.on('data', (chunk) => {
      this._buffer = Buffer.concat([this._buffer, chunk]);
      this._buffer = parseFrames(this._buffer, (track, pcm) => this.emit('pcm', { track, pcm }));
    });
    this._proc.stderr.on('data', (d) => this.emit('stderr', d.toString()));
    this._proc.on('exit', (code) => this.emit('exit', code));
  }

  stop() {
    this._proc?.kill();
    this._proc = null;
  }
}

module.exports = { AudioBus, parseFrames };
```

- [ ] **Step 4: Run test, expect pass**

```bash
npm test -- audioBus
```

Expected: pass.

- [ ] **Step 5: Wire binary into build.js**

Edit `build.js`, add a step that copies `native/audio-capture/.build/release/audio-capture` into `src/ui/assets/bin/audio-capture` (alongside the existing `SystemAudioDump` pattern). Fail build loudly if the Swift binary is missing.

```javascript
// inside build.js, near other asset copies
const binSrc = path.join(__dirname, 'native/audio-capture/.build/release/audio-capture');
const binDst = path.join(__dirname, 'src/ui/assets/bin/audio-capture');
if (!fs.existsSync(binSrc)) {
  console.error('Missing native/audio-capture binary. Run: cd native/audio-capture && swift build -c release');
  process.exit(1);
}
fs.mkdirSync(path.dirname(binDst), { recursive: true });
fs.copyFileSync(binSrc, binDst);
fs.chmodSync(binDst, 0o755);
```

Also add a convenience `package.json` script:
```json
"build:native": "cd native/audio-capture && swift build -c release"
```

And extend:
```json
"build:all": "npm run build:native && npm run build:renderer && npm run build:web"
```

- [ ] **Step 6: Smoke test: spawn binary, log first frame**

Create `scratch/audio-smoke.js`:
```javascript
const path = require('path');
const { AudioBus } = require('../src/features/audio/audioBus');
const bus = new AudioBus({ binaryPath: path.resolve(__dirname, '../src/ui/assets/bin/audio-capture') });
bus.on('pcm', ({ track, pcm }) => {
  console.log('frame', { track, bytes: pcm.length });
  if (Math.random() < 0.01) process.exit(0);
});
bus.on('stderr', (s) => process.stderr.write(s));
bus.start();
```

Run:
```bash
npm run build:native
node scratch/audio-smoke.js
```

Expected: stream of `frame { track: 0, bytes: ~640 }` logs while Zoom is playing audio. Grant permissions via System Settings on first run.

- [ ] **Step 7: Commit**

```bash
git add src/features/audio build.js package.json
git commit -m "feat: AudioBus spawns Swift capture helper, demuxes length-prefixed frames"
```

---

## Phase 3: Deepgram streaming + TranscriptStore

### Task 3.1: Rewrite sttService around AudioBus and Deepgram multichannel

**Files:**
- Modify: `src/features/listen/stt/sttService.js`
- Create: `src/features/listen/transcriptStore.js`
- Create: `src/features/listen/__tests__/transcriptStore.test.js`

- [ ] **Step 1: Write failing test for TranscriptStore**

```javascript
// src/features/listen/__tests__/transcriptStore.test.js
import { describe, it, expect } from 'vitest';
import { TranscriptStore } from '../transcriptStore.js';

describe('TranscriptStore', () => {
  it('returns only lines within the last N seconds in tail()', () => {
    const store = new TranscriptStore({ maxMinutes: 60 });
    store.append({ text: 'old', speaker: 'A', ts: 1000 });
    store.append({ text: 'new', speaker: 'B', ts: 60_000 });
    const tail = store.tail({ now: 60_000, seconds: 30 });
    expect(tail).toBe('B: new');
  });

  it('drops oldest when over maxMinutes', () => {
    const store = new TranscriptStore({ maxMinutes: 1 });
    store.append({ text: 'old', speaker: 'A', ts: 0 });
    store.append({ text: 'new', speaker: 'B', ts: 120_000 });
    expect(store.all().length).toBe(1);
    expect(store.all()[0].text).toBe('new');
  });
});
```

- [ ] **Step 2: Run test, expect fail**

```bash
npm test -- transcriptStore
```

- [ ] **Step 3: Implement TranscriptStore**

```javascript
// src/features/listen/transcriptStore.js
const fs = require('fs');
const path = require('path');

class TranscriptStore {
  constructor({ maxMinutes = 60, persistPath = null } = {}) {
    this.maxMs = maxMinutes * 60_000;
    this.lines = [];
    this.persistPath = persistPath;
    if (persistPath) {
      fs.mkdirSync(path.dirname(persistPath), { recursive: true });
      this._stream = fs.createWriteStream(persistPath, { flags: 'a' });
    }
  }

  append(line) {
    this.lines.push(line);
    const cutoff = line.ts - this.maxMs;
    while (this.lines.length && this.lines[0].ts < cutoff) this.lines.shift();
    if (this._stream) this._stream.write(JSON.stringify(line) + '\n');
  }

  tail({ now, seconds }) {
    const since = now - seconds * 1000;
    return this.lines
      .filter((l) => l.ts >= since)
      .map((l) => `${l.speaker}: ${l.text}`)
      .join('\n');
  }

  all() { return [...this.lines]; }

  close() { this._stream?.end(); }
}

module.exports = { TranscriptStore };
```

- [ ] **Step 4: Run test, expect pass**

```bash
npm test -- transcriptStore
```

- [ ] **Step 5: Rewrite sttService.js to consume AudioBus**

Replace the body of `src/features/listen/stt/sttService.js` with:
```javascript
const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');
const { AudioBus } = require('../../audio/audioBus');
const { TranscriptStore } = require('../transcriptStore');
const path = require('path');
const os = require('os');

function start({ onFinal, onInterim, onState }) {
  const key = process.env.DEEPGRAM_API_KEY;
  if (!key) throw new Error('DEEPGRAM_API_KEY missing');
  const deepgram = createClient(key);
  const live = deepgram.listen.live({
    model: 'nova-3',
    diarize: true,
    multichannel: true,
    encoding: 'linear16',
    sample_rate: 16000,
    channels: 2,
    interim_results: true,
    smart_format: true,
  });

  const persistPath = path.join(
    os.homedir(),
    'Library/Application Support/Claudely/transcripts',
    `${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`
  );
  const store = new TranscriptStore({ maxMinutes: 60, persistPath });

  live.on(LiveTranscriptionEvents.Transcript, (payload) => {
    const alt = payload.channel?.alternatives?.[0];
    if (!alt?.transcript) return;
    const channel = payload.channel_index?.[0] ?? 0;
    const speaker = channel === 1 ? 'me' : (alt.words?.[0]?.speaker !== undefined ? `them-${alt.words[0].speaker}` : 'them');
    const line = { text: alt.transcript, speaker, ts: Date.now() };
    if (payload.is_final) {
      store.append(line);
      onFinal?.(line);
    } else {
      onInterim?.(line);
    }
  });
  live.on(LiveTranscriptionEvents.Error, (e) => onState?.({ type: 'error', error: e }));
  live.on(LiveTranscriptionEvents.Open, () => onState?.({ type: 'listening' }));

  const binaryPath = path.join(__dirname, '../../../ui/assets/bin/audio-capture');
  const bus = new AudioBus({ binaryPath });

  // Interleave track-0 and track-1 frames into stereo PCM for Deepgram multichannel.
  // We buffer one PCM sample per track, emit when both available.
  let pending = { 0: Buffer.alloc(0), 1: Buffer.alloc(0) };
  bus.on('pcm', ({ track, pcm }) => {
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
    live.send(interleaved);
  });
  bus.on('stderr', (s) => onState?.({ type: 'stderr', text: s }));
  bus.start();

  return {
    store,
    stop() { bus.stop(); live.finish(); store.close(); },
  };
}

module.exports = { start };
```

- [ ] **Step 6: IPC: forward transcript events to renderer**

In `src/bridge/featureBridge.js`, replace old listen wiring with:
```javascript
const stt = require('../features/listen/stt/sttService');
let activeListen = null;

ipcMain.handle('listen:start', (event) => {
  if (activeListen) return;
  activeListen = stt.start({
    onFinal: (l) => event.sender.send('transcript:final', l),
    onInterim: (l) => event.sender.send('transcript:delta', l),
    onState: (s) => event.sender.send('state:update', s),
  });
});
ipcMain.handle('listen:stop', () => {
  activeListen?.stop();
  activeListen = null;
});
```

- [ ] **Step 7: Renderer: render transcript pane**

Open `src/ui/listen/stt/SttView.js`. Replace its existing text stream handler with:
```javascript
ipcRenderer.on('transcript:delta', (_, line) => renderInterim(line));
ipcRenderer.on('transcript:final', (_, line) => renderFinal(line));
```

Where `renderInterim` swaps a ghost line and `renderFinal` locks it.

- [ ] **Step 8: Smoke test with real Zoom**

```bash
export DEEPGRAM_API_KEY=sk-...
npm run build:all && npm start
```

Click the listen button, speak into mic and play a Zoom test call.

Expected: transcript streams into overlay, mic labeled `me`, meeting voices labeled `them-0`, `them-1`.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: rewrite STT around AudioBus and Deepgram multichannel, add TranscriptStore"
```

---

## Phase 4: Classifier helper + wake phrase + auto-answer toggle

### Task 4.1: Build Swift classifier with FoundationModels

**Files:**
- Create: `native/classifier/Package.swift`
- Create: `native/classifier/Sources/classifier/main.swift`

- [ ] **Step 1: Scaffold**

```bash
mkdir -p native/classifier
cd native/classifier
swift package init --type executable --name classifier
```

- [ ] **Step 2: Write main.swift**

```swift
import Foundation
import FoundationModels

@main
struct Classifier {
    static func main() async {
        guard let session = try? LanguageModelSession() else {
            FileHandle.standardError.write("ERR: model-unavailable\n".data(using: .utf8)!)
            exit(2)
        }

        let systemPrompt = """
        You classify meeting utterances. Decide if the utterance is addressed to a repo-aware AI assistant and needs answering.
        Always return strict JSON: {"addressed": bool, "question": string|null}. No prose.
        """
        _ = try? await session.respond(to: systemPrompt)

        let stdin = FileHandle.standardInput
        while let line = try? stdin.readLine() {
            guard !line.isEmpty else { continue }
            do {
                let prompt = "Utterance: \(line)\nJSON only."
                let resp = try await session.respond(to: prompt)
                print(resp.content.trimmingCharacters(in: .whitespacesAndNewlines))
                FileHandle.standardOutput.synchronizeFile()
            } catch {
                print("{\"addressed\":false,\"question\":null}")
            }
        }
    }
}

extension FileHandle {
    func readLine() throws -> String? {
        var buf = Data()
        while true {
            let b = try? read(upToCount: 1)
            guard let b, !b.isEmpty else { return buf.isEmpty ? nil : String(data: buf, encoding: .utf8) }
            if b == Data([0x0a]) { return String(data: buf, encoding: .utf8) }
            buf.append(b)
        }
    }
}
```

- [ ] **Step 3: Package.swift**

```swift
// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "classifier",
    platforms: [.macOS(.v15)],  // FoundationModels requires 15+
    targets: [
        .executableTarget(name: "classifier", path: "Sources/classifier"),
    ]
)
```

- [ ] **Step 4: Build**

```bash
swift build -c release
```

- [ ] **Step 5: Manual smoke**

```bash
echo 'does our auth service handle SSO?' | .build/release/classifier
echo 'can you pass the sauce' | .build/release/classifier
```

Expected: first emits `{"addressed":true,"question":"..."}`, second emits `{"addressed":false,"question":null}` (or close).

- [ ] **Step 6: Extend build:native to include classifier**

```json
"build:native": "cd native/audio-capture && swift build -c release && cd ../classifier && swift build -c release"
```

And in `build.js`, copy the binary:
```javascript
const clsSrc = path.join(__dirname, 'native/classifier/.build/release/classifier');
const clsDst = path.join(__dirname, 'src/ui/assets/bin/classifier');
if (!fs.existsSync(clsSrc)) { console.error('Missing classifier binary'); process.exit(1); }
fs.copyFileSync(clsSrc, clsDst);
fs.chmodSync(clsDst, 0o755);
```

- [ ] **Step 7: Commit**

```bash
cd ~/Documents/GitHub/Claudely
git add native/classifier build.js package.json
git commit -m "feat: add Swift classifier helper using FoundationModels"
```

### Task 4.2: ClassifierBus, wake phrase, auto-answer toggle

**Files:**
- Create: `src/features/classify/classifierBus.js`
- Create: `src/features/classify/__tests__/classifierBus.test.js`
- Create: `src/features/classify/wakePhrase.js`
- Create: `src/features/classify/__tests__/wakePhrase.test.js`
- Create: `src/features/classify/regexFallback.js`

- [ ] **Step 1: Wake phrase test**

```javascript
// src/features/classify/__tests__/wakePhrase.test.js
import { describe, it, expect } from 'vitest';
import { matchWake } from '../wakePhrase.js';

describe('matchWake', () => {
  const phrases = ['hey claude', 'hey claudely'];
  it('matches at start, case-insensitive', () => {
    expect(matchWake('Hey Claude, what is 2+2', phrases)).toBe('what is 2+2');
  });
  it('returns null when no phrase', () => {
    expect(matchWake('random chatter', phrases)).toBeNull();
  });
  it('strips trailing comma and whitespace', () => {
    expect(matchWake('hey claudely   does X work?', phrases)).toBe('does X work?');
  });
});
```

- [ ] **Step 2: Run, expect fail, then implement wakePhrase.js**

```javascript
// src/features/classify/wakePhrase.js
function matchWake(utterance, phrases) {
  const lower = utterance.toLowerCase();
  for (const p of phrases) {
    if (lower.startsWith(p)) {
      return utterance.slice(p.length).replace(/^[,\s]+/, '').trim() || null;
    }
  }
  return null;
}
module.exports = { matchWake };
```

Run `npm test -- wakePhrase` → pass.

- [ ] **Step 3: Regex fallback (for when classifier unavailable)**

```javascript
// src/features/classify/regexFallback.js
const STARTS = /^\s*(what|how|can|could|does|do|is|are|why|when|where|which|who)\b/i;
function regexClassify(utterance) {
  const addressed = STARTS.test(utterance) || /\?\s*$/.test(utterance);
  return { addressed, question: addressed ? utterance.trim() : null };
}
module.exports = { regexClassify };
```

- [ ] **Step 4: ClassifierBus test (spawned binary mocked)**

```javascript
// src/features/classify/__tests__/classifierBus.test.js
import { describe, it, expect, vi } from 'vitest';
import { ClassifierBus } from '../classifierBus.js';

describe('ClassifierBus', () => {
  it('falls back to regex when binary emits model-unavailable', async () => {
    const fakeSpawn = () => ({
      stdout: { on: (_, cb) => {} },
      stderr: { on: (ev, cb) => { if (ev === 'data') setImmediate(() => cb('ERR: model-unavailable\n')); } },
      stdin: { write: () => {} },
      on: () => {},
      kill: () => {},
    });
    const bus = new ClassifierBus({ binaryPath: '/fake', spawnFn: fakeSpawn });
    bus.start();
    await new Promise((r) => setTimeout(r, 10));
    const result = await bus.classify('what does the auth service do?');
    expect(result.addressed).toBe(true);
    expect(result.question).toContain('auth service');
  });
});
```

- [ ] **Step 5: Implement ClassifierBus**

```javascript
// src/features/classify/classifierBus.js
const { spawn } = require('child_process');
const { regexClassify } = require('./regexFallback');

class ClassifierBus {
  constructor({ binaryPath, spawnFn = spawn }) {
    this.binaryPath = binaryPath;
    this.spawnFn = spawnFn;
    this._proc = null;
    this._unavailable = false;
    this._queue = [];
    this._buffer = '';
  }

  start() {
    this._proc = this.spawnFn(this.binaryPath, []);
    this._proc.stdout.on('data', (d) => {
      this._buffer += d.toString();
      let idx;
      while ((idx = this._buffer.indexOf('\n')) !== -1) {
        const line = this._buffer.slice(0, idx).trim();
        this._buffer = this._buffer.slice(idx + 1);
        const waiter = this._queue.shift();
        if (!waiter) continue;
        try { waiter.resolve(JSON.parse(line)); }
        catch { waiter.resolve({ addressed: false, question: null }); }
      }
    });
    this._proc.stderr.on('data', (d) => {
      if (d.toString().includes('model-unavailable')) this._unavailable = true;
    });
    this._proc.on('exit', () => { this._proc = null; });
  }

  async classify(utterance) {
    if (this._unavailable || !this._proc) return regexClassify(utterance);
    return new Promise((resolve, reject) => {
      this._queue.push({ resolve, reject });
      this._proc.stdin.write(utterance.replace(/\n/g, ' ') + '\n');
    });
  }

  stop() { this._proc?.kill(); this._proc = null; }
}

module.exports = { ClassifierBus };
```

- [ ] **Step 6: Run tests, expect pass**

```bash
npm test -- classify
```

- [ ] **Step 7: Commit**

```bash
git add src/features/classify
git commit -m "feat: ClassifierBus with wake-phrase match and regex fallback"
```

### Task 4.3: Wire classifier into listen path, add auto-answer toggle

**Files:**
- Modify: `src/features/listen/stt/sttService.js`
- Modify: `src/features/common/config/schema.js`
- Modify: `src/bridge/featureBridge.js`
- Modify: `src/features/shortcuts/shortcutsService.js`

- [ ] **Step 1: Extend config schema**

In `src/features/common/config/schema.js`, add:
```javascript
autoAnswer: { type: 'boolean', default: false },
wakePhrases: { type: 'array', default: ['hey claude', 'hey claudely'] },
projectCwd: { type: 'string', default: require('os').homedir() + '/Documents/creative_studio_repo' },
deepgramApiKey: { type: 'string', default: '' },
model: { type: 'string', default: 'claude-sonnet-4-6' },
```

- [ ] **Step 2: Wire classifier into STT final handler**

In `sttService.js` `start()`, after `onFinal?.(line)` add:
```javascript
const fired = fireDispatcher.maybeFire(line);
if (fired) onState?.({ type: 'fired', reason: fired });
```

Import and construct in `start()`:
```javascript
const path = require('path');
const config = require('../../common/config/config');
const { ClassifierBus } = require('../../classify/classifierBus');
const { matchWake } = require('../../classify/wakePhrase');
const { FireDispatcher } = require('../../fire/fireDispatcher'); // Phase 5

const classifier = new ClassifierBus({
  binaryPath: path.join(__dirname, '../../../ui/assets/bin/classifier'),
});
classifier.start();

const fireDispatcher = new FireDispatcher({ store, classifier, config });
```

- [ ] **Step 3: Hotkey Cmd+Shift+A to toggle auto-answer**

In `src/features/shortcuts/shortcutsService.js`, register:
```javascript
globalShortcut.register('CommandOrControl+Shift+A', () => {
  const current = config.get('autoAnswer');
  config.set('autoAnswer', !current);
  mainWindow.webContents.send('state:update', { type: 'autoAnswer', value: !current });
});
globalShortcut.register('CommandOrControl+Shift+M', () => {
  mainWindow.webContents.send('state:update', { type: 'panicMute' });
  stopAllCapture();
});
```

Add `stopAllCapture()` calling the stt stop path.

- [ ] **Step 4: Renderer badge for auto-answer state**

In `src/ui/app/MainHeader.js`, add an `AUTO-ANSWER ON/OFF` pill next to the existing state badge. Listen for `state:update {type: 'autoAnswer', value}` and toggle class `.on`/`.off`. CSS: `.on { border-color: var(--accent); box-shadow: 0 0 8px var(--accent); }`.

- [ ] **Step 5: Commit (without FireDispatcher yet, it lands in Phase 5, guard the import behind a try/catch for now or stub a no-op FireDispatcher)**

Temporary stub: `src/features/fire/fireDispatcher.js`:
```javascript
class FireDispatcher {
  constructor() {}
  maybeFire() { return null; }
}
module.exports = { FireDispatcher };
```

```bash
git add -A
git commit -m "feat: wire classifier, add auto-answer toggle + panic-mute hotkey"
```

---

## Phase 5: ScreenGrabber + FireDispatcher

### Task 5.1: ScreenGrabber

**Files:**
- Create: `src/features/fire/screenGrabber.js`
- Create: `src/features/fire/__tests__/screenGrabber.test.js`

- [ ] **Step 1: Test**

```javascript
// src/features/fire/__tests__/screenGrabber.test.js
import { describe, it, expect, vi } from 'vitest';
import { ScreenGrabber } from '../screenGrabber.js';

describe('ScreenGrabber', () => {
  it('writes PNG to tmp and returns path', async () => {
    const sources = [{ thumbnail: { toPNG: () => Buffer.from('fakepng') } }];
    const fakeCapturer = { getSources: vi.fn(async () => sources) };
    const fakeFs = { writeFileSync: vi.fn(), mkdirSync: vi.fn() };
    const g = new ScreenGrabber({ capturer: fakeCapturer, fs: fakeFs, tmpDir: '/tmp/claudely' });
    const p = await g.grab();
    expect(p).toMatch(/\/tmp\/claudely\/screen-.*\.png/);
    expect(fakeFs.writeFileSync).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run fail, implement**

```javascript
// src/features/fire/screenGrabber.js
const path = require('path');
const realFs = require('fs');

class ScreenGrabber {
  constructor({ capturer, fs = realFs, tmpDir } = {}) {
    this.capturer = capturer; // electron's desktopCapturer
    this.fs = fs;
    this.tmpDir = tmpDir || require('os').tmpdir() + '/claudely';
  }

  async grab() {
    this.fs.mkdirSync(this.tmpDir, { recursive: true });
    const sources = await this.capturer.getSources({ types: ['screen'], thumbnailSize: { width: 1920, height: 1080 } });
    if (!sources[0]) throw new Error('no screen source');
    const png = sources[0].thumbnail.toPNG();
    const p = path.join(this.tmpDir, `screen-${Date.now()}.png`);
    this.fs.writeFileSync(p, png);
    return p;
  }
}

module.exports = { ScreenGrabber };
```

- [ ] **Step 3: Run test, expect pass. Commit.**

```bash
git add src/features/fire/screenGrabber.js src/features/fire/__tests__/screenGrabber.test.js
git commit -m "feat: ScreenGrabber writes PNG via desktopCapturer"
```

### Task 5.2: FireDispatcher (real)

**Files:**
- Modify: `src/features/fire/fireDispatcher.js`
- Create: `src/features/fire/__tests__/fireDispatcher.test.js`

- [ ] **Step 1: Test**

```javascript
// src/features/fire/__tests__/fireDispatcher.test.js
import { describe, it, expect, vi } from 'vitest';
import { FireDispatcher } from '../fireDispatcher.js';

describe('FireDispatcher', () => {
  const makeDeps = (overrides = {}) => ({
    store: { tail: () => 'them: does our auth use SSO?' },
    classifier: { classify: vi.fn(async () => ({ addressed: true, question: 'does our auth use SSO?' })) },
    grabber: { grab: vi.fn(async () => '/tmp/screen.png') },
    claude: { ask: vi.fn(async () => {}) },
    config: { get: (k) => ({ autoAnswer: true, wakePhrases: ['hey claude'] }[k]) },
    onState: vi.fn(),
    ...overrides,
  });

  it('fires when classifier returns addressed and auto-answer ON', async () => {
    const deps = makeDeps();
    const d = new FireDispatcher(deps);
    await d.maybeFire({ text: 'does our auth use SSO?', speaker: 'them-0', ts: Date.now() });
    expect(deps.claude.ask).toHaveBeenCalledOnce();
  });

  it('skips when auto-answer OFF and no wake phrase', async () => {
    const deps = makeDeps({ config: { get: () => false } });
    const d = new FireDispatcher(deps);
    await d.maybeFire({ text: 'does our auth use SSO?', speaker: 'them-0', ts: Date.now() });
    expect(deps.claude.ask).not.toHaveBeenCalled();
  });

  it('fires on wake phrase even when auto-answer OFF', async () => {
    const deps = makeDeps({ config: { get: (k) => (k === 'autoAnswer' ? false : ['hey claude']) } });
    const d = new FireDispatcher(deps);
    await d.maybeFire({ text: 'hey claude what time is it', speaker: 'me', ts: Date.now() });
    expect(deps.claude.ask).toHaveBeenCalledOnce();
    expect(deps.claude.ask.mock.calls[0][0].question).toBe('what time is it');
  });

  it('queues a second fire while first is in flight, caps at 3', async () => {
    let resolveFirst;
    const deps = makeDeps({
      claude: { ask: vi.fn(() => new Promise((r) => { resolveFirst = r; })) },
    });
    const d = new FireDispatcher(deps);
    await d.maybeFire({ text: 'q1?', speaker: 'them', ts: 1 });
    await d.maybeFire({ text: 'q2?', speaker: 'them', ts: 2 });
    await d.maybeFire({ text: 'q3?', speaker: 'them', ts: 3 });
    await d.maybeFire({ text: 'q4?', speaker: 'them', ts: 4 });
    await d.maybeFire({ text: 'q5?', speaker: 'them', ts: 5 });
    expect(d.queueSize()).toBe(3);
    resolveFirst();
  });
});
```

- [ ] **Step 2: Implement**

Replace `src/features/fire/fireDispatcher.js` stub with:
```javascript
const { matchWake } = require('../classify/wakePhrase');

class FireDispatcher {
  constructor({ store, classifier, grabber, claude, config, onState }) {
    this.store = store;
    this.classifier = classifier;
    this.grabber = grabber;
    this.claude = claude;
    this.config = config;
    this.onState = onState || (() => {});
    this._inFlight = false;
    this._queue = [];
  }

  queueSize() { return this._queue.length; }

  async maybeFire(line) {
    const wakePhrases = this.config.get('wakePhrases') || [];
    const auto = this.config.get('autoAnswer');

    let question = matchWake(line.text, wakePhrases);
    if (!question && auto) {
      const verdict = await this.classifier.classify(line.text);
      if (verdict.addressed) question = verdict.question || line.text;
    }
    if (!question) return null;

    if (this._inFlight) {
      if (this._queue.length >= 3) {
        this._queue.shift();
        this.onState({ type: 'drop-queued' });
      }
      this._queue.push({ line, question });
      this.onState({ type: 'queued', size: this._queue.length });
      return 'queued';
    }

    await this._fire({ line, question });
    while (this._queue.length) await this._fire(this._queue.shift());
    return 'fired';
  }

  async manualFire({ question }) {
    if (this._inFlight) {
      if (this._queue.length >= 3) this._queue.shift();
      this._queue.push({ line: { ts: Date.now() }, question });
      return 'queued';
    }
    await this._fire({ line: { ts: Date.now() }, question });
    while (this._queue.length) await this._fire(this._queue.shift());
    return 'fired';
  }

  async _fire({ line, question }) {
    this._inFlight = true;
    this.onState({ type: 'thinking' });
    let imagePath = null;
    try { imagePath = await this.grabber?.grab(); } catch (_) {}
    const transcriptTail = this.store.tail({ now: line.ts || Date.now(), seconds: 30 });
    await this.claude.ask({
      question,
      transcriptTail,
      imagePath,
      onDelta: (text) => this.onState({ type: 'delta', text }),
    });
    this.onState({ type: 'done' });
    this._inFlight = false;
  }
}

module.exports = { FireDispatcher };
```

- [ ] **Step 3: Run tests, expect pass**

```bash
npm test -- fireDispatcher
```

- [ ] **Step 4: Commit**

```bash
git add src/features/fire
git commit -m "feat: real FireDispatcher with queue, wake-phrase, auto-answer gating"
```

### Task 5.3: Wire FireDispatcher into STT + manual-ask path

**Files:**
- Modify: `src/features/listen/stt/sttService.js`
- Modify: `src/features/ask/askService.js`
- Modify: `src/bridge/featureBridge.js`

- [ ] **Step 1: Construct shared dispatcher**

Create `src/features/fire/instance.js`:
```javascript
const path = require('path');
const { desktopCapturer } = require('electron');
const { FireDispatcher } = require('./fireDispatcher');
const { ScreenGrabber } = require('./screenGrabber');
const { ClaudeSession } = require('../claude/claudeSession');
const config = require('../common/config/config');

let dispatcher;
function getDispatcher({ store, classifier, onState }) {
  if (dispatcher) return dispatcher;
  const grabber = new ScreenGrabber({ capturer: desktopCapturer });
  const claude = new ClaudeSession({ cwd: config.get('projectCwd'), model: config.get('model') });
  dispatcher = new FireDispatcher({ store, classifier, grabber, claude, config, onState });
  return dispatcher;
}
module.exports = { getDispatcher };
```

- [ ] **Step 2: Use it in sttService.js**

Replace the stub FireDispatcher import with:
```javascript
const { getDispatcher } = require('../../fire/instance');
const fireDispatcher = getDispatcher({ store, classifier, onState });
```

- [ ] **Step 3: Rewire ask IPC to go through dispatcher**

In `src/bridge/featureBridge.js` replace the earlier `ask:question` handler with:
```javascript
ipcMain.handle('ask:question', async (event, { question }) => {
  const { getDispatcher } = require('../features/fire/instance');
  // store/classifier are bound when listen:start fired; if not, use a stub store
  const dispatcher = getDispatcher({
    store: activeListen?.store || { tail: () => '' },
    classifier: { classify: async () => ({ addressed: false, question: null }) },
    onState: (s) => {
      if (s.type === 'delta') event.sender.send('ask:delta', s.text);
      if (s.type === 'done') event.sender.send('ask:done');
    },
  });
  await dispatcher.manualFire({ question });
});
```

- [ ] **Step 4: Smoke E2E**

```bash
export DEEPGRAM_API_KEY=sk-...
npm run build:all && npm start
```

Start listening. Speak: `hey claude what repos are in this project`.

Expected: overlay shows `THINKING`, then streams Claude's answer listing sub-repos.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: wire FireDispatcher into listen and manual-ask paths"
```

---

## Phase 6: Screen-share invisibility + final polish

### Task 6.1: Content protection + always-on-top

**Files:**
- Modify: `src/window/windowManager.js`

- [ ] **Step 1: Set content protection**

In `windowManager.js` where the main overlay `BrowserWindow` is created, add:
```javascript
win.setContentProtection(true);
win.setAlwaysOnTop(true, 'screen-saver');
win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
```

And confirm `Info.plist`/electron-builder has `LSUIElement: true` so the dock icon is hidden. Edit `electron-builder.yml`:
```yaml
mac:
  extendInfo:
    LSUIElement: true
```

- [ ] **Step 2: Smoke test**

```bash
npm start
```

Then start a Zoom test meeting, share your screen to yourself on a second device or use QuickTime screen recording.

Expected: Claudely window does not appear in the Zoom share or QuickTime recording. Window stays on top of Zoom.

- [ ] **Step 3: Commit**

```bash
git add src/window/windowManager.js electron-builder.yml
git commit -m "feat: hide Claudely from screen share, pin above Zoom"
```

### Task 6.2: Dry-run mode and fixture-based integration test

**Files:**
- Modify: `src/features/claude/claudeSession.js`
- Create: `src/features/listen/__tests__/listen.integration.test.js`
- Create: `test/fixtures/utterance-stream.jsonl`

- [ ] **Step 1: Add dry-run to ClaudeSession**

At the top of `ask()`:
```javascript
if (process.env.ANTHROPIC_DRY_RUN === '1') {
  const payload = JSON.stringify({ question, transcriptTail, imagePath });
  console.log('[DRY-RUN]', payload);
  onDelta?.('[dry-run]');
  return;
}
```

- [ ] **Step 2: Fixture**

Create `test/fixtures/utterance-stream.jsonl`:
```json
{"text":"let's talk about auth today","speaker":"them-0","ts":1000}
{"text":"does our backend handle SSO?","speaker":"them-0","ts":2000}
{"text":"hey claude can you look up the login flow","speaker":"me","ts":3000}
{"text":"totally unrelated chitchat","speaker":"them-1","ts":4000}
```

- [ ] **Step 3: Integration test**

```javascript
// src/features/listen/__tests__/listen.integration.test.js
import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { TranscriptStore } from '../transcriptStore.js';
import { FireDispatcher } from '../../fire/fireDispatcher.js';

describe('listen integration', () => {
  it('fires exactly twice on the fixture stream: the SSO question + wake phrase', async () => {
    const store = new TranscriptStore({ maxMinutes: 60 });
    const classifier = {
      classify: async (u) => ({
        addressed: /\?$/.test(u) || /SSO/.test(u),
        question: u,
      }),
    };
    const claude = { ask: vi.fn(async () => {}) };
    const config = { get: (k) => ({ autoAnswer: true, wakePhrases: ['hey claude'] }[k]) };
    const grabber = { grab: async () => null };

    const d = new FireDispatcher({ store, classifier, grabber, claude, config, onState: () => {} });

    const lines = fs
      .readFileSync(path.join(__dirname, '../../../../test/fixtures/utterance-stream.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map(JSON.parse);

    for (const line of lines) {
      store.append(line);
      await d.maybeFire(line);
    }

    expect(claude.ask).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 4: Run, commit**

```bash
npm test
git add -A
git commit -m "test: listen integration + dry-run mode for ClaudeSession"
```

### Task 6.3: Manual E2E runbook

**Files:**
- Create: `docs/E2E.md`

- [ ] **Step 1: Write runbook**

```markdown
# Claudely E2E smoke

## Prereqs
- macOS 15+ with Apple Intelligence enabled (for FoundationModels)
- Zoom installed and signed in
- `claude` CLI logged in to Enterprise account (`claude --version` works)
- `DEEPGRAM_API_KEY` exported
- `~/Documents/creative_studio_repo/` exists with the Alli sub-repos

## Steps
1. `npm run build:all && npm start`
2. Grant Screen Recording + Microphone permissions for `Claudely.app` in System Settings when prompted.
3. Start a Zoom test meeting, play an audio clip in it with the question "does our auth service handle SSO".
4. In Claudely, press `Cmd+Shift+A` to enable auto-answer. Badge goes ON.
5. Expected: transcript line shows `them-0: does our auth service handle SSO`, then Claudely enters THINKING, then streams an answer referencing specific files from `alli-creativestudio-backend`.
6. Press `Cmd+Enter`, type `list the subfolders`. Expected: streamed list of sub-repos.
7. Say aloud "hey claude what is in the frontend repo". Expected: auto-fires regardless of auto-answer state.
8. Verify Claudely invisible: share your screen in Zoom to a second device, Claudely window should not appear.
9. Press `Cmd+Shift+M` to panic-mute. All capture stops.

## Known limitations
- If Apple Intelligence is off, classifier falls back to regex. Quality drops; wake phrase still works.
- If Zoom is not the frontmost app when capture starts, SCK falls back to full-display audio.
```

- [ ] **Step 2: Commit**

```bash
git add docs/E2E.md
git commit -m "docs: E2E smoke runbook"
```

---

## Self-review checklist

- [x] Spec coverage:
  - Audio capture (SCK + mic) → Phase 2
  - Deepgram streaming diarized → Phase 3
  - TranscriptStore persistence + ring buffer → Phase 3
  - FoundationModels classifier + fallback → Phase 4
  - Wake phrase → Phase 4
  - Auto-answer toggle + default off → Phase 4
  - Panic mute → Phase 4 (Cmd+Shift+M)
  - Claude Agent SDK session scoped to creative_studio_repo → Phase 1
  - Vision input on fire → Phase 5 (ScreenGrabber wired into FireDispatcher)
  - Manual typing → Phase 1 + Phase 5
  - Queue with max 3, drop oldest → Phase 5
  - Screen-share invisibility → Phase 6
  - Error handling per spec table → ambient (each task's failure paths wired); Phase 6 for the remaining UI banners (deferred to post-v1 polish if time)
  - Unit tests (Vitest), Swift tests (deferred), integration fixture, manual E2E → Phase 6
- [x] No `TBD`/`TODO`/`later` in plan steps
- [x] Types consistent: `ClaudeSession.ask({question, transcriptTail, imagePath, onDelta})` matches FireDispatcher call sites and IPC handlers
- [x] Each step either shows code or exact command with expected output

## Deferred to post-v1 (noted in spec Open Questions)
- Swift XCTest coverage for classifier and audio-capture binaries
- Participant consent banner
- Opus escalation
- Multi-meeting memory
- Full error-handling UI banners (currently logged via onState, not yet rendered as toasts for every row in the spec table)
