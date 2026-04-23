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
