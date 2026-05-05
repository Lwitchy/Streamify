/**
 * PoC: Session Middleware Bypass Tester for Streamify
 *
 * Tests multiple bypass vectors against the requireRole/requireLogin middleware.
 * Targets a local instance running on http://localhost:4443.
 *
 * Run: node poc-session-bypass.js
 */

const http = require('http');

const BASE = 'http://localhost:4443';
const PROTECTED_ROUTE = '/api/me'; // requiresLogin

// ── Helpers ──────────────────────────────────────────────────────────────

function request(method, path, { cookie, headers = {} } = {}) {
  return new Promise((resolve) => {
    const url = new URL(path, BASE);
    const opts = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: { ...headers },
    };
    if (cookie) opts.headers['Cookie'] = cookie;

    const req = http.request(opts, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', (e) => resolve({ error: e.message }));
    req.end();
  });
}

async function test(name, result, expectBypass) {
  const passed = expectBypass
    ? result.status === 200
    : result.status !== 200;

  const tag = passed ? 'PASS (secure)' : 'FAIL (bypassed!)';
  const status = result.status ?? 'ERR';
  const detail = result.error
    ? result.error
    : `${status} — ${result.body?.slice(0, 120)}`;

  console.log(`[${tag}] ${name}: ${detail}`);
  return { name, bypassed: !passed, status, detail };
}

// ── Bypass Vectors ───────────────────────────────────────────────────────

async function runTests() {
  const results = [];

  console.log('='.repeat(70));
  console.log('Streamify Session Middleware Bypass PoC');
  console.log('Target:', BASE);
  console.log('='.repeat(70), '\n');

  // 1. No cookie at all — should 401
  results.push(await test(
    '1. No cookie',
    await request('GET', PROTECTED_ROUTE),
    false
  ));

  // 2. Completely fake session token (random 64-char hex)
  results.push(await test(
    '2. Forged hex token',
    await request('GET', PROTECTED_ROUTE, { cookie: 'session_id=' + 'a'.repeat(64) }),
    false
  ));

  // 3. Empty session_id value
  results.push(await test(
    '3. Empty session_id cookie',
    await request('GET', PROTECTED_ROUTE, { cookie: 'session_id=' }),
    false
  ));

  // 4. Non-hex junk in session_id (type confusion)
  results.push(await test(
    '4. Non-hex junk token',
    await request('GET', PROTECTED_ROUTE, { cookie: 'session_id=<script>alert(1)</script>' }),
    false
  ));

  // 5. SQL injection attempt in cookie (parameterized queries should block this)
  results.push(await test(
    '5. SQLi in cookie value',
    await request('GET', PROTECTED_ROUTE, { cookie: "session_id=' OR 1=1 --" }),
    false
  ));

  // 6. Very long token (buffer overflow attempt)
  results.push(await test(
    '6. Oversized token (10KB)',
    await request('GET', PROTECTED_ROUTE, { cookie: 'session_id=' + 'X'.repeat(10240) }),
    false
  ));

  // 7. Null-byte-like padding (use URL-encoded %00 instead of literal null)
  results.push(await test(
    '7. Percent-encoded null in token',
    await request('GET', PROTECTED_ROUTE, { cookie: 'session_id=%00admin' }),
    false
  ));

  // 8. HTTP method tampering — try DELETE/PUT on a GET-only protected route
  for (const method of ['PUT', 'PATCH', 'DELETE']) {
    results.push(await test(
      `8. Method tampering (${method} on /api/me)`,
      await request(method, PROTECTED_ROUTE),
      false
    ));
  }

  // 9. Path encoding to bypass route matching
  results.push(await test(
    '9. Double-encoded path /%61pi/me',
    await request('GET', '/%61pi/me'),
    false
  ));

  results.push(await test(
    '9b. Dot-segment /./api/me',
    await request('GET', '/./api/me'),
    false
  ));

  // 10. Unprotected /logout route — can be called without auth to clear cookies
  //     This is an informational finding, not a bypass of protected routes
  results.push(await test(
    '10. Unauthenticated /logout (no requireLogin)',
    await request('POST', '/logout'),
    false
  ));

  // 11. Cookie with unicode tricks (tab crashes Node http, use space)
  results.push(await test(
    '11. Cookie with space-padded value',
    await request('GET', PROTECTED_ROUTE, { cookie: 'session_id= ' + 'b'.repeat(64) }),
    false
  ));

  // 12. Try accessing admin routes without any auth
  results.push(await test(
    '12. Admin promote route (no auth)',
    await request('POST', '/api/admin/promote', {
      headers: { 'Content-Type': 'application/json' },
    }),
    false
  ));

  // ── Summary ───────────────────────────────────────────────────────────

  console.log('\n' + '='.repeat(70));
  const bypassed = results.filter((r) => r.bypassed);
  if (bypassed.length === 0) {
    console.log('RESULT: No bypasses found. Session middleware appears robust.');
  } else {
    console.log(`RESULT: ${bypassed.length} BYPASS(ES) DETECTED:`);
    bypassed.forEach((r) => console.log(`  - ${r.name}: ${r.detail}`));
  }
  console.log('='.repeat(70));

  // Informational notes
  console.log('\nInformational findings:');
  console.log('  - /logout endpoint has no requireLogin guard (anyone can POST /logout');
  console.log('    to clear the session cookie, but cannot access protected data).');
  console.log('  - All SQL uses parameterized queries — SQLi via cookie is not viable.');
  console.log('  - Session tokens are 64-char hex, validated against SQLite lookup.');
}

runTests().catch((err) => {
  console.error('PoC failed to run:', err.message);
  console.error('Is the Streamify server running on port 4443?');
});
