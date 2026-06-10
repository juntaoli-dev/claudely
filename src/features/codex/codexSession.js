// src/features/codex/codexSession.js
//
// Codex is intentionally invoked through the local CLI. Do not import or call
// OpenAI APIs here. The child process inherits the user's ChatGPT-backed Codex
// auth cache, with API-key env vars stripped so platform billing is not used.

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

let _cliPathCache;

function resolveCodexCliPath() {
    if (_cliPathCache !== undefined) return _cliPathCache;
    if (process.env.CODEX_CLI_PATH && fs.existsSync(process.env.CODEX_CLI_PATH)) {
        return (_cliPathCache = process.env.CODEX_CLI_PATH);
    }

    try {
        const out = cp.execFileSync('which', ['codex'], { env: process.env, encoding: 'utf8' }).trim();
        if (out && fs.existsSync(out)) return (_cliPathCache = out);
    } catch (_) {}

    const home = os.homedir();
    const candidates = [
        `${home}/.local/bin/codex`,
        `${home}/.bun/bin/codex`,
        '/opt/homebrew/bin/codex',
        '/usr/local/bin/codex',
    ];
    for (const c of candidates) {
        if (fs.existsSync(c)) return (_cliPathCache = c);
    }
    return (_cliPathCache = null);
}

function buildCodexEnv(baseEnv = process.env) {
    const env = { ...baseEnv };
    for (const key of [
        'OPENAI_API_KEY',
        'OPENAI_BASE_URL',
        'OPENAI_API_BASE',
        'OPENAI_ORG_ID',
        'OPENAI_PROJECT_ID',
        'AZURE_OPENAI_API_KEY',
        'AZURE_OPENAI_ENDPOINT',
    ]) {
        delete env[key];
    }
    return env;
}

function checkCodexCli(cliPath, { spawnSyncFn = cp.spawnSync, env = buildCodexEnv() } = {}) {
    if (!cliPath) return { ok: false, error: 'codex CLI not found on PATH' };
    const result = spawnSyncFn(cliPath, ['--version'], {
        env,
        encoding: 'utf8',
        timeout: 5000,
    });
    if (result.error) return { ok: false, error: result.error.message };
    if (result.status !== 0) {
        const detail = (result.stderr || result.stdout || `exit ${result.status}`).trim();
        return { ok: false, error: detail || `codex --version exited ${result.status}` };
    }
    return { ok: true, version: (result.stdout || result.stderr || '').trim() };
}

function buildPrompt({ question, transcriptTail, imagePath }) {
    const parts = [
        'You are Claudely, a repo-aware meeting assistant running inside a local desktop app.',
        'Answer the user clearly and concisely. Inspect files only when useful. Do not edit files.',
        'Use the local Codex CLI session and ChatGPT-backed Codex auth. Do not use OpenAI API keys or platform API billing.',
    ];
    if (transcriptTail) parts.push(`Recent transcript:\n${transcriptTail}`);
    if (imagePath) {
        parts.push(`Attached screenshot available at: ${imagePath}\n(Inspect it only if it matters to the answer.)`);
    }
    parts.push(`Question: ${question}`);
    return parts.join('\n\n');
}

class CodexSession {
    constructor({
        cwd,
        model = null,
        cliPath = null,
        spawnFn = cp.spawn,
        spawnSyncFn = cp.spawnSync,
        timeoutMs = 180000,
        processCwd = null,
    } = {}) {
        this.cwd = cwd || os.homedir();
        this.processCwd = processCwd || getSafeProcessCwd();
        this.model = model || null;
        this.cliPath = cliPath;
        this.spawnFn = spawnFn;
        this.spawnSyncFn = spawnSyncFn;
        this.timeoutMs = timeoutMs;
        this.sandbox = process.env.CLAUDELY_CODEX_SANDBOX || 'read-only';
    }

    async ask({ question, transcriptTail, imagePath, onDelta, onEvent }) {
        if (process.env.CODEX_DRY_RUN === '1' || process.env.CLAUDELY_AI_DRY_RUN === 'codex') {
            onEvent?.({ kind: 'provider', provider: { id: 'codex', name: 'Codex CLI', status: 'running', detail: 'dry run' } });
            onDelta?.('[codex dry-run]');
            onEvent?.({ kind: 'result', subtype: 'success' });
            return;
        }

        const cli = this.cliPath || resolveCodexCliPath();
        const env = buildCodexEnv();
        const health = checkCodexCli(cli, { spawnSyncFn: this.spawnSyncFn, env });
        if (!health.ok) throw new Error(`Codex CLI unavailable: ${health.error}`);

        onEvent?.({ kind: 'provider', provider: { id: 'codex', name: 'Codex CLI', status: 'running', detail: health.version || '' } });

        const prompt = buildPrompt({ question, transcriptTail, imagePath });
        const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudely-codex-'));
        const outputPath = path.join(outputDir, 'last-message.txt');
        const args = [
            'exec',
            '--cd', this.cwd,
            '--skip-git-repo-check',
            '--sandbox', this.sandbox,
            '--color', 'never',
            '-c', 'forced_login_method="chatgpt"',
            '-o', outputPath,
        ];
        if (this.model) args.push('--model', this.model);
        args.push(prompt);

        const { stdout, stderr } = await this._runCli(cli, args, env, onEvent);
        let text = '';
        try {
            text = fs.readFileSync(outputPath, 'utf8').trim();
        } catch (_) {
            text = stdout.trim();
        } finally {
            try { fs.rmSync(outputDir, { recursive: true, force: true }); } catch (_) {}
        }
        if (!text) {
            const detail = stderr.trim().split('\n').slice(-6).join('\n');
            throw new Error(detail || 'Codex CLI returned no answer');
        }
        onDelta?.(text);
        onEvent?.({ kind: 'result', subtype: 'success' });
    }

    _runCli(cli, args, env, onEvent) {
        return new Promise((resolve, reject) => {
            let stdout = '';
            let stderr = '';
            let settled = false;
            let stderrBuffer = '';
            const seenProgress = new Set();

            const child = this.spawnFn(cli, args, {
                cwd: this.processCwd,
                env,
                stdio: ['ignore', 'pipe', 'pipe'],
            });

            const finish = (fn, value) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                fn(value);
            };

            const timer = setTimeout(() => {
                try { child.kill('SIGTERM'); } catch (_) {}
                finish(reject, new Error(`Codex CLI timed out after ${Math.round(this.timeoutMs / 1000)}s`));
            }, this.timeoutMs);

            child.stdout?.on('data', (chunk) => {
                stdout += chunk.toString();
            });

            child.stderr?.on('data', (chunk) => {
                const text = chunk.toString();
                stderr += text;
                stderrBuffer += text;
                const lines = stderrBuffer.split(/\r?\n/);
                stderrBuffer = lines.pop() || '';
                for (const raw of lines) {
                    const summary = summarizeCodexProgress(raw);
                    if (!summary || seenProgress.has(summary)) continue;
                    seenProgress.add(summary);
                    if (seenProgress.size > 8) {
                        const first = seenProgress.values().next().value;
                        seenProgress.delete(first);
                    }
                    onEvent?.({ kind: 'tool_use', name: 'Codex', summary });
                }
            });

            child.on('error', (error) => finish(reject, error));
            child.on('close', (code, signal) => {
                if (code === 0) {
                    finish(resolve, { stdout, stderr });
                    return;
                }
                const tail = stderr.trim().split('\n').slice(-10).join('\n');
                finish(reject, new Error(tail || `Codex CLI exited ${code ?? signal}`));
            });
        });
    }
}

function getSafeProcessCwd() {
    const candidates = [process.cwd?.(), os.homedir(), os.tmpdir()];
    for (const candidate of candidates) {
        if (candidate && fs.existsSync(candidate)) return candidate;
    }
    return undefined;
}

function summarizeCodexProgress(line) {
    const clean = String(line || '').replace(/\x1b\[[0-9;]*m/g, '').trim();
    if (!clean) return '';
    if (/^(error|failed|warning):/i.test(clean)) return clean.slice(0, 140);
    if (/^(thinking|running|reading|searching|executing|codex)/i.test(clean)) return clean.slice(0, 140);
    return '';
}

module.exports = {
    CodexSession,
    buildCodexEnv,
    checkCodexCli,
    resolveCodexCliPath,
};
