// src/features/claude/claudeSession.js
//
// @anthropic-ai/claude-agent-sdk is ESM. Electron main process is CommonJS,
// so we import lazily via dynamic import() inside ask(). Tests inject queryFn
// to bypass this entirely.

let _realQueryPromise = null;
function loadRealQuery() {
  if (!_realQueryPromise) {
    _realQueryPromise = import('@anthropic-ai/claude-agent-sdk').then((m) => m.query);
  }
  return _realQueryPromise;
}

class ClaudeSession {
  constructor({ cwd, model = 'claude-sonnet-4-6', queryFn = null }) {
    this.cwd = cwd;
    this.model = model;
    this._query = queryFn; // null means: resolve lazily from the SDK
  }

  async _getQuery() {
    if (this._query) return this._query;
    this._query = await loadRealQuery();
    return this._query;
  }

  async ask({ question, transcriptTail, imagePath, onDelta }) {
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
    const iterator = queryFn({
      prompt,
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
