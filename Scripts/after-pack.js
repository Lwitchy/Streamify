'use strict';

const fs = require('fs');
const path = require('path');

module.exports = async context => {
    if (context.electronPlatformName === 'win32') return;

    const root = path.join(
        context.appOutDir,
        context.electronPlatformName === 'darwin'
            ? `${context.packager.appInfo.productFilename}.app/Contents/Resources`
            : 'resources',
        'app.asar.unpacked',
        'vendor',
        'fpcalc'
    );
    if (!fs.existsSync(root)) return;

    for (const target of fs.readdirSync(root, { withFileTypes: true })) {
        if (!target.isDirectory() || target.name.startsWith('win32-')) continue;
        const executable = path.join(root, target.name, 'fpcalc');
        if (fs.existsSync(executable)) fs.chmodSync(executable, 0o755);
    }
};
