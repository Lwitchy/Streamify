'use strict';

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const VERSION = '1.6.1';
const RELEASE_BASE = `https://github.com/acoustid/chromaprint/releases/download/v${VERSION}`;
const REPO_ROOT = path.resolve(__dirname, '..');
const OUTPUT_ROOT = path.join(REPO_ROOT, 'vendor', 'fpcalc');
const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;

const ASSETS = [
    {
        archive: `chromaprint-fpcalc-${VERSION}-windows-x86_64.zip`,
        sha256: '735d6182b38e9f364b84ce6f4ccd682c75e2851de89735711d6b762d12b92a4e',
        executable: 'fpcalc.exe',
        targets: ['win32-x64']
    },
    {
        archive: `chromaprint-fpcalc-${VERSION}-linux-x86_64.tar.gz`,
        sha256: 'fc16cd37a70168040bc9ceb45f1d4d1216f5a75bc4c9cf8564bea70ac6a45733',
        executable: 'fpcalc',
        targets: ['linux-x64']
    },
    {
        archive: `chromaprint-fpcalc-${VERSION}-linux-arm64.tar.gz`,
        sha256: '7eaf5d655c4aa172ab28e3c870b8bb61dd2c327ac94de145676f88842cf6215a',
        executable: 'fpcalc',
        targets: ['linux-arm64']
    },
    {
        archive: `chromaprint-fpcalc-${VERSION}-macos-universal.tar.gz`,
        sha256: '240aeb5a8c8205af458e3625cb7487b826b711a999e491ef00111f3cebd76f00',
        executable: 'fpcalc',
        targets: ['darwin-x64', 'darwin-arm64']
    }
];

function download(url, redirects = 5) {
    return new Promise((resolve, reject) => {
        const request = https.get(url, {
            headers: { 'User-Agent': 'Streamify-fpcalc-fetcher/1.0' }
        }, response => {
            if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                response.resume();
                if (redirects <= 0) return reject(new Error('Too many redirects'));
                return download(new URL(response.headers.location, url).href, redirects - 1).then(resolve, reject);
            }
            if (response.statusCode !== 200) {
                response.resume();
                return reject(new Error(`Download failed with HTTP ${response.statusCode}`));
            }

            const chunks = [];
            let bytes = 0;
            response.on('data', chunk => {
                bytes += chunk.length;
                if (bytes > MAX_DOWNLOAD_BYTES) response.destroy(new Error('Download exceeded size limit'));
                else chunks.push(chunk);
            });
            response.on('end', () => resolve(Buffer.concat(chunks)));
            response.on('error', reject);
        });
        request.on('error', reject);
        request.setTimeout(30_000, () => request.destroy(new Error('Download timed out')));
    });
}

function findFile(directory, filename) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const candidate = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            const nested = findFile(candidate, filename);
            if (nested) return nested;
        } else if (entry.name === filename) {
            return candidate;
        }
    }
    return null;
}

function extract(archivePath, destination) {
    fs.mkdirSync(destination, { recursive: true });
    const result = spawnSync('tar', ['-xf', archivePath, '-C', destination], {
        encoding: 'utf8',
        windowsHide: true
    });
    if (result.status !== 0) {
        throw new Error(`Could not extract ${path.basename(archivePath)}: ${result.stderr || result.stdout}`);
    }
}

async function installAsset(asset, temporaryRoot) {
    const url = `${RELEASE_BASE}/${asset.archive}`;
    const archiveData = await download(url);
    const digest = crypto.createHash('sha256').update(archiveData).digest('hex');
    if (digest !== asset.sha256) throw new Error(`Checksum mismatch for ${asset.archive}`);

    const archivePath = path.join(temporaryRoot, asset.archive);
    const extractRoot = path.join(temporaryRoot, `${asset.archive}.contents`);
    fs.writeFileSync(archivePath, archiveData);
    extract(archivePath, extractRoot);

    const executable = findFile(extractRoot, asset.executable);
    if (!executable) throw new Error(`${asset.executable} was not found in ${asset.archive}`);

    for (const target of asset.targets) {
        const targetDirectory = path.join(OUTPUT_ROOT, target);
        const targetPath = path.join(targetDirectory, asset.executable);
        fs.mkdirSync(targetDirectory, { recursive: true });
        fs.copyFileSync(executable, targetPath);
        if (!target.startsWith('win32-')) fs.chmodSync(targetPath, 0o755);
        fs.writeFileSync(path.join(targetDirectory, 'SOURCE.json'), JSON.stringify({
            project: 'Chromaprint fpcalc',
            version: VERSION,
            source: url,
            archiveSha256: asset.sha256,
            installedAs: asset.executable
        }, null, 2) + '\n');
    }
}

async function main() {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'streamify-fpcalc-'));
    try {
        fs.mkdirSync(OUTPUT_ROOT, { recursive: true });
        for (const asset of ASSETS) {
            console.log(`Fetching ${asset.archive}...`);
            await installAsset(asset, temporaryRoot);
        }
        console.log(`Chromaprint fpcalc ${VERSION} installed in ${OUTPUT_ROOT}`);
    } finally {
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
}

main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
});
