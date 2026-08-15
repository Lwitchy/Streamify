#!/usr/bin/env node
/**
 * Streamify — LAN certificate generator
 * =====================================
 *
 * WHY THIS EXISTS
 * ---------------
 * Browsers gate a set of APIs behind a "secure context". `localhost` always
 * counts as secure, so the desktop app gets everything for free. A phone
 * hitting `http://192.168.1.50:4443` does NOT, which silently disables:
 *
 *   - Service workers      -> no offline playback, no media caching
 *   - Cache Storage API    -> downloaded songs cannot be stored
 *   - Add to Home Screen   -> Streamify cannot be installed as an app
 *   - Screen Wake Lock     -> the lyrics view lets the screen sleep
 *
 * Generating a certificate and dropping it in SSL/ flips the whole LAN over to
 * HTTPS, restoring all of the above.
 *
 * THE CAVEAT
 * ----------
 * This produces a SELF-SIGNED certificate. Browsers do not trust it by default,
 * so each device shows a warning once. On desktop you click through it. On
 * Android/iOS you can install the generated CA to remove the warning entirely
 * (see the printed instructions).
 *
 * If you want zero warnings and zero per-device setup, use a tunnel instead:
 *   - Cloudflare Tunnel  (free, works over cellular too)
 *   - Tailscale          (`tailscale serve`, private mesh, real certs)
 * Neither requires this script.
 *
 * Usage:  npm run gen-cert
 */

const fs = require('fs');
const path = require('path');

let selfsigned;
try {
    selfsigned = require('selfsigned');
} catch {
    console.error('Missing dependency "selfsigned". Run `npm install` first.');
    process.exit(1);
}

const RT = require('../Server/runtime');

const SSL_DIR = RT.paths.ssl;
const KEY_PATH = path.join(SSL_DIR, 'key.pem');
const CERT_PATH = path.join(SSL_DIR, 'cert.pem');

async function main() {
    const force = process.argv.includes('--force');

    if (fs.existsSync(KEY_PATH) && fs.existsSync(CERT_PATH) && !force) {
        console.log('A certificate already exists:');
        console.log(`  ${KEY_PATH}`);
        console.log(`  ${CERT_PATH}`);
        console.log('\nRe-run with --force to replace it.');
        return;
    }

    fs.mkdirSync(SSL_DIR, { recursive: true });

    // Every address a client might use to reach this machine must appear in the
    // Subject Alternative Name list, otherwise browsers reject the certificate
    // outright (CN matching has been ignored for years).
    const lan = RT.getLanAddresses();
    const altNames = [
        { type: 2, value: 'localhost' },
        { type: 2, value: `${require('os').hostname()}.local` },
        { type: 2, value: require('os').hostname() },
        { type: 7, ip: '127.0.0.1' },
        { type: 7, ip: '::1' },
        ...lan.map(entry => ({ type: 7, ip: entry.address })),
    ];

    console.log('Generating a self-signed certificate for:');
    altNames.forEach(n => console.log(`  - ${n.value || n.ip}`));

    // selfsigned v5+ returns a Promise. Older versions returned the object
    // directly, so await handles both.
    const pems = await selfsigned.generate(
        [{ name: 'commonName', value: 'Streamify Local' }],
        {
            days: 825, // Safari refuses certificates valid for longer than this
            keySize: 2048,
            algorithm: 'sha256',
            extensions: [
                { name: 'basicConstraints', cA: true },
                {
                    name: 'keyUsage',
                    keyCertSign: true,
                    digitalSignature: true,
                    keyEncipherment: true,
                },
                {
                    name: 'extKeyUsage',
                    serverAuth: true,
                },
                { name: 'subjectAltName', altNames },
            ],
        }
    );

    fs.writeFileSync(KEY_PATH, pems.private);
    fs.writeFileSync(CERT_PATH, pems.cert);

    console.log('\nDone. Wrote:');
    console.log(`  ${KEY_PATH}`);
    console.log(`  ${CERT_PATH}`);

    console.log('\nRestart Streamify and it will detect these automatically.');
    console.log('Your addresses become:');
    console.log(`  https://localhost:${RT.PORT}`);
    lan.forEach(e => console.log(`  https://${e.address}:${RT.PORT}`));

    console.log('\n--- Trusting the certificate on a phone ---');
    console.log('Without this step you get a warning screen once per device,');
    console.log('and "Add to Home Screen" stays unavailable.');
    console.log('');
    console.log('  Android: copy cert.pem to the device, then');
    console.log('           Settings > Security > Encryption & credentials');
    console.log('           > Install a certificate > CA certificate');
    console.log('  iOS:     AirDrop/email cert.pem, open it, then');
    console.log('           Settings > General > VPN & Device Management > install');
    console.log('           THEN Settings > General > About > Certificate Trust');
    console.log('           Settings > enable full trust for "Streamify Local"');
    console.log('');
    console.log('Prefer no warnings at all? Use a Cloudflare Tunnel or Tailscale');
    console.log('instead of this certificate. See DEPLOYMENT.md.');
}

main().catch((err) => {
    console.error('Certificate generation failed:', err.message);
    process.exit(1);
});
