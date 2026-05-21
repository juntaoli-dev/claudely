// src/features/claude/claudeSession.js
//
// @anthropic-ai/claude-agent-sdk is ESM. Electron main process is CommonJS,
// so we import lazily via dynamic import() inside ask(). Tests inject queryFn
// to bypass this entirely.

const fs = require('fs');
const cp = require('child_process');

let _realQueryPromise = null;
function loadRealQuery() {
  if (!_realQueryPromise) {
    _realQueryPromise = import('@anthropic-ai/claude-agent-sdk').then((m) => m.query);
  }
  return _realQueryPromise;
}

// Resolve the local `claude` CLI at runtime. The SDK's bundled cli.js lives
// inside the app.asar archive and can't be spawned from there (ENOTDIR), so
// the packaged app needs to explicitly hand the SDK an on-disk binary.
let _cliPathCache;
function resolveClaudeCliPath() {
  if (_cliPathCache !== undefined) return _cliPathCache;
  if (process.env.CLAUDE_CLI_PATH && fs.existsSync(process.env.CLAUDE_CLI_PATH)) {
    return (_cliPathCache = process.env.CLAUDE_CLI_PATH);
  }
  // Try `which claude` against the augmented PATH.
  try {
    const out = cp.execSync('which claude', { env: process.env, encoding: 'utf8' }).trim();
    if (out && fs.existsSync(out)) return (_cliPathCache = out);
  } catch (_) {}
  // Probe common install locations.
  const home = require('os').homedir();
  const candidates = [
    `${home}/.local/bin/claude`,
    `${home}/.bun/bin/claude`,
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ];
  for (const c of candidates) if (fs.existsSync(c)) return (_cliPathCache = c);
  return (_cliPathCache = null);
}

class ClaudeSession {
  // model: pass null/empty to inherit whatever the local `claude` CLI is
  // configured to use. Only override if you explicitly want a different model.
  constructor({ cwd, model = null, queryFn = null }) {
    this.cwd = cwd;
    this.model = model || null;
    this._query = queryFn; // null means: resolve lazily from the SDK
  }

  async _getQuery() {
    if (this._query) return this._query;
    this._query = await loadRealQuery();
    return this._query;
  }

  async ask({ question, transcriptTail, imagePath, onDelta, onEvent, resumeSessionId = null, isFirstAsk = true }) {
    if (process.env.ANTHROPIC_DRY_RUN === '1') {
      const payload = JSON.stringify({ question, transcriptTail, imagePath, resumeSessionId, isFirstAsk });
      console.log('[DRY-RUN]', payload);
      onDelta?.('[dry-run]');
      return { sessionId: resumeSessionId || 'dry-run-session' };
    }

    const parts = [];
    if (transcriptTail) {
      // Label changes meaning when we're resuming a prior session — the
      // prompt only carries the delta since the last ask, and Claude has
      // the earlier turns in its conversation state via --resume.
      const heading = isFirstAsk ? 'Meeting transcript so far' : 'New transcript since last question';
      parts.push(`${heading}:\n${transcriptTail}`);
    }
    if (imagePath) {
      parts.push(`Attached screenshot available at: ${imagePath}\n(Use the Read tool to inspect it if relevant.)`);
    }
    parts.push(`Question: ${question}`);
    const prompt = parts.join('\n\n');

    const queryFn = await this._getQuery();
    const options = {
      cwd: this.cwd,
      allowedTools: ['Read', 'Grep', 'Glob', 'Bash', 'WebFetch', 'WebSearch'],
      disallowedTools: ['Edit', 'Write', 'NotebookEdit'],
    };
    if (this.model) options.model = this.model;
    if (resumeSessionId) options.resume = resumeSessionId;
    const cli = resolveClaudeCliPath();
    if (cli) options.pathToClaudeCodeExecutable = cli;
    else console.warn('[ClaudeSession] no `claude` CLI found on disk; SDK will fall back to its bundled cli.js (likely ENOTDIR inside asar).');
    const iterator = queryFn({ prompt, options });

    // Capture session_id so the caller can pass it back on the next ask for
    // continuity. The SDK emits it on the system init message and again on
    // the final result message; whichever lands first is fine.
    let capturedSessionId = resumeSessionId || null;

    for await (const msg of iterator) {
      if (msg.type === 'system' && msg.subtype === 'init' && msg.session_id) {
        capturedSessionId = msg.session_id;
      }
      // Surface every block — tool_use, tool_result, text — as either a
      // structured event (for callers that want to render them custom) and
      // as a textual delta with an emoji marker so the existing answer pane
      // shows progress live, like Claude Code's terminal.
      if (msg.type === 'assistant' && msg.message?.content) {
        for (const block of msg.message.content) {
          if (block.type === 'text' && block.text) {
            onDelta?.(block.text);
            onEvent?.({ kind: 'text', text: block.text });
          } else if (block.type === 'tool_use') {
            // Don't pollute the answer pane with tool markers. They flow
            // through onEvent only — caller decides how to render progress.
            onEvent?.({ kind: 'tool_use', name: block.name, input: block.input, summary: summarizeToolUse(block) });
          } else if (block.type === 'thinking' && block.thinking) {
            onEvent?.({ kind: 'thinking', text: block.thinking });
          }
        }
      } else if (msg.type === 'user' && msg.message?.content) {
        for (const block of msg.message.content) {
          if (block.type === 'tool_result') {
            onEvent?.({ kind: 'tool_result', isError: !!block.is_error, summary: summarizeToolResult(block) });
          }
        }
      } else if (msg.type === 'result') {
        if (msg.session_id) capturedSessionId = msg.session_id;
        onEvent?.({ kind: 'result', subtype: msg.subtype });
      }
    }

    return { sessionId: capturedSessionId };
  }
}

function summarizeToolUse(block) {
  const name = block.name || 'Tool';
  const input = block.input || {};
  switch (name) {
    case 'Read': return `Read ${input.file_path || ''}`;
    case 'Grep': {
      const pat = input.pattern || '';
      const where = input.path ? ` in ${input.path}` : '';
      return `Grep ${JSON.stringify(pat)}${where}`;
    }
    case 'Glob': return `Glob ${input.pattern || ''}`;
    case 'Bash': {
      const cmd = (input.command || '').slice(0, 120);
      return `Bash \`${cmd}${(input.command || '').length > 120 ? '…' : ''}\``;
    }
    case 'WebFetch': return `WebFetch ${input.url || ''}`;
    default: {
      try { return `${name} ${JSON.stringify(input).slice(0, 120)}`; }
      catch { return name; }
    }
  }
}

function summarizeToolResult(block) {
  if (!block.content) return null;
  if (typeof block.content === 'string') {
    const head = block.content.split('\n')[0] || '';
    return head.length > 100 ? head.slice(0, 100) + '…' : head;
  }
  if (Array.isArray(block.content)) {
    const text = block.content.find((c) => c.type === 'text');
    if (text?.text) {
      const head = text.text.split('\n')[0] || '';
      return head.length > 100 ? head.slice(0, 100) + '…' : head;
    }
  }
  return null;
}

module.exports = { ClaudeSession };
