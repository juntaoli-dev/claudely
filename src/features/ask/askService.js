const { BrowserWindow } = require('electron');
const getWindowManager = () => require('../../window/windowManager');
const internalBridge = require('../../bridge/internalBridge');
const sessionRepository = require('../common/repositories/session');
const askRepository = require('./repositories');
const { AssistantSession } = require('../ai/assistantSession');
const contextService = require('../context/contextService');

const getWindowPool = () => {
    try {
        return getWindowManager().windowPool;
    } catch {
        return null;
    }
};

let sharedSession;
let sharedSessionCwd;
function getSession() {
    const context = contextService.getActiveContext();
    if (!sharedSession || sharedSessionCwd !== context.cwd) {
        sharedSessionCwd = context.cwd;
        sharedSession = new AssistantSession({
            cwd: context.cwd,
            codexModel: process.env.CLAUDELY_CODEX_MODEL || null,
            claudeModel: process.env.CLAUDELY_CLAUDE_MODEL || process.env.CLAUDELY_MODEL || 'claude-sonnet-4-6',
        });
    }
    return sharedSession;
}

contextService.on('changed', () => {
    sharedSession = null;
    sharedSessionCwd = null;
});

// Plan-shape API. Consumed by featureBridge ask:question handler and Phase 5 FireDispatcher.
async function ask({ question, transcriptTail = '', imagePath = null, onDelta }) {
    return getSession().ask({ question, transcriptTail, imagePath, onDelta });
}

class AskService {
    constructor() {
        this.abortController = null;
        this.state = {
            isVisible: false,
            isLoading: false,
            isStreaming: false,
            currentQuestion: '',
            currentResponse: '',
            messages: [],
            aiProvider: { id: 'codex', name: 'Codex CLI', status: 'ready' },
            codeContext: contextService.getActiveContext(),
            showTextInput: true,
        };
        contextService.on('changed', ({ active }) => {
            this.state = {
                ...this.state,
                codeContext: active,
                aiProvider: {
                    ...(this.state.aiProvider || { id: 'codex', name: 'Codex CLI' }),
                    status: 'ready',
                    detail: `Code context: ${active.cwd}`,
                },
            };
            this._broadcastState();
        });
        console.log('[AskService] Service instance created.');
    }

    _broadcastState() {
        const askWindow = getWindowPool()?.get('ask');
        if (askWindow && !askWindow.isDestroyed()) {
            askWindow.webContents.send('ask:stateUpdate', this.state);
        }
    }

    async toggleAskButton(inputScreenOnly = false) {
        const askWindow = getWindowPool()?.get('ask');

        if (inputScreenOnly && this.state.showTextInput && askWindow && askWindow.isVisible()) {
            await this.sendMessage('', []);
            return;
        }

        const hasContent = this.state.isLoading || this.state.isStreaming || (this.state.currentResponse && this.state.currentResponse.length > 0);

        if (askWindow && askWindow.isVisible() && hasContent) {
            this.state.showTextInput = !this.state.showTextInput;
            this._broadcastState();
        } else {
            if (askWindow && askWindow.isVisible()) {
                internalBridge.emit('window:requestVisibility', { name: 'ask', visible: false });
                this.state.isVisible = false;
            } else {
                internalBridge.emit('window:requestVisibility', { name: 'ask', visible: true });
                this.state.isVisible = true;
            }
            if (this.state.isVisible) {
                this.state.showTextInput = true;
                this._broadcastState();
            }
        }
    }

    async closeAskWindow() {
        if (this.abortController) {
            this.abortController.abort('Window closed by user');
            this.abortController = null;
        }

        this.state = {
            isVisible: false,
            isLoading: false,
            isStreaming: false,
            currentQuestion: '',
            currentResponse: '',
            messages: [],
            aiProvider: { id: 'codex', name: 'Codex CLI', status: 'ready' },
            codeContext: contextService.getActiveContext(),
            showTextInput: true,
        };
        this._broadcastState();

        internalBridge.emit('window:requestVisibility', { name: 'ask', visible: false });

        return { success: true };
    }

    async sendMessage(userPrompt, _conversationHistoryRaw = []) {
        const question = (userPrompt || '').trim();
        if (!question) return { success: true };

        internalBridge.emit('window:requestVisibility', { name: 'ask', visible: true });
        const codeContext = contextService.getActiveContext();
        this.state = {
            ...this.state,
            isVisible: true,
            isLoading: true,
            isStreaming: false,
            currentQuestion: question,
            currentResponse: '',
            messages: [
                ...(this.state.messages || []),
                { id: `u-${Date.now()}`, role: 'user', content: question },
                { id: `a-${Date.now()}`, role: 'assistant', content: '', provider: this.state.aiProvider, codeContext },
            ],
            aiProvider: { id: 'codex', name: 'Codex CLI', status: 'starting', detail: `Code context: ${codeContext.cwd}` },
            codeContext,
            showTextInput: false,
        };
        this._broadcastState();

        let sessionId;
        try {
            sessionId = await sessionRepository.getOrCreateActive('ask');
            await askRepository.addAiMessage({ sessionId, role: 'user', content: question });
        } catch (e) {
            console.warn('[AskService] Could not persist prompt:', e.message);
        }

        // Route through the manual FireDispatcher so manual asks share the
        // same queue as auto-answer + wake-phrase fires and take a screenshot
        // by default (spec's FireDispatcher manual path).
        const { getManualDispatcher } = require('../fire/instance');
        return await new Promise((resolve) => {
            let full = '';
            let resolved = false;
            const finish = (ok, errorMsg) => {
                if (resolved) return;
                resolved = true;
                this.state.isLoading = false;
                this.state.isStreaming = false;
                this.state.showTextInput = true;
                this._updateLastAssistant({ status: ok ? 'done' : 'error' });
                this._broadcastState();
                if (ok && sessionId && full) {
                    askRepository.addAiMessage({ sessionId, role: 'assistant', content: full }).catch((e) => {
                        console.warn('[AskService] Could not persist assistant reply:', e.message);
                    });
                }
                if (!ok) {
                    // Surface the error in the answer pane so users see *why*
                    // it failed instead of an empty result.
                    this.state.currentResponse = `error: ${errorMsg || 'unknown'}`;
                    this._updateLastAssistant({ content: this.state.currentResponse, status: 'error' });
                    this._broadcastState();
                    const askWin = getWindowPool()?.get('ask');
                    if (askWin && !askWin.isDestroyed()) {
                        askWin.webContents.send('ask-response-stream-error', { error: errorMsg });
                    }
                }
                resolve(ok ? { success: true } : { success: false, error: errorMsg });
            };

            const toolLines = [];
            const dispatcher = getManualDispatcher({
                onState: (s) => {
                    if (s.type === 'provider') {
                        this.state.aiProvider = s.provider || this.state.aiProvider;
                        this._updateLastAssistant({ provider: this.state.aiProvider, codeContext: this.state.codeContext });
                        this._broadcastState();
                    } else if (s.type === 'thinking') {
                        this.state.isLoading = true;
                        this.state.isStreaming = false;
                        this.state.toolProgress = '';
                        this._broadcastState();
                    } else if (s.type === 'tool') {
                        toolLines.push(`🔧 ${s.summary}`);
                        // keep last 6 lines so the badge doesn't grow forever.
                        if (toolLines.length > 6) toolLines.shift();
                        this.state.toolProgress = toolLines.join('\n');
                        this._broadcastState();
                    } else if (s.type === 'tool-done') {
                        if (s.summary) {
                            toolLines.push(`✓ ${s.summary}`);
                            if (toolLines.length > 6) toolLines.shift();
                            this.state.toolProgress = toolLines.join('\n');
                            this._broadcastState();
                        }
                    } else if (s.type === 'delta') {
                        full += s.text;
                        this.state.isLoading = false;
                        this.state.isStreaming = true;
                        this.state.currentResponse = full;
                        this._updateLastAssistant({
                            content: full,
                            status: 'streaming',
                            provider: this.state.aiProvider,
                        });
                        this._broadcastState();
                    } else if (s.type === 'done') {
                        finish(true);
                    } else if (s.type === 'error') {
                        finish(false, s.error || 'unknown error');
                    }
                },
            });
            dispatcher.manualFire({ question }).catch((e) => finish(false, e.message));
        });
    }
}

AskService.prototype._updateLastAssistant = function _updateLastAssistant(patch) {
    const messages = [...(this.state.messages || [])];
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'assistant') {
            messages[i] = { ...messages[i], ...patch };
            this.state.messages = messages;
            return;
        }
    }
};

const askService = new AskService();

module.exports = askService;
module.exports.ask = ask;
module.exports.sendMessage = askService.sendMessage.bind(askService);
module.exports.toggleAskButton = askService.toggleAskButton.bind(askService);
module.exports.closeAskWindow = askService.closeAskWindow.bind(askService);
