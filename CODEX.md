# Claudely Codex Runbook

This repo is a desktop app, so a source build is not enough. Future Codex work
must prove that the app the user launches from Cmd+Space is also current.

## Required Gate For App Dev Changes

For every app development task that changes renderer JS, main-process JS,
Swift helpers, IPC contracts, window plumbing, build files, asset paths,
packaging behavior, or anything else that ships to the user, do all of this
before returning. This is not only for releases. It is required for normal
local development too, because the user opens `/Applications/Claudely.app`
from Cmd+Space.

1. Run the normal tests.
   - `npm test`
2. Build the code needed by the dev shell.
   - JS-only: `npm run build:renderer`
   - Swift/native or broad changes: `npm run build:all` or `npm run package`
3. Run the dev shell and exercise the changed path end to end.
   - Use `npm start` or `npx electron .`.
   - Confirm expected log markers.
   - Capture a screenshot when UI is visible.
   - Confirm no orphan helpers after quit.
4. Package the app.
   - `npm run package`
5. Install the packaged app over the Spotlight app.
   - Back up `/Applications/Claudely.app` to `/tmp/Claudely.app.before-install.<timestamp>`.
   - Replace it with the freshly built app, usually `dist/mac-arm64/Claudely.app`.
   - Run `codesign --verify --deep --strict /Applications/Claudely.app`.
   - Run `/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f /Applications/Claudely.app`.
6. Test the installed app.
   - Run `/Applications/Claudely.app/Contents/MacOS/Claudely` when logs matter.
   - Run `open -a Claudely` to verify the Cmd+Space / Spotlight launch path.
   - Exercise the changed path again.
   - For AI-provider changes, disable fallback when useful so the intended
     provider is proven directly.
   - Quit and verify no `Claudely`, `audio-capture`, or `classifier` processes remain.

## Final Response Rule

For shipping-code changes, the final response must explicitly state:

- `npm test` result.
- Dev-shell e2e result.
- `npm run package` result.
- Installed `/Applications/Claudely.app` e2e result.
- Any screenshot path used for visual confirmation.

If any gate fails, say where it failed and what the next move is. Do not end
with an offer to test, rebuild, package, or install later.
