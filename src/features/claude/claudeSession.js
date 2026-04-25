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

  async ask({ question, transcriptTail, imagePath, onDelta }) {
    if (process.env.ANTHROPIC_DRY_RUN === '1') {
      const payload = JSON.stringify({ question, transcriptTail, imagePath });
      console.log('[DRY-RUN]', payload);
      onDelta?.('[dry-run]');
      return;
    }

    const parts = [];
    if (transcriptTail) {
      parts.push(`Recent transcript:\n${transcriptTail}`);
    }
    if (imagePath) {
      parts.push(`Attached screenshot available at: ${imagePath}\n(Use the Read tool to inspect it if relevant.)`);
    }
    parts.push(`Question: ${question}`);
    const prompt = parts.join('\n\n');

    const queryFn = await this._getQuery();
    const options = {
      cwd: this.cwd,
      allowedTools: ['Read', 'Grep', 'Glob', 'Bash', 'WebFetch'],
      disallowedTools: ['Edit', 'Write', 'NotebookEdit'],
    };
    if (this.model) options.model = this.model;
    const cli = resolveClaudeCliPath();
    if (cli) options.pathToClaudeCodeExecutable = cli;
    else console.warn('[ClaudeSession] no `claude` CLI found on disk; SDK will fall back to its bundled cli.js (likely ENOTDIR inside asar).');
    const iterator = queryFn({ prompt, options });

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
