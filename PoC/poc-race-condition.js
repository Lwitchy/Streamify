/**
 * PoC 1: Race Condition on uploaded_songs_count
 *
 * FIXED: media.js now uses atomic incrementUploadedSongs() instead of
 * read-modify-write. This script verifies the fix by firing 10 concurrent
 * increments and checking the final count is exactly 10.
 *
 * It also demonstrates what the OLD code would have done by simulating
 * the non-atomic read-modify-write pattern in JS.
 *
 * Run: node poc-race-condition.js
 */

const sqlite3 = require('sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '../Database/Dev/Users/users.db');
const TEST_USER = 'lwitchy';
const CONCURRENT_OPS = 10;

function openDb() {
  return new sqlite3.Database(DB_PATH);
}

function getCount(db, username) {
  return new Promise((resolve, reject) => {
    db.get('SELECT uploaded_songs_count FROM users WHERE username = ?', [username], (err, row) => {
      if (err) reject(err);
      else resolve(row.uploaded_songs_count);
    });
  });
}

function setCount(db, username, count) {
  return new Promise((resolve, reject) => {
    db.run('UPDATE users SET uploaded_songs_count = ? WHERE username = ?', [count, username], function (err) {
      if (err) reject(err);
      else resolve(this.changes);
    });
  });
}

function atomicIncrement(db, username) {
  return new Promise((resolve, reject) => {
    db.run('UPDATE users SET uploaded_songs_count = uploaded_songs_count + 1 WHERE username = ?', [username], function (err) {
      if (err) reject(err);
      else resolve(this.changes);
    });
  });
}

function nonAtomicIncrement(db, username) {
  // Simulates the OLD vulnerable code: read → compute in JS → write back
  return new Promise((resolve, reject) => {
    db.get('SELECT uploaded_songs_count FROM users WHERE username = ?', [username], (err, row) => {
      if (err) return reject(err);
      const newCount = row.uploaded_songs_count + 1;
      db.run('UPDATE users SET uploaded_songs_count = ? WHERE username = ?', [newCount, username], (err2) => {
        if (err2) reject(err2);
        else resolve();
      });
    });
  });
}

async function main() {
  console.log('='.repeat(70));
  console.log('PoC 1: Race Condition on uploaded_songs_count');
  console.log('='.repeat(70), '\n');

  // ── Test A: Atomic increment (current FIX) ────────────────────────────
  console.log('[Test A] Atomic increment (current fix — SET count = count + 1)');
  {
    const db = openDb();
    await setCount(db, TEST_USER, 0);
    const before = await getCount(db, TEST_USER);
    console.log(`  Before: ${before}`);

    // Fire 10 concurrent atomic increments
    const promises = [];
    for (let i = 0; i < CONCURRENT_OPS; i++) {
      promises.push(atomicIncrement(db, TEST_USER));
    }
    await Promise.all(promises);

    const after = await getCount(db, TEST_USER);
    const lost = CONCURRENT_OPS - after;
    console.log(`  After:  ${after}`);
    console.log(`  Expected: ${CONCURRENT_OPS}, Lost increments: ${lost}`);
    console.log(`  Result: ${lost === 0 ? 'PASS — no lost updates' : 'FAIL — lost ' + lost + ' updates'}`);
    db.close();
  }

  console.log();

  // ── Test B: Non-atomic read-modify-write (old VULNERABLE code) ───────
  console.log('[Test B] Non-atomic read-modify-write (old vulnerable code)');
  {
    const db = openDb();
    await setCount(db, TEST_USER, 0);
    const before = await getCount(db, TEST_USER);
    console.log(`  Before: ${before}`);

    // Fire 10 concurrent non-atomic increments
    const promises = [];
    for (let i = 0; i < CONCURRENT_OPS; i++) {
      promises.push(nonAtomicIncrement(db, TEST_USER));
    }
    await Promise.all(promises);

    const after = await getCount(db, TEST_USER);
    const lost = CONCURRENT_OPS - after;
    console.log(`  After:  ${after}`);
    console.log(`  Expected: ${CONCURRENT_OPS}, Lost increments: ${lost}`);
    console.log(`  Result: ${lost > 0 ? 'VULNERABLE — lost ' + lost + ' updates' : 'No race detected (SQLite serialized the ops)'}`);
    db.close();
  }

  // ── Restore count ─────────────────────────────────────────────────────
  console.log();
  const db = openDb();
  await setCount(db, TEST_USER, 0);
  db.close();
  console.log('[Cleanup] Reset uploaded_songs_count back to 0');
  console.log('='.repeat(70));
}

main().catch(console.error);
