'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_STDOUT_BYTES = 2 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;

function unpackedPath(value) {
    return typeof value === 'string' ? value.replace(/app\.asar(?![\w.])/u, 'app.asar.unpacked') : value;
}

function isUsableFile(filePath) {
    if (!filePath) return false;
    try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) return false;
        if (process.platform !== 'win32') {
            try {
                fs.accessSync(filePath, fs.constants.X_OK);
            } catch {
                fs.chmodSync(filePath, 0o755);
                fs.accessSync(filePath, fs.constants.X_OK);
            }
        }
        return true;
    } catch {
        return false;
    }
}

function fpcalcCandidates(options = {}) {
    const environment = options.env || process.env;
    const platform = options.platform || process.platform;
    const arch = options.arch || process.arch;
    const moduleDirectory = options.moduleDirectory || __dirname;
    const executableName = platform === 'win32' ? 'fpcalc.exe' : 'fpcalc';
    const candidates = [];
    if (environment.FPCALC_PATH) {
        candidates.push({ source: 'environment', executable: path.resolve(String(environment.FPCALC_PATH)) });
    }
    candidates.push({
        source: 'bundled',
        executable: unpackedPath(path.resolve(moduleDirectory, '..', 'vendor', 'fpcalc', `${platform}-${arch}`, executableName))
    });
    if (platform === 'win32' && arch === 'arm64') {
        candidates.push({
            source: 'bundled-x64-emulation',
            executable: unpackedPath(path.resolve(moduleDirectory, '..', 'vendor', 'fpcalc', 'win32-x64', executableName))
        });
    }
    candidates.push({ source: 'path', executable: executableName });
    return candidates;
}

function resolveFpcalc(options = {}) {
    const candidates = fpcalcCandidates(options);
    for (const candidate of candidates) {
        if (candidate.source === 'path' || isUsableFile(candidate.executable)) return candidate;
    }
    return candidates[candidates.length - 1];
}

function safeErrorStatus(error, timedOut, outputExceeded, cancelled) {
    if (cancelled || (error && error.name === 'AbortError')) return { status: 'cancelled', reason: 'cancelled' };
    if (timedOut) return { status: 'timeout', reason: 'timeout' };
    if (outputExceeded) return { status: 'error', reason: 'output_limit' };
    if (error && (error.code === 'ENOENT' || error.code === 'EACCES' || error.code === 'EPERM')) {
        return { status: 'unavailable', reason: 'fpcalc_not_found' };
    }
    return { status: 'error', reason: 'fpcalc_failed' };
}

function parseFpcalcOutput(stdout) {
    const text = String(stdout || '').trim();
    if (!text) return null;
    try {
        const parsed = JSON.parse(text);
        const duration = Number(parsed.duration);
        const fingerprint = typeof parsed.fingerprint === 'string' ? parsed.fingerprint.trim() : '';
        if (!fingerprint || !(duration > 0)) return null;
        return { fingerprint, duration: Math.round(duration) };
    } catch {
        const durationMatch = /^DURATION=(\d+(?:\.\d+)?)$/mu.exec(text);
        const fingerprintMatch = /^FINGERPRINT=(.+)$/mu.exec(text);
        if (!durationMatch || !fingerprintMatch) return null;
        const duration = Number(durationMatch[1]);
        const fingerprint = fingerprintMatch[1].trim();
        return fingerprint && duration > 0 ? { fingerprint, duration: Math.round(duration) } : null;
    }
}

async function generateFingerprint(filePath, options = {}) {
    const signal = options.signal;
    if (signal && signal.aborted) return { status: 'cancelled', reason: 'cancelled' };
    if (!filePath || typeof filePath !== 'string') return { status: 'invalid_input', reason: 'missing_file' };

    const absoluteFilePath = path.resolve(filePath);
    let stat;
    try {
        stat = await fs.promises.stat(absoluteFilePath);
    } catch {
        return { status: 'unavailable', reason: 'file_unavailable' };
    }
    if (!stat.isFile()) return { status: 'invalid_input', reason: 'not_a_file' };

    const resolver = options.resolver || resolveFpcalc;
    const resolved = resolver(options);
    if (!resolved || !resolved.executable) return { status: 'unavailable', reason: 'fpcalc_not_found' };
    const timeoutMs = Math.max(1000, Math.min(Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS, 120_000));
    const sampleLengthSeconds = Math.max(30, Math.min(Number(options.sampleLengthSeconds) || 120, 600));
    const args = ['-json', '-length', String(Math.round(sampleLengthSeconds)), absoluteFilePath];

    return await new Promise((resolve) => {
        let settled = false;
        let timedOut = false;
        let outputExceeded = false;
        let cancelled = false;
        let stdoutBytes = 0;
        let stderrBytes = 0;
        const stdout = [];
        let timer = null;
        let onAbort = () => {};

        const finish = (result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (signal) signal.removeEventListener('abort', onAbort);
            resolve(result);
        };
        const terminate = (child) => {
            try { child.kill('SIGKILL'); } catch { /* process already exited */ }
        };

        let child;
        try {
            child = spawn(resolved.executable, args, {
                shell: false,
                windowsHide: true,
                stdio: ['ignore', 'pipe', 'pipe']
            });
        } catch (error) {
            finish(safeErrorStatus(error, false, false, false));
            return;
        }

        timer = setTimeout(() => {
            timedOut = true;
            terminate(child);
        }, timeoutMs);
        timer.unref?.();

        onAbort = () => {
            cancelled = true;
            terminate(child);
        };
        if (signal) signal.addEventListener('abort', onAbort, { once: true });

        child.stdout.on('data', chunk => {
            stdoutBytes += chunk.length;
            if (stdoutBytes > MAX_STDOUT_BYTES) {
                outputExceeded = true;
                terminate(child);
                return;
            }
            stdout.push(chunk);
        });
        child.stderr.on('data', chunk => {
            stderrBytes += chunk.length;
            if (stderrBytes > MAX_STDERR_BYTES) {
                outputExceeded = true;
                terminate(child);
            }
        });
        child.on('error', error => finish(safeErrorStatus(error, timedOut, outputExceeded, cancelled)));
        child.on('close', code => {
            if (cancelled || timedOut || outputExceeded || code !== 0) {
                finish(safeErrorStatus(null, timedOut, outputExceeded, cancelled));
                return;
            }
            const parsed = parseFpcalcOutput(Buffer.concat(stdout).toString('utf8'));
            if (!parsed) {
                finish({ status: 'error', reason: 'invalid_output' });
                return;
            }
            finish({
                status: 'ok',
                fingerprint: parsed.fingerprint,
                duration: parsed.duration,
                durationMs: parsed.duration * 1000,
                source: resolved.source
            });
        });
    });
}

module.exports = {
    resolveFpcalc,
    generateFingerprint,
    _test: {
        unpackedPath,
        isUsableFile,
        fpcalcCandidates,
        parseFpcalcOutput,
        safeErrorStatus
    }
};
