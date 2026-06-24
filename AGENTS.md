# Claudely — agent rules

This file is auto-loaded at the start of every Codex session in this repo.
Read every line. The rules in this file override default agent behavior.

## ⛔ Hard stop: never return with "want me to build / test?"

Do not ask the user "should I rebuild?", "want me to run it?", "should I test?"
on any change to shipping code. If you changed Swift, JS, IPC, or build paths,
the build + e2e run is part of your turn, not a follow-up offer. Returning
without verification is the same as returning a broken change.

Only acceptable end-of-turn messages for a shipping-code change:
1. "Fix verified end-to-end. Logs / screenshot below." (success)
2. "E2E failed at <step>. Here is what I see, here is the next move." (honest)
3. "E2E genuinely impossible for this change because <specific reason>." (rare)

Anything else is a regression in agent discipline.

## E2E test before returning to the prompter (non-negotiable)

Whenever you change anything that ships to the user (renderer JS, main-process
JS, Swift in `native/`, IPC contracts, window plumbing, build/asset paths),
**you must end-to-end test the running app via computer-use before declaring
the change done**.

Also read and obey `CODEX.md`. It contains the packaged-app install gate for
this repo. Dev-shell e2e alone is not enough for shipping-code changes.

Concretely:

1. Build whatever needs building. At minimum:
   - JS-only changes → `npm run build:renderer`
   - Swift changes → `npm run build:native` (or the targeted `swiftc` line for
     the affected helper) **and** copy the resulting binary to
     `src/ui/assets/bin/<name>` so the dev shell picks it up.
2. Relaunch the dev shell — kill any running `Claudely` process, then
   `npm start`. The packaged `/Applications/Claudely.app` will NOT pick up
   uncommitted source changes; only the dev shell does.
3. Exercise the changed code path against the running dev shell. The bar is
   "real keystrokes/clicks against the real running app", not "the code looks
   right" or "unit tests pass".

   **Architecture caveat for THIS app**: the windows use
   `LSUIElement: true` + transparent borderless frames, so they don't appear
   in the Accessibility tree or in `mcp__computer-use__request_access`'s
   installed-apps snapshot. That means:
   - `mcp__computer-use__*` tools cannot grant Claudely and cannot click its
     pill UI directly. Don't waste cycles fighting this — the constraint is
     in the app, not the tooling.
   - `osascript` against `process "Electron"` works for the **menu bar app
     menu** (Quit, Hide), but `windows of process "Electron"` returns empty
     because the transparent frames aren't surfaced.
   - Default e2e harness for this repo: spawn the dev shell with
     `nohup npx electron . > /tmp/claudely-dev.log 2>&1 &`, exercise the
     changed path via whatever the architecture allows (auto-Listen kicks in
     on launch; menu-bar Quit triggers shutdown; killing the Swift child via
     `pkill -f audio-capture` simulates `capture-exit`; killing the target
     bundle via `pkill -f us.zoom.xos` triggers the source-quit code path),
     then verify outcome via:
     - `tail /tmp/claudely-dev.log` for the expected log markers
     - `ps aux | grep -E 'electron|audio-capture|classifier'` for zombie
       helpers, runaway CPU, leaked timers
     - `screencapture -x /tmp/state.png && Read /tmp/state.png` for visual
       confirmation when there IS something rendered (insights bubble,
       transcript pill).

4. Verify the path your change touches actually behaves correctly end to end.
   For Listen-pipeline changes that means: launch dev shell → confirm
   `[sttService] Deepgram live channels=2` appears → confirm
   `INFO: capture started` + mic callbacks ramp → exercise the path you
   changed → quit and confirm `[Shutdown] Graceful shutdown completed
   successfully` (or `[Shutdown] already in progress, allowing quit` on
   second SIGTERM) with no orphan `audio-capture` / `classifier` left in
   `ps`.
5. Capture a final screenshot of any visible UI and reference it in your
   turn-summary so the user can spot-check.

## Packaged app install gate (non-negotiable)

After the dev-shell e2e passes for any shipping-code change, finish the job by
packaging, installing, and testing the installed Spotlight app.

Concretely:

1. Run `npm test` and keep it green.
2. Run `npm run package`.
3. Replace `/Applications/Claudely.app` with the freshly built app from
   `dist/mac-arm64/Claudely.app` (or the current mac output directory if the
   builder changes). Back up the previous installed app first under `/tmp/`.
4. Verify the installed app signature:
   `codesign --verify --deep --strict /Applications/Claudely.app`.
5. Refresh Launch Services:
   `/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f /Applications/Claudely.app`.
6. Smoke-test the installed bundle, not only the dev shell. Use
   `/Applications/Claudely.app/Contents/MacOS/Claudely` for log capture and
   `open -a Claudely` for the same launch path as Cmd+Space / Spotlight.
7. Exercise the changed path again in the installed app. For AI-provider
   changes, disable fallback when appropriate so the test proves the intended
   provider actually handled the request.
8. Quit the installed app and verify no `Claudely`, `audio-capture`, or
   `classifier` processes remain.

End-of-turn summaries for shipping-code changes must say both of these, or
explain exactly where verification failed:

- Dev-shell e2e passed.
- Installed `/Applications/Claudely.app` e2e passed.

## GitHub push gate (non-negotiable)

The user runs this project from multiple places and expects GitHub to be the
source of truth. This is a solo-dev project: NEVER open a pull request, not
even a draft. Do not create a feature branch for normal work. After any
verified code, docs, build, or app-behavior change:

1. Commit the intended repo changes directly on `main`.
2. Push `main` to `origin` before returning.
3. Never end with local-only changes unless pushing is genuinely impossible;
   in that case, say exactly why and what command failed.

Future task to investigate (do not ignore in passing): the supervisor's
auto-restart in `listenService.handleListenRequest`'s `capture-exit` branch
fires *during* graceful shutdown when `app.on('before-quit')` kills the
Swift child. The restart races with shutdown teardown. Not part of the
long-session CPU fix but worth gating on a `this._shuttingDown` flag.

If the e2e test fails, the change is not done — debug and fix, do not return
to the prompter with "should work" energy.

If e2e is genuinely impossible for a given change (example: a CI-only file
the user agrees doesn't need a runtime check), say so explicitly in the same
turn instead of silently skipping.

## Read these files at session start

- This file (`AGENTS.md`).
- `CODEX.md` if it exists.
- `HANDOFF.md` if it exists — it's where in-progress context gets parked
  between sessions.
- `package.json` scripts — the build/test commands change as the project
  evolves; don't assume.

## Build pointers

- Main JS bundling: `node build.js` (esbuild). `npm run build:renderer`.
- Swift helpers live in `native/audio-capture` and `native/classifier`. Both
  rebuild via `npm run build:native`. The script writes outputs to
  `<helper>/.build/release/<helper>`; `build.js` then copies them to
  `src/ui/assets/bin/`. After a manual `swiftc` you must do that copy
  yourself.
- `npm start` runs the dev shell (renderer build + electron .). This is what
  you e2e test against, not the packaged `.app`.
- `npm test` runs vitest. Always green before declaring done.

## Performance / long-session discipline

The app sits open for hours during meetings. A 1Hz timer that fires
`requestUpdate()` overnight is 28k wasted Lit diffs. Rules:

- Every `setInterval` / `setTimeout` you add must have a paired clear in the
  matching teardown path (`stopCapture`, `disconnectedCallback`,
  session-state-changed off, etc).
- Renderer timers should bail when `document.hidden`.
- Stats / heartbeat IPC from main → renderer should suppress when the
  underlying signal hasn't changed; emit a single "stalled" tick on a slow
  cadence rather than chattering at 2Hz against a dormant pipeline.
- Long-running native helpers (audio-capture, classifier) should detect
  "their reason for existing went away" (target app quit, no audio for N
  minutes) and exit cleanly rather than spin. The JS supervisor should
  recognize the sentinel exit code and end the session instead of
  auto-restarting.

## Project context

- Personal solo-dev project. No tickets, no PR review process. Ship.
- The app is an Electron + Lit renderer + Swift native helpers stack. The
  Listen pipeline: Swift `audio-capture` (SCK + AVCaptureSession) → stdout
  framed PCM → JS `AudioBus` → Deepgram live → renderer `SttView`.
- A dispatcher (`buildDispatcher` in `src/features/fire/instance.js`) fires
  Codex on wake-phrases or classifier verdicts.
