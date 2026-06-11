// src/features/ai/assistantSession.js
//
// Codex-first local assistant session. Claude Code remains as a fallback for
// moments where the local Codex CLI is missing, broken, or exits unsuccessfully.

const { CodexSession } = require('../codex/codexSession');
const { ClaudeSession } = require('../claude/claudeSession');

class AssistantSession {
    constructor({
        cwd,
        codexModel = null,
        claudeModel = null,
        codexSession = null,
        claudeSession = null,
        prefer = process.env.CLAUDELY_AI_PROVIDER || 'codex',
        allowClaudeFallback = process.env.CLAUDELY_DISABLE_CLAUDE_FALLBACK !== '1',
    } = {}) {
        this.cwd = cwd;
        this.prefer = prefer;
        this.allowClaudeFallback = allowClaudeFallback;
        this.codex = codexSession || new CodexSession({ cwd, model: codexModel || null });
        this.claude = claudeSession || new ClaudeSession({ cwd, model: claudeModel || null });
    }

    async ask({ question, transcriptTail, imagePath, onDelta, onEvent, resumeSessionId = null, isFirstAsk = true }) {
        const errors = [];

        if (this.prefer !== 'claude') {
            try {
                return await this.codex.ask({ question, transcriptTail, imagePath, onDelta, onEvent });
            } catch (error) {
                errors.push(`Codex: ${error.message}`);
                onEvent?.({
                    kind: 'provider',
                    provider: {
                        id: 'codex',
                        name: 'Codex CLI',
                        status: 'failed',
                        detail: error.message,
                    },
                });
                if (!this.allowClaudeFallback) {
                    throw new Error(errors.join('\n'));
                }
            }
        }

        try {
            const isFallback = this.prefer !== 'claude';
            return await this.claude.ask({
                question,
                transcriptTail,
                imagePath,
                resumeSessionId,
                isFirstAsk,
                onDelta,
                onEvent: (event) => {
                    if (event?.kind === 'provider' && isFallback) {
                        onEvent?.({
                            ...event,
                            provider: {
                                ...(event.provider || {}),
                                id: 'claude',
                                name: 'Claude Code',
                                status: 'fallback',
                                detail: 'Codex unavailable',
                            },
                        });
                        return;
                    }
                    onEvent?.(event);
                },
            });
        } catch (error) {
            errors.push(`Claude: ${error.message}`);
            throw new Error(errors.join('\n'));
        }
    }
}

module.exports = { AssistantSession };
