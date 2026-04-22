# Claudely Build Handoff

You are picking up a project that has been scoped and planned but not yet implemented. A previous assistant wrote a design spec and a bite-sized implementation plan. Your job is to execute the plan end to end on this macOS laptop. You have Computer Use, so you can click through System Settings dialogs, launch Zoom for smoke tests, and drive the UI during verification.

## The three files to read first, in order

1. `/Users/juntaoli/Documents/GitHub/Claudely/docs/superpowers/specs/2026-04-22-claudely-design.md` - the design spec. Read the whole thing.
2. `/Users/juntaoli/Documents/GitHub/Claudely/docs/superpowers/plans/2026-04-22-claudely-impl.md` - the implementation plan. Every phase, every task, every step.
3. `/Users/juntaoli/.claude/CLAUDE.md` - the user's global Claude Code config. Tells you about the Alli workspace repos, the `uv` Python stack, PR rules, and the CI-clean checklist. Pay attention to the "Workspace repos" section, since Claudely's runtime `cwd` points at `~/Documents/creative_studio_repo/` which contains those repos.

Do not skim. The plan has exact file paths, exact test code, exact commit messages. Your job is to execute, not to redesign.

## What already exists

- Git repo at `/Users/juntaoli/Documents/GitHub/Claudely/` with three commits on `main`:
  - `6c34229 design: Claudely meeting assistant spec`
  - `c85646e design: tighten transcript overflow, cwd scope, diarization channels`
  - `1938c85 plan: Claudely implementation plan`
- No source code yet. No remote. No worktree. You will start from Phase 0 Task 0.1 of the plan (forking Glass into this repo).
- A scratch Glass clone exists at `/tmp/glass-inspect/`. You may reuse or ignore. The plan tells you to `rm -rf /tmp/glass-src` then re-clone fresh, do that, don't rely on `/tmp/glass-inspect`.

## Goal in one sentence

Ship a macOS overlay app called Claudely that captures Zoom audio, transcribes with Deepgram, detects repo-aware questions with Apple FoundationModels, and answers them via the Claude Agent SDK pinned to `~/Documents/creative_studio_repo/`, with a Cluely-style floating UI forked from `pickle-com/glass`.

## The user

- Name: Juntao Li, email `juntao.li@pmg.com`.
- Backend/full-stack engineer on the Alli Creative Studio product at PMG.
- Uses `uv` for all Python, pytest, ruff. Uses npm for node. Has `aws-vault` profile `creativeinsights` for staging probes (not relevant here but don't be surprised).
- Has an Anthropic Enterprise subscription, so the `claude` CLI on this machine has an active OAuth session at `~/.claude/.credentials.json`. The Claude Agent SDK will inherit that auth automatically when `ANTHROPIC_API_KEY` is unset. This is critical: do not set `ANTHROPIC_API_KEY` in this project, do not ask the user for an API key. Enterprise auth is the billing path.
- Never uses em-dashes in prose. Keep comments and docs dash-free.

## Environment facts you need

- macOS latest (14.4+ at minimum, 15+ is needed for FoundationModels, which is assumed).
- `claude --version` works. Don't run `claude login`, the session is already valid.
- Node, npm, Xcode command-line tools are installed. `swift --version` works.
- `~/Documents/creative_studio_repo/` exists and contains `alli-creativestudio-backend`, `alli-frontend-creativestudio`, `alli-infrastructure-creativestudio`, and a couple of solutions repos. Claudely reads from this folder, never writes to it.
- Zoom is installed. Bundle id `us.zoom.xos`.
- `DEEPGRAM_API_KEY` is not yet set. Before any live smoke test, ask the user for a Deepgram API key and either have them export it or write it into `~/.config/claudely/config.json` after Phase 4 lands the config schema.

## Execution model

Follow the plan task by task, top to bottom. For each task:

1. Read the task block in the plan, including the file paths and the exact code in each step.
2. Use TDD: write the failing test first where the plan includes one, run it, confirm it fails, then write the implementation, run it, confirm it passes. Do not skip the fail-first step, the user cares about discipline here.
3. Commit after every task with the commit message the plan specifies, verbatim. Do not add `Co-Authored-By` lines, the user's global config forbids it unless asked.
4. Never `git push`, never create a remote, never force-push. The user's PR workflow rule: always ask explicit approval before pushing. There is no remote configured anyway.
5. If a step requires a macOS permission dialog (Screen Recording, Microphone, Accessibility), use Computer Use to click through. The system will show a prompt when Electron first tries to capture, you click Allow, then restart the app.
6. If a step requires running a live Zoom meeting (Phase 3 Step 8, Phase 5 Step 4, Phase 6 Task 6.1 Step 2, Phase 6 Task 6.3 whole runbook), stop and coordinate with the user. You can start Zoom with `open -a zoom.us` and join a personal test meeting, but the user needs to confirm they can hear and see what you're doing. Dictating sample utterances into a Zoom call is easier if you ask the user to speak, since you cannot produce voice.
7. After each task, before moving to the next:
   - Run `npm test` if any tests were added.
   - Run `npm run build:renderer` (Phase 0 on) or `npm run build:all` (Phase 2 on) to confirm no broken imports.
   - Check `git status`, `git log --oneline` to confirm the commit landed.
8. Phase boundaries are natural checkpoints. After finishing Phase 0, tell the user, wait for them to say continue, then start Phase 1. Same for each phase.

## Pause points where you must ask the user

- After Phase 0: confirm the Glass fork starts (`npm start` opens the overlay) before proceeding.
- Before Phase 2 Step 4 builds run: confirm Xcode command-line tools present, ask if you should `sudo xcode-select --install` if not.
- First time any Swift binary runs: macOS will show Screen Recording / Microphone TCC dialogs. Coordinate the click.
- Phase 3 Step 8: you need `DEEPGRAM_API_KEY`. Ask.
- Phase 4 Task 4.2 manual smoke: FoundationModels needs Apple Intelligence enabled. If it emits `ERR: model-unavailable`, ask the user to enable Apple Intelligence in System Settings, or note the regex fallback is in effect and proceed.
- Phase 5 Task 5.3 Step 4: a live Zoom smoke test. Ask the user to start a Zoom test meeting and read a test utterance.
- Phase 6 Task 6.1 Step 2: invisibility test requires sharing screen in Zoom. Ask the user to start a share to their own device to verify.

## Non-negotiables

- Do not push to any remote. None is configured. Do not add one.
- Do not modify anything under `~/Documents/creative_studio_repo/`. The Agent SDK session is configured with `Read, Grep, Glob, Bash(fd *), WebFetch` and explicitly disallows `Edit, Write, NotebookEdit`. During smoke testing, if you find yourself touching those files, stop.
- Do not change the plan unilaterally. If a step is impossible or wrong, tell the user and propose an edit to the plan file. Do not silently implement a different approach.
- Do not skip tests. If a test the plan specifies is failing and you cannot figure out why, escalate to the user with the error message.
- Do not commit `.env` files, `~/.claude/.credentials.json`, or any Deepgram keys. The `.gitignore` handles `scratch/` and `native/*/.build/`, but audit before every commit.
- Commit messages are the ones in the plan, verbatim. The user's commit style is `ALLI-XXXXX <subject>` for work tickets, but this repo is personal so plain subjects are fine, matching what the plan specifies.
- Use tabs or spaces consistent with the file you are editing. Glass uses 4-space indents in JS. Stay consistent.
- No em-dashes. Use commas, periods, or parentheses.

## Tools and skills assumed on your side

- Computer Use: yes, you can click System Settings, drag windows, type in dialogs.
- Filesystem read/write: yes, through your normal tools.
- Shell: yes, run `npm`, `swift`, `git`, `node`, `open`.
- Network: yes, for `npm install`, `git clone`, and live Deepgram / Claude SDK calls during smoke tests.
- No: do not dispatch further subagents. Execute inline. The plan is already decomposed task by task.

## First action

1. Read the three files listed at the top.
2. Run `git -C /Users/juntaoli/Documents/GitHub/Claudely log --oneline` to confirm the starting state matches what this handoff says.
3. Announce the first task to the user: "Starting Phase 0 Task 0.1: Fork Glass and rename."
4. Execute Task 0.1 steps 1 through 5 in order. Report back after the commit.

## When you are done with everything

- Run the full E2E runbook at `docs/E2E.md` (created in Phase 6 Task 6.3) with the user present.
- Ask the user if they want to set up a remote (`gh repo create`), open a PR on the first branch, or leave it local.
- Do not do any of those without explicit approval.

Good luck. The plan is good. Follow it.
