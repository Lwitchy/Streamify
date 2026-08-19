/**
 * Manual security checks for the download feature.
 *
 * Run with:  node Tests/downloadSecurity.manual.js
 *
 * Phase 1 saves Soulseek credentials, then a CHILD process boots the server
 * fresh. The distinction matters: initializeConfig() bulk-loads every
 * system_config row into app.locals.config on startup, so a credential leak
 * only appears after a restart, not in the process that wrote it.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const { execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const PASSWORD = 'SUPERSECRET-slsk-pw';

function sandboxEnv(sandbox, port) {
    return {
        ...process.env,
        STREAMIFY_DATA_DIR: sandbox,
        STREAMIFY_CONFIG: path.join(sandbox, 'config.json'),
        STREAMIFY_DISABLE_HTTPS: '1',
        PORT: String(port),
        SLSK_USER: '',
        SLSK_PASS: ''
    };
}

// --- child scripts -------------------------------------------------------

const SAVE_SCRIPT = `
(async () => {
    const server = require(${JSON.stringify(REPO)} + '/Server/server');
    const Downloads = require(${JSON.stringify(REPO)} + '/Server/downloads');
    await server.start();
    await Downloads.saveSoulseekCredentials({ username: 'testuser', password: ${JSON.stringify(PASSWORD)} });
    console.log('SAVED');
    await server.gracefulShutdown({ exit: false }).catch(() => {});
    process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
`;

const INSPECT_SCRIPT = `
(async () => {
    const server = require(${JSON.stringify(REPO)} + '/Server/server');
    const Downloads = require(${JSON.stringify(REPO)} + '/Server/downloads');
    await server.start();
    const config = server.app.locals.config;
    console.log('RESULT ' + JSON.stringify({
        keys: Object.keys(config).sort(),
        hasPasswordKey: 'soulseek_password' in config,
        hasUsernameKey: 'soulseek_username' in config,
        secretInBlob: JSON.stringify(config).includes('SUPERSECRET'),
        status: await Downloads.soulseekStatus()
    }));
    await server.gracefulShutdown({ exit: false }).catch(() => {});
    process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
`;

function runChild(script, sandbox, port) {
    const scriptPath = path.join(sandbox, `child-${port}.js`);
    fs.writeFileSync(scriptPath, script);
    return execFileSync(process.execPath, [scriptPath], {
        env: sandboxEnv(sandbox, port),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
    });
}

// --- run -----------------------------------------------------------------

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'streamify-sec-'));
fs.mkdirSync(path.join(sandbox, 'Music'), { recursive: true });
fs.writeFileSync(
    path.join(sandbox, 'config.json'),
    JSON.stringify({ music_directories: [path.join(sandbox, 'Music')] })
);

try {
    console.log('=== Phase 1: save Soulseek credentials');
    const saved = runChild(SAVE_SCRIPT, sandbox, 4551);
    assert.ok(saved.includes('SAVED'), 'credentials were not saved');
    console.log('    OK  saved');

    console.log('\n=== Phase 2: fresh boot, inspect the config surface');
    const output = runChild(INSPECT_SCRIPT, sandbox, 4552);
    const line = output.split('\n').find(l => l.startsWith('RESULT '));
    assert.ok(line, `no RESULT line in child output:\n${output}`);
    const result = JSON.parse(line.slice('RESULT '.length));

    console.log('    app.locals.config keys: ' + result.keys.join(', '));
    console.log('    soulseek_password key present : ' + result.hasPasswordKey);
    console.log('    soulseek_username key present : ' + result.hasUsernameKey);
    console.log('    secret found anywhere in blob : ' + result.secretInBlob);

    assert.strictEqual(result.hasPasswordKey, false,
        'LEAK: soulseek_password reached app.locals.config (served by GET /api/admin/config)');
    assert.strictEqual(result.hasUsernameKey, false,
        'LEAK: soulseek_username reached app.locals.config');
    assert.strictEqual(result.secretInBlob, false,
        'LEAK: the raw password appears in the config surface');
    console.log('    OK  no credentials in the config surface');

    console.log('\n=== Phase 3: the feature still works (credentials readable by the engine)');
    assert.strictEqual(result.status.configured, true, 'credentials should still be usable');
    assert.strictEqual(result.status.username, 'testuser', 'username should round-trip');
    // soulseekStatus is what the settings API returns; it must never carry the password.
    assert.ok(!JSON.stringify(result.status).includes('SUPERSECRET'),
        'LEAK: soulseekStatus() exposes the password');
    console.log('    OK  ' + JSON.stringify(result.status));

    console.log('\nAll download security checks passed.\n');
} finally {
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* best effort */ }
}
