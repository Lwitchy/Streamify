/**
 * Auto-update policy tests.
 *
 * electron/updater.js is the one place where a mistake is both invisible and
 * expensive: an app that ignores the Owner's "off" switch phones home anyway,
 * and an app that mishandles the enabled path silently stops shipping fixes.
 * Neither shows up in normal use, so it is covered here.
 *
 * `electron` and `electron-updater` are replaced in the module cache before
 * updater.js is loaded, so nothing here touches Electron, the network, or a
 * real installer.
 *
 * Run: npm run test:updater
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');

/* --- Stubs installed before updater.js is required ---------------------- */

const fakeApp = {
    isPackaged: true,
    getVersion: () => '0.3.0',
    quit: () => { fakeApp.quitCalls += 1; },
    quitCalls: 0,
};

/** Stands in for electron-updater's autoUpdater singleton. */
class FakeAutoUpdater extends EventEmitter {
    constructor() {
        super();
        this.checkCalls = 0;
        this.downloadCalls = 0;
        this.quitAndInstallCalls = 0;
        this.autoDownload = true;
        this.autoInstallOnAppQuit = true;
    }

    async checkForUpdates() {
        this.checkCalls += 1;
        return { updateInfo: {} };
    }

    async downloadUpdate() {
        this.downloadCalls += 1;
        return [];
    }

    quitAndInstall() {
        this.quitAndInstallCalls += 1;
    }
}

const fakeUpdaterModule = { autoUpdater: new FakeAutoUpdater() };

function stubModule(request, exports) {
    const resolved = require.resolve(request);
    require.cache[resolved] = {
        id: resolved,
        filename: resolved,
        loaded: true,
        exports,
        children: [],
        paths: [],
    };
}

stubModule('electron', { app: fakeApp });
stubModule('electron-updater', fakeUpdaterModule);

const { createUpdater } = require('../electron/updater.js');

/* --- Harness ------------------------------------------------------------ */

const flush = () => new Promise(resolve => setImmediate(resolve));

function harness({ stored = JSON.stringify(true), platform = 'win32' } = {}) {
    const previousPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });

    fakeUpdaterModule.autoUpdater = new FakeAutoUpdater();
    fakeApp.quitCalls = 0;

    const states = [];
    const shutdowns = [];
    let setting = stored;

    const updater = createUpdater({
        log: () => {},
        broadcast: state => states.push(state),
        beforeInstall: async () => { shutdowns.push(Date.now()); },
        readSetting: async () => setting,
    });

    return {
        updater,
        states,
        shutdowns,
        get auto() { return fakeUpdaterModule.autoUpdater; },
        setStored(value) { setting = value; },
        latest: () => states[states.length - 1],
        restore() {
            updater.destroy();
            Object.defineProperty(process, 'platform', { value: previousPlatform, configurable: true });
        },
    };
}

/* --- Tests -------------------------------------------------------------- */

test('a disabled switch means GitHub is never contacted', async () => {
    const h = harness({ stored: JSON.stringify(false) });
    try {
        await h.updater.start();
        await h.updater.check();

        assert.equal(h.auto.checkCalls, 0, 'a scheduled check ran despite the switch being off');
        assert.equal(h.updater.getStatus().enabled, false);
    } finally {
        h.restore();
    }
});

test('a manual check still works while automatic checks are off', async () => {
    const h = harness({ stored: JSON.stringify(false) });
    try {
        await h.updater.start();
        await h.updater.check({ manual: true });

        assert.equal(h.auto.checkCalls, 1);
    } finally {
        h.restore();
    }
});

test('an available update downloads only when the switch is on', async () => {
    const enabled = harness();
    try {
        await enabled.updater.start();
        enabled.auto.emit('update-available', { version: '0.4.0', releaseNotes: '<p>Fixes</p>' });
        await flush();

        assert.equal(enabled.auto.downloadCalls, 1);
        assert.equal(enabled.latest().latestVersion, '0.4.0');
        assert.equal(enabled.latest().releaseNotes, 'Fixes', 'release notes reached the renderer as HTML');
    } finally {
        enabled.restore();
    }

    const disabled = harness({ stored: JSON.stringify(false) });
    try {
        await disabled.updater.start();
        disabled.auto.emit('update-available', { version: '0.4.0' });
        await flush();

        assert.equal(disabled.auto.downloadCalls, 0, 'downloaded an update the Owner opted out of');
        assert.equal(disabled.latest().state, 'available', 'the user is still told a version exists');
    } finally {
        disabled.restore();
    }
});

test('the release link uses the tag GitHub reported, not a guessed one', async () => {
    const h = harness();
    try {
        await h.updater.start();

        // The GitHub provider resolves the real tag; a hand-made tag without
        // electron-builder's default "v" prefix must still produce a live link.
        h.auto.emit('update-available', { version: '0.4.0', tag: '0.4.0' });
        await flush();
        assert.equal(h.latest().releaseUrl, 'https://github.com/Lwitchy/Streamify/releases/tag/0.4.0');

        // A later event carrying no tag must not regress the resolved link.
        h.auto.emit('update-downloaded', { version: '0.4.0' });
        await flush();
        assert.equal(h.latest().releaseUrl, 'https://github.com/Lwitchy/Streamify/releases/tag/0.4.0');
    } finally {
        h.restore();
    }
});

test('a downloaded update installs on quit only while enabled', async () => {
    const h = harness();
    try {
        await h.updater.start();
        h.auto.emit('update-downloaded', { version: '0.4.0' });
        await flush();
        assert.equal(h.auto.autoInstallOnAppQuit, true);
        assert.equal(h.updater.getStatus().state, 'downloaded');

        // Turning the switch off must disarm the staged install, not just stop
        // future checks.
        h.setStored(JSON.stringify(false));
        await h.updater.refreshPolicy();
        assert.equal(h.auto.autoInstallOnAppQuit, false);

        h.setStored(JSON.stringify(true));
        await h.updater.refreshPolicy();
        assert.equal(h.auto.autoInstallOnAppQuit, true);
    } finally {
        h.restore();
    }
});

test('installing shuts the server down before running the installer', async () => {
    const h = harness();
    try {
        await h.updater.start();

        const tooEarly = await h.updater.installNow();
        assert.equal(tooEarly.ok, false, 'installed before anything was downloaded');
        assert.equal(h.auto.quitAndInstallCalls, 0);

        h.auto.emit('update-downloaded', { version: '0.4.0' });
        await flush();

        const result = await h.updater.installNow();
        assert.equal(result.ok, true);
        assert.equal(h.shutdowns.length, 1, 'the graceful shutdown was skipped');
        assert.equal(h.auto.quitAndInstallCalls, 0, 'the installer ran before the shutdown finished');

        await flush();
        assert.equal(h.auto.quitAndInstallCalls, 1);
    } finally {
        h.restore();
    }
});

test('download progress is reported and errors surface instead of hanging', async () => {
    const h = harness();
    try {
        await h.updater.start();

        h.auto.emit('download-progress', { percent: 42.6 });
        assert.equal(h.latest().state, 'downloading');
        assert.equal(h.latest().percent, 43, 'progress should be rounded for the UI');

        h.auto.emit('error', new Error('net::ERR_INTERNET_DISCONNECTED'));
        assert.equal(h.latest().state, 'error');
        assert.equal(h.latest().error, 'net::ERR_INTERNET_DISCONNECTED');
    } finally {
        h.restore();
    }
});

test('builds that cannot replace themselves say so instead of failing', async () => {
    const cases = [
        { setup: () => { fakeApp.isPackaged = false; }, reason: 'development' },
        { setup: () => { process.env.PORTABLE_EXECUTABLE_DIR = 'C:\\tmp'; }, reason: 'portable' },
        { platform: 'linux', reason: 'linux-package' },
        { platform: 'darwin', reason: 'unsigned-macos' },
    ];

    for (const testCase of cases) {
        const packaged = fakeApp.isPackaged;
        const portable = process.env.PORTABLE_EXECUTABLE_DIR;
        delete process.env.PORTABLE_EXECUTABLE_DIR;
        fakeApp.isPackaged = true;
        if (testCase.setup) testCase.setup();

        const h = harness({ platform: testCase.platform || 'win32' });
        try {
            await h.updater.start();
            const status = h.updater.getStatus();
            assert.equal(status.supported, false);
            assert.equal(status.unsupportedReason, testCase.reason);
            assert.equal(h.auto.checkCalls, 0, `${testCase.reason}: checked anyway`);
        } finally {
            h.restore();
            fakeApp.isPackaged = packaged;
            if (portable === undefined) delete process.env.PORTABLE_EXECUTABLE_DIR;
            else process.env.PORTABLE_EXECUTABLE_DIR = portable;
        }
    }
});

test('an unreadable setting falls back to enabled rather than silently off', async () => {
    const h = harness();
    h.setStored(null);
    try {
        await h.updater.start();
        assert.equal(h.updater.getStatus().enabled, true);
    } finally {
        h.restore();
    }
});
