const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const RT = require('./runtime');

// Ensure Database directories exist.
// Paths come from the runtime module so the packaged desktop app can store
// databases in a writable per-user location instead of inside the read-only
// application bundle. In a plain `node server.js` clone these resolve to the
// original ../Database/Dev/* locations.
const dbUsersDir = RT.paths.usersDb;
const dbMusicDir = RT.paths.musicDb;

if (!fs.existsSync(dbUsersDir)) fs.mkdirSync(dbUsersDir, { recursive: true });
if (!fs.existsSync(dbMusicDir)) fs.mkdirSync(dbMusicDir, { recursive: true });

function configureDatabase(db, label) {
    db.exec(`
        PRAGMA journal_mode=WAL;
        PRAGMA synchronous=NORMAL;
        PRAGMA foreign_keys=ON;
        PRAGMA busy_timeout=5000;
    `, err => {
        if (err) console.error(`Error configuring ${label} db:`, err);
    });
}

// Initialize connections
const usersDb = new sqlite3.Database(path.join(dbUsersDir, 'users.db'), (err) => {
    if (err) console.error("Error opening users db:", err);
    else configureDatabase(usersDb, 'users');
});

const musicDb = new sqlite3.Database(path.join(dbMusicDir, 'music.db'), (err) => {
    if (err) console.error("Error opening music db:", err);
    else configureDatabase(musicDb, 'music');
});

const lyricsDb = new sqlite3.Database(path.join(dbMusicDir, 'lyrics.db'), (err) => {
    if (err) console.error("Error opening lyrics db:", err);
    else configureDatabase(lyricsDb, 'lyrics');
});

// Statements and transactions share one FIFO queue per connection. Transaction
// descendants bypass their already-owned queue so helper calls cannot deadlock.
const databaseQueueContext = new AsyncLocalStorage();

const createFifoQueue = () => {
    let tail = Promise.resolve();
    return async operation => {
        let release;
        const previous = tail;
        tail = new Promise(resolve => { release = resolve; });
        await previous;
        try {
            return await operation();
        } finally {
            release();
        }
    };
};

const databaseQueues = new Map([
    [usersDb, createFifoQueue()],
    [musicDb, createFifoQueue()]
]);

const withDatabaseQueue = (db, operation) => {
    const ownedQueues = databaseQueueContext.getStore();
    if (ownedQueues && ownedQueues.has(db)) return operation();

    const enqueue = databaseQueues.get(db);
    if (!enqueue) return operation();

    const nextOwnedQueues = new Set(ownedQueues || []);
    nextOwnedQueues.add(db);
    return enqueue(() => databaseQueueContext.run(nextOwnedQueues, operation));
};

const serializeTransaction = (db, transaction) => async (...args) => {
    return await withDatabaseQueue(db, () => transaction(...args));
};

// Helper for Promises
const runQuery = (db, query, params = []) => {
    return withDatabaseQueue(db, () => new Promise((resolve, reject) => {
        db.run(query, params, function (err) {
            if (err) reject(err);
            else resolve(this);
        });
    }));
};

const getQuery = (db, query, params = []) => {
    return withDatabaseQueue(db, () => new Promise((resolve, reject) => {
        db.get(query, params, (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    }));
};

const allQuery = (db, query, params = []) => {
    return withDatabaseQueue(db, () => new Promise((resolve, reject) => {
        db.all(query, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    }));
};

const SONG_AVAILABILITIES = new Set(['available', 'missing', 'removed']);
const METADATA_STATUSES = new Set(['unreviewed', 'identified', 'review', 'unknown', 'conflict', 'error']);
const ENRICHMENT_METADATA_FIELDS = new Set(['songname', 'artist', 'album', 'genre', 'year', 'cover_path', 'cover_source_url']);

const metadataValueToJson = value => JSON.stringify(value === undefined ? null : value);

const parseMetadataValue = value => {
    try {
        return JSON.parse(value);
    } catch {
        return value;
    }
};

const canonicalSongPathKey = value => {
    if (value === null || value === undefined || String(value) === '') return null;
    const raw = String(value);
    const normalized = process.platform === 'win32'
        ? path.win32.normalize(raw.replace(/\//g, '\\')).replace(/\\/g, '/')
        : path.posix.normalize(raw.replace(/\\/g, '/'));
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
};

const SENSITIVE_ENRICHMENT_KEYS = new Set([
    'fingerprint', 'acoustidfingerprint', 'rawfingerprint', 'acoustidkey',
    'acoustidclientkey', 'clientkey', 'query', 'queryjson', 'searchquery',
    'hypotheses', 'matchedhypothesis', 'filepath', 'requesturl'
]);

const sanitizeEnrichmentPayload = (value, depth = 0) => {
    if (depth > 12 || value === undefined || typeof value === 'function') return undefined;
    if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
    if (typeof value === 'string') {
        if (/(?:[?&](?:client|fingerprint)=|ACOUSTID_CLIENT_KEY)/iu.test(value)) return '[redacted]';
        return value;
    }
    if (Array.isArray(value)) {
        return value.map(item => sanitizeEnrichmentPayload(item, depth + 1)).filter(item => item !== undefined);
    }
    if (typeof value !== 'object') return String(value);
    const safe = {};
    for (const [key, item] of Object.entries(value)) {
        const normalizedKey = key.replace(/[^a-z0-9]/giu, '').toLowerCase();
        if (SENSITIVE_ENRICHMENT_KEYS.has(normalizedKey) || normalizedKey.includes('fingerprint') ||
            normalizedKey.includes('searchquery') || /(?:secret|password|token)$/iu.test(normalizedKey)) continue;
        const sanitized = sanitizeEnrichmentPayload(item, depth + 1);
        if (sanitized !== undefined) safe[key] = sanitized;
    }
    return safe;
};

const sanitizeEnrichmentOptions = options => {
    const sanitized = sanitizeEnrichmentPayload(options && typeof options === 'object' ? options : {});
    return sanitized && typeof sanitized === 'object' && !Array.isArray(sanitized) ? sanitized : {};
};

const shouldLockMetadataField = (lockFields, field) => {
    if (lockFields === true) return true;
    const normalized = normalizeMetadataField(field);
    if (Array.isArray(lockFields)) return lockFields.some(value => normalizeMetadataField(value) === normalized);
    if (lockFields instanceof Set) return Array.from(lockFields).some(value => normalizeMetadataField(value) === normalized);
    return false;
};

const stableInternalUid = (namespace, identity) => {
    if (!identity) return crypto.randomUUID();
    const bytes = crypto.createHash('sha256').update(`${namespace}\u0000${identity}`).digest().subarray(0, 16);
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const normalizeMetadataField = field => {
    const normalized = String(field || '').trim();
    if (normalized === 'title') return 'songname';
    if (normalized === 'coverUrl' || normalized === 'cover_url' || normalized === 'cover') return 'cover_path';
    return normalized;
};

const isPlaceholderMetadataValue = (field, value) => {
    if (value === null || value === undefined || String(value).trim() === '') return true;
    if (field === 'year') return !Number.isInteger(Number(value)) || Number(value) <= 0;
    const normalized = String(value).trim().toLowerCase();
    if (['unknown', 'n/a', 'none', 'null', 'not available', 'untitled', 'untitled track'].includes(normalized)) return true;
    if (field === 'songname') return normalized === 'unknown title' || normalized === 'unknown track';
    if (field === 'artist') return normalized === 'unknown artist';
    if (field === 'album') return normalized === 'unknown album' || normalized === 'unknown release';
    if (field === 'genre') return normalized === 'unknown genre';
    return false;
};

const normalizeExternalIdentifiers = identifiers => {
    const normalized = [];
    const seen = new Set();
    for (const identifier of identifiers || []) {
        const type = String(identifier && (identifier.type || identifier.identifier_type) || '').trim().toLowerCase().slice(0, 80);
        const value = String(identifier && (identifier.value || identifier.identifier_value) || '').trim().slice(0, 500);
        if (!type || !value) continue;
        const key = `${type}\u0000${value.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        normalized.push({ type, value });
    }
    return normalized;
};

async function insertEnrichmentIdentifiers(songId, identifiers, source, now) {
    for (const identifier of normalizeExternalIdentifiers(identifiers)) {
        await runQuery(musicDb, `
            INSERT INTO external_identifiers (
                song_id, identifier_type, identifier_value, source, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(song_id, identifier_type, identifier_value, source) DO UPDATE SET
                updated_at = excluded.updated_at
        `, [songId, identifier.type, identifier.value, source, now, now]);
    }
}

async function insertEnrichmentProvenance(songId, updates, source, confidence, isLocked, now) {
    for (const [field, value] of Object.entries(updates || {})) {
        await runQuery(musicDb, `
            INSERT INTO metadata_provenance (
                song_id, field_name, value_json, source, confidence, is_locked, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(song_id, field_name, source) DO UPDATE SET
                value_json = excluded.value_json,
                confidence = excluded.confidence,
                is_locked = MAX(metadata_provenance.is_locked, excluded.is_locked),
                updated_at = excluded.updated_at
        `, [songId, field, metadataValueToJson(value), source, confidence, isLocked ? 1 : 0, now, now]);
    }
}

async function resolveCanonicalRecordingUid(songId, identifiers, candidate = null) {
    const recordingIdentifiers = normalizeExternalIdentifiers(identifiers).filter(identifier => [
        'musicbrainz_recording', 'isrc', 'apple_track'
    ].includes(identifier.type));
    for (const identifier of recordingIdentifiers) {
        const existing = await getQuery(musicDb, `
            SELECT s.recording_uid
            FROM external_identifiers e
            JOIN songs s ON s.id = e.song_id
            JOIN recordings r ON r.recording_uid = s.recording_uid
            WHERE e.identifier_type = ? AND LOWER(e.identifier_value) = LOWER(?)
              AND s.recording_uid IS NOT NULL
            ORDER BY CASE WHEN s.id = ? THEN 0 ELSE 1 END, e.id
            LIMIT 1
        `, [identifier.type, identifier.value, songId]);
        if (existing && existing.recording_uid) return existing.recording_uid;
    }
    const priority = ['musicbrainz_recording', 'isrc', 'apple_track'];
    for (const type of priority) {
        const identifier = recordingIdentifiers.find(entry => entry.type === type);
        if (identifier) return stableInternalUid('recording', `${type}:${identifier.value.toLowerCase()}`);
    }
    const candidateIdentity = [
        candidate && (candidate.provider || candidate.source),
        candidate && (candidate.recordingId || candidate.candidateId || candidate.id),
        candidate && (candidate.title || candidate.songname),
        candidate && candidate.artist,
        candidate && (candidate.durationMs || candidate.duration_ms)
    ].map(value => String(value || '').trim().toLowerCase()).join('\u0000');
    return candidateIdentity.replace(/\u0000/gu, '')
        ? stableInternalUid('recording-candidate', candidateIdentity)
        : crypto.randomUUID();
}

function canonicalArtistCredits(candidate) {
    const direct = Array.isArray(candidate && candidate.artistCredits) ? candidate.artistCredits : [];
    const featured = new Set((candidate && candidate.featuredArtists || []).map(value => String(value).trim().toLowerCase()));
    const credits = direct.map((credit, index) => {
        const name = String(credit && (credit.name || credit.artist && credit.artist.name) || '').trim();
        if (!name) return null;
        const providerId = String(credit.id || credit.artist && credit.artist.id || '').trim() || null;
        const provider = providerId && /^[0-9a-f]{8}-[0-9a-f-]{27}$/iu.test(providerId)
            ? 'musicbrainz'
            : String(candidate.provider || candidate.source || 'registry').toLowerCase();
        return {
            artist_uid: providerId
                ? stableInternalUid('artist', `${provider}:${providerId.toLowerCase()}`)
                : stableInternalUid('artist-name', name.toLowerCase()),
            name,
            provider,
            provider_id: providerId,
            role: String(credit.role || (featured.has(name.toLowerCase()) ? 'featured' : 'primary')).slice(0, 80),
            join_phrase: String(credit.joinPhrase || credit.joinphrase || '').slice(0, 120),
            credit_order: index
        };
    }).filter(Boolean);
    if (credits.length) return credits;
    const fallbackName = String(candidate && candidate.artist || '').trim();
    if (!fallbackName) return [];
    return [{
        artist_uid: stableInternalUid('artist-name', fallbackName.toLowerCase()),
        name: fallbackName,
        provider: String(candidate.provider || candidate.source || 'registry').toLowerCase(),
        provider_id: null,
        role: 'primary',
        join_phrase: '',
        credit_order: 0
    }];
}

function selectedCanonicalRelease(candidate) {
    if (!candidate || typeof candidate !== 'object') return null;
    if (candidate._selectedReleaseId) {
        return {
            ...candidate,
            id: candidate._selectedReleaseId,
            provider: candidate._selectedReleaseProvider || candidate.provider || candidate.source
        };
    }
    const releases = Array.isArray(candidate.releaseCandidates) ? candidate.releaseCandidates.filter(Boolean) : [];
    return releases.length === 1 ? releases[0] : null;
}

async function persistCanonicalIdentity(songId, recordingUid, candidate, identifiers, {
    method,
    source,
    confidence,
    pipelineVersion,
    now
} = {}) {
    const safeCandidate = sanitizeEnrichmentPayload(candidate && typeof candidate === 'object' ? candidate : {});
    const title = String(candidate && (candidate.title || candidate.songname) || '').trim().slice(0, 500) || null;
    const durationMs = Number(candidate && (candidate.durationMs ?? candidate.duration_ms));
    const year = Number(candidate && candidate.year);
    await runQuery(musicDb, `
        INSERT INTO recordings (
            recording_uid, title, duration_ms, first_release_year, source, confidence, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(recording_uid) DO UPDATE SET
            title = COALESCE(NULLIF(excluded.title, ''), recordings.title),
            duration_ms = COALESCE(excluded.duration_ms, recordings.duration_ms),
            first_release_year = COALESCE(excluded.first_release_year, recordings.first_release_year),
            source = excluded.source,
            confidence = COALESCE(excluded.confidence, recordings.confidence),
            updated_at = excluded.updated_at
    `, [
        recordingUid,
        title,
        Number.isFinite(durationMs) && durationMs > 0 ? Math.round(durationMs) : null,
        Number.isInteger(year) && year >= 1000 && year <= 9999 ? year : null,
        source,
        Number.isFinite(confidence) ? confidence : null,
        now,
        now
    ]);

    const credits = canonicalArtistCredits(candidate);
    if (credits.length) {
        for (const credit of credits) {
            await runQuery(musicDb, `
                INSERT INTO artists (artist_uid, name, sort_name, source, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(artist_uid) DO UPDATE SET
                    name = excluded.name,
                    sort_name = COALESCE(excluded.sort_name, artists.sort_name),
                    source = excluded.source,
                    updated_at = excluded.updated_at
            `, [credit.artist_uid, credit.name, null, credit.provider || source, now, now]);
        }
        await runQuery(musicDb, 'DELETE FROM recording_artists WHERE recording_uid = ?', [recordingUid]);
        for (const credit of credits) {
            await runQuery(musicDb, `
                INSERT INTO recording_artists (
                    recording_uid, artist_uid, credit_order, role, credited_name, join_phrase
                ) VALUES (?, ?, ?, ?, ?, ?)
            `, [recordingUid, credit.artist_uid, credit.credit_order, credit.role, credit.name, credit.join_phrase]);
        }
    }

    const release = selectedCanonicalRelease(candidate);
    let releaseUid = null;
    let releaseTrackUid = null;
    if (release) {
        const releaseProvider = String(release.provider || candidate.provider || candidate.source || source || 'registry').toLowerCase();
        const providerReleaseId = String(release.id || '').trim() || null;
        const releaseTitle = String(release.album || release.title || candidate.album || '').trim().slice(0, 500) || null;
        releaseUid = providerReleaseId
            ? stableInternalUid('release', `${releaseProvider}:${providerReleaseId.toLowerCase()}`)
            : crypto.randomUUID();
        const releaseYear = Number(release.year);
        await runQuery(musicDb, `
            INSERT INTO releases (
                release_uid, title, release_date, release_year, country, release_status,
                release_group_type, source, confidence, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(release_uid) DO UPDATE SET
                title = COALESCE(NULLIF(excluded.title, ''), releases.title),
                release_date = COALESCE(excluded.release_date, releases.release_date),
                release_year = COALESCE(excluded.release_year, releases.release_year),
                country = COALESCE(excluded.country, releases.country),
                release_status = COALESCE(excluded.release_status, releases.release_status),
                release_group_type = COALESCE(excluded.release_group_type, releases.release_group_type),
                source = excluded.source,
                confidence = COALESCE(excluded.confidence, releases.confidence),
                updated_at = excluded.updated_at
        `, [
            releaseUid,
            releaseTitle,
            release.date || release.releaseDate || null,
            Number.isInteger(releaseYear) && releaseYear >= 1000 && releaseYear <= 9999 ? releaseYear : null,
            release.country || null,
            release.status || null,
            release.releaseGroupType || null,
            releaseProvider,
            Number.isFinite(confidence) ? confidence : null,
            now,
            now
        ]);

        const discNumber = Number(release.discNumber ?? candidate.discNumber);
        const trackNumber = Number(release.trackNumber ?? candidate.trackNumber);
        const providerTrackId = String(release.releaseTrackId || candidate.releaseTrackId || '').trim() || null;
        releaseTrackUid = stableInternalUid(
            'release-track',
            providerTrackId
                ? `${releaseProvider}:${providerTrackId.toLowerCase()}`
                : `${releaseUid}:${recordingUid}:${Number.isInteger(discNumber) ? discNumber : ''}:${Number.isInteger(trackNumber) ? trackNumber : ''}`
        );
        await runQuery(musicDb, `
            INSERT INTO release_tracks (
                release_track_uid, release_uid, recording_uid, title, disc_number,
                track_number, duration_ms, source, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(release_track_uid) DO UPDATE SET
                release_uid = excluded.release_uid,
                recording_uid = excluded.recording_uid,
                title = COALESCE(NULLIF(excluded.title, ''), release_tracks.title),
                disc_number = COALESCE(excluded.disc_number, release_tracks.disc_number),
                track_number = COALESCE(excluded.track_number, release_tracks.track_number),
                duration_ms = COALESCE(excluded.duration_ms, release_tracks.duration_ms),
                source = excluded.source,
                updated_at = excluded.updated_at
        `, [
            releaseTrackUid,
            releaseUid,
            recordingUid,
            title,
            Number.isInteger(discNumber) && discNumber > 0 ? discNumber : null,
            Number.isInteger(trackNumber) && trackNumber > 0 ? trackNumber : null,
            Number.isFinite(durationMs) && durationMs > 0 ? Math.round(durationMs) : null,
            releaseProvider,
            now,
            now
        ]);
    }

    const artistCreditJson = metadataValueToJson(credits.map(credit => ({
        artist_uid: credit.artist_uid,
        name: credit.name,
        role: credit.role,
        join_phrase: credit.join_phrase,
        order: credit.credit_order
    })));
    const current = await getQuery(musicDb, `
        SELECT * FROM song_identifications WHERE song_id = ? AND is_current = 1 LIMIT 1
    `, [songId]);
    if (current && current.recording_uid === recordingUid &&
        (current.release_uid || null) === releaseUid &&
        (current.release_track_uid || null) === releaseTrackUid &&
        current.method === method && current.source === source) {
        await runQuery(musicDb, `
            UPDATE song_identifications
            SET confidence = ?, candidate_json = ?, artist_credit_json = ?, pipeline_version = ?, updated_at = ?
            WHERE id = ?
        `, [
            Number.isFinite(confidence) ? confidence : null,
            metadataValueToJson(safeCandidate),
            artistCreditJson,
            pipelineVersion || null,
            now,
            current.id
        ]);
    } else {
        await runQuery(musicDb, 'UPDATE song_identifications SET is_current = 0, updated_at = ? WHERE song_id = ? AND is_current = 1', [now, songId]);
        await runQuery(musicDb, `
            INSERT INTO song_identifications (
                identification_uid, song_id, recording_uid, release_uid, release_track_uid,
                method, source, confidence, candidate_json, artist_credit_json,
                pipeline_version, is_current, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
        `, [
            crypto.randomUUID(),
            songId,
            recordingUid,
            releaseUid,
            releaseTrackUid,
            method,
            source,
            Number.isFinite(confidence) ? confidence : null,
            metadataValueToJson(safeCandidate),
            artistCreditJson,
            pipelineVersion || null,
            now,
            now
        ]);
    }
    return {
        recording_uid: recordingUid,
        release_uid: releaseUid,
        release_track_uid: releaseTrackUid,
        artists: credits.map(credit => ({
            artist_uid: credit.artist_uid,
            name: credit.name,
            role: credit.role,
            join_phrase: credit.join_phrase,
            order: credit.credit_order
        })),
        method,
        source,
        confidence: Number.isFinite(confidence) ? confidence : null
    };
}

const HandleDatabase = {
    createUsersTable: async () => {
        await runQuery(usersDb, `
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL,
                password TEXT NOT NULL,
                email TEXT,
                display_name TEXT,
                bio TEXT,
                created_at TEXT NOT NULL,
                playlists TEXT,
                favorites TEXT,
                settings TEXT,
                last_login TEXT,
                notifications TEXT,
                storage_used INTEGER DEFAULT 0,
                is_admin INTEGER DEFAULT 0,
                total_likes INTEGER DEFAULT 0,
                role TEXT DEFAULT 'User',
                is_banned INTEGER DEFAULT 0,
                timeout_until TEXT,
                UNIQUE (username COLLATE NOCASE)
            )
        `);

        // Migration: Add columns if they don't exist
        const columns = await allQuery(usersDb, "PRAGMA table_info(users)");
        const columnNames = columns.map(c => c.name);

        if (!columnNames.includes('role')) {
            await runQuery(usersDb, "ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'User'");
        }
        if (!columnNames.includes('is_banned')) {
            await runQuery(usersDb, "ALTER TABLE users ADD COLUMN is_banned INTEGER DEFAULT 0");
        }
        if (!columnNames.includes('timeout_until')) {
            await runQuery(usersDb, "ALTER TABLE users ADD COLUMN timeout_until TEXT");
        }
        if (!columnNames.includes('display_name')) {
            await runQuery(usersDb, "ALTER TABLE users ADD COLUMN display_name TEXT");
        }
        if (!columnNames.includes('bio')) {
            await runQuery(usersDb, "ALTER TABLE users ADD COLUMN bio TEXT");
        }
        if (!columnNames.includes('allow_analytics')) {
            await runQuery(usersDb, "ALTER TABLE users ADD COLUMN allow_analytics INTEGER DEFAULT 1");
        }
        if (!columnNames.includes('storage_used')) {
            await runQuery(usersDb, "ALTER TABLE users ADD COLUMN storage_used INTEGER DEFAULT 0");
        }

        await runQuery(usersDb, "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_nocase ON users(username COLLATE NOCASE)");
        await runQuery(usersDb, `
            CREATE TABLE IF NOT EXISTS reserved_usernames (
                username TEXT PRIMARY KEY COLLATE NOCASE,
                reserved_at TEXT NOT NULL
            )
        `);

        // Preserve an existing Owner; otherwise claim ownership for the first account.
        const owner = await getQuery(usersDb, "SELECT id FROM users WHERE role = 'Owner' LIMIT 1");
        if (!owner) {
            const firstUser = await getQuery(usersDb, "SELECT id FROM users ORDER BY id ASC LIMIT 1");
            if (firstUser) await runQuery(usersDb, "UPDATE users SET role = 'Owner' WHERE id = ?", [firstUser.id]);
        }

        console.log("[DB] Talking: Creating/Updating users table is done!");
    },

    createTelemetryTable: async () => {
        await runQuery(usersDb, `
            CREATE TABLE IF NOT EXISTS listening_telemetry (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL,
                song_id INTEGER NOT NULL,
                listen_time REAL DEFAULT 0,
                play_count INTEGER DEFAULT 0,
                last_listened_at TEXT NOT NULL,
                UNIQUE(username, song_id)
            )
        `);
        console.log("[DB] Talking: Creating/Updating listening_telemetry table is done!");
    },

    createSessionsTable: async () => {
        await runQuery(usersDb, `
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                username TEXT NOT NULL,
                expires INTEGER NOT NULL,
                user_agent TEXT,
                ip_address TEXT,
                created_at TEXT
            )
        `);

        // Migration: Add columns if they don't exist
        const columns = await allQuery(usersDb, "PRAGMA table_info(sessions)");
        const columnNames = columns.map(c => c.name);

        if (!columnNames.includes('user_agent')) {
            await runQuery(usersDb, "ALTER TABLE sessions ADD COLUMN user_agent TEXT");
        }
        if (!columnNames.includes('ip_address')) {
            await runQuery(usersDb, "ALTER TABLE sessions ADD COLUMN ip_address TEXT");
        }
        if (!columnNames.includes('created_at')) {
            await runQuery(usersDb, "ALTER TABLE sessions ADD COLUMN created_at TEXT");
        }

        await runQuery(usersDb, "CREATE INDEX IF NOT EXISTS idx_sessions_username ON sessions(username)");
        await runQuery(usersDb, "CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires)");

        console.log("[DB] Talking: Creating/Updating sessions table is done!");
    },

    insertUser: async (username, password, email = "", role = 'User') => {
        return await runQuery(
            usersDb,
            `INSERT INTO users (username, password, email, created_at, storage_used, is_admin, total_likes, role) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [username, password, email, new Date().toISOString(), 0, 0, 0, role]
        );
    },

    registerUser: async (username, password, email = "", registrationFallback = false) => {
        return withDatabaseQueue(usersDb, async () => {
            let inTransaction = false;
            try {
                await runQuery(usersDb, "BEGIN IMMEDIATE");
                inTransaction = true;

                const countRow = await getQuery(usersDb, "SELECT COUNT(*) AS count FROM users");
                const isFirstAccount = countRow.count === 0;

                if (!isFirstAccount) {
                    const setting = await getQuery(usersDb, "SELECT value FROM system_config WHERE key = 'allow_registration'");
                    let registrationEnabled = registrationFallback === true;
                    if (setting) {
                        try {
                            registrationEnabled = JSON.parse(setting.value) === true;
                        } catch {
                            registrationEnabled = setting.value === 'true';
                        }
                    }
                    if (!registrationEnabled) {
                        await runQuery(usersDb, "ROLLBACK");
                        inTransaction = false;
                        return { status: 'registration_disabled' };
                    }
                }

                const existing = await getQuery(usersDb, "SELECT id FROM users WHERE username = ? COLLATE NOCASE", [username]);
                if (existing) {
                    await runQuery(usersDb, "ROLLBACK");
                    inTransaction = false;
                    return { status: 'username_taken' };
                }
                const reserved = await getQuery(usersDb, "SELECT username FROM reserved_usernames WHERE username = ? COLLATE NOCASE", [username]);
                if (reserved) {
                    await runQuery(usersDb, "ROLLBACK");
                    inTransaction = false;
                    return { status: 'username_taken' };
                }

                const role = isFirstAccount ? 'Owner' : 'User';
                const result = await runQuery(
                    usersDb,
                    `INSERT INTO users (username, password, email, created_at, storage_used, is_admin, total_likes, role) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                    [username, password, email, new Date().toISOString(), 0, 0, 0, role]
                );

                if (isFirstAccount) {
                    await runQuery(
                        usersDb,
                        `INSERT INTO system_config (key, value) VALUES ('allow_registration', 'false')
                         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
                    );
                }

                await runQuery(usersDb, "COMMIT");
                inTransaction = false;
                return { status: 'created', isFirstAccount, role, id: result.lastID };
            } catch (err) {
                if (inTransaction) {
                    try {
                        await runQuery(usersDb, "ROLLBACK");
                    } catch (rollbackErr) {
                        console.error("[DB] Registration rollback failed:", rollbackErr);
                    }
                }
                if (err.code === 'SQLITE_CONSTRAINT') {
                    return { status: 'username_taken' };
                }
                throw err;
            }
        });
    },

    getUser: async (username) => {
        return await getQuery(usersDb, `SELECT * FROM users WHERE username = ?`, [username]);
    },

    getUserCaseInsensitive: async (username) => {
        return await getQuery(usersDb, `SELECT * FROM users WHERE username = ? COLLATE NOCASE`, [username]);
    },

    getAllUsers: async () => {
        return await allQuery(usersDb, `SELECT id, username, display_name, bio, storage_used, total_likes, email, created_at, role, is_banned, timeout_until FROM users`);
    },

    updateUser: async (username, param, newValue) => {
        return await runQuery(usersDb, `UPDATE users SET ${param} = ? WHERE username = ?`, [newValue, username]);
    },

    incrementStorageUsed: async (username, bytes) => {
        return await runQuery(usersDb, `UPDATE users SET storage_used = storage_used + ? WHERE username = ?`, [bytes, username]);
    },

    decrementStorageUsed: async (username, bytes) => {
        return await runQuery(usersDb, `UPDATE users SET storage_used = MAX(0, storage_used - ?) WHERE username = ?`, [bytes, username]);
    },

    recalculateAllStorageUsed: async () => {
        const users = await allQuery(usersDb, `SELECT username FROM users`);
        const usageRows = await allQuery(musicDb, `
            SELECT uploaded_by,
                   COALESCE(SUM(CASE WHEN file_size_bytes > 0 THEN file_size_bytes ELSE 0 END), 0) AS total_bytes
            FROM songs
            WHERE COALESCE(availability, 'available') = 'available'
            GROUP BY uploaded_by
        `);
        const totals = new Map(usageRows.map(row => [row.uploaded_by, Number(row.total_bytes) || 0]));

        // Legacy rows may predate persisted file sizes. Only those exceptional
        // rows need filesystem I/O; normal startup uses the indexed byte count.
        const legacyRows = await allQuery(musicDb, `
            SELECT filepath, uploaded_by
            FROM songs
            WHERE COALESCE(availability, 'available') = 'available'
              AND COALESCE(file_size_bytes, 0) <= 0
        `);
        for (const song of legacyRows) {
            const fullPath = path.isAbsolute(song.filepath)
                ? song.filepath
                : path.join(RT.DATA_ROOT, song.filepath);
            try {
                if (fs.existsSync(fullPath)) {
                    const stats = fs.statSync(fullPath);
                    totals.set(song.uploaded_by, (totals.get(song.uploaded_by) || 0) + stats.size);
                }
            } catch (e) {
                console.error(`[DB] Error calculating size for ${fullPath}:`, e);
            }
        }

        for (const user of users) {
            await runQuery(usersDb, `UPDATE users SET storage_used = ? WHERE username = ?`, [totals.get(user.username) || 0, user.username]);
        }
        console.log("[DB] Recalculated storage_used for all users.");
    },

    deleteUser: async (username) => {
        return withDatabaseQueue(usersDb, async () => {
            let inTransaction = false;
            try {
                await runQuery(usersDb, 'BEGIN IMMEDIATE');
                inTransaction = true;
                await runQuery(usersDb, `INSERT OR IGNORE INTO reserved_usernames (username, reserved_at) VALUES (?, ?)`, [username, new Date().toISOString()]);
                await runQuery(usersDb, `DELETE FROM sessions WHERE username = ?`, [username]);
                await runQuery(usersDb, `DELETE FROM listening_telemetry WHERE username = ?`, [username]);
                const result = await runQuery(usersDb, `DELETE FROM users WHERE username = ?`, [username]);
                await runQuery(usersDb, 'COMMIT');
                inTransaction = false;
                return result;
            } catch (error) {
                if (inTransaction) {
                    try { await runQuery(usersDb, 'ROLLBACK'); } catch { /* preserve original error */ }
                }
                throw error;
            }
        });
    },

    deleteUserData: async (username) => {
        await runQuery(musicDb, `
            DELETE FROM playlist_songs
            WHERE playlist_id IN (SELECT id FROM playlists WHERE owner = ?)
        `, [username]);
        await runQuery(musicDb, `DELETE FROM playlists WHERE owner = ?`, [username]);
        await runQuery(lyricsDb, `DELETE FROM lyrics WHERE username = ?`, [username]);
    },

    updateUserRole: async (username, newRole) => {
        return await runQuery(usersDb, `UPDATE users SET role = ? WHERE username = ?`, [newRole, username]);
    },

    banUser: async (username, isBanned = 1) => {
        return await runQuery(usersDb, `UPDATE users SET is_banned = ? WHERE username = ?`, [isBanned, username]);
    },

    timeoutUser: async (username, until) => {
        return await runQuery(usersDb, `UPDATE users SET timeout_until = ? WHERE username = ?`, [until, username]);
    },

    // Session Management
    insertSession: async (id, username, expires, userAgent = "", ip = "") => {
        return await runQuery(
            usersDb,
            `INSERT INTO sessions (id, username, expires, user_agent, ip_address, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
            [id, username, expires, userAgent, ip, new Date().toISOString()]
        );
    },

    getSessions: async (username) => {
        return await allQuery(usersDb, `SELECT * FROM sessions WHERE username = ? ORDER BY created_at DESC`, [username]);
    },

    getSession: async (id) => {
        return await getQuery(usersDb, `SELECT * FROM sessions WHERE id = ?`, [id]);
    },

    deleteSession: async (id) => {
        return await runQuery(usersDb, `DELETE FROM sessions WHERE id = ?`, [id]);
    },

    deleteAllSessions: async (username) => {
        return await runQuery(usersDb, `DELETE FROM sessions WHERE username = ?`, [username]);
    },

    deleteOtherSessions: async (username, currentSessionId) => {
        return await runQuery(usersDb, `DELETE FROM sessions WHERE username = ? AND id != ?`, [username, currentSessionId]);
    },

    createLyricsTable: async () => {
        // SQLite doesn't support easy ALTER TABLE for primary keys, so we handle migration manually
        const columns = await allQuery(lyricsDb, "PRAGMA table_info(lyrics)");
        const columnNames = columns.map(c => c.name);

        if (columnNames.length > 0 && !columnNames.includes('username')) {
            console.log("[MIGRATION] Upgrading lyrics table to user-specific schema...");
            
            // 1. Rename old table
            await runQuery(lyricsDb, "ALTER TABLE lyrics RENAME TO lyrics_old");

            // 2. Create new table
            await runQuery(lyricsDb, `
                CREATE TABLE lyrics (
                    song_id INTEGER,
                    username TEXT,
                    lyrics TEXT NOT NULL,
                    is_synced INTEGER DEFAULT 0,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY (song_id, username)
                )
            `);

            // 3. Copy data (Migration)
            // We use '' (empty string) as the default username for legacy lyrics
            await runQuery(lyricsDb, `
                INSERT INTO lyrics (song_id, username, lyrics, is_synced, created_at, updated_at)
                SELECT song_id, '', lyrics, is_synced, created_at, updated_at FROM lyrics_old
            `);

            // 4. Drop old table
            await runQuery(lyricsDb, "DROP TABLE lyrics_old");
            console.log("[MIGRATION] Lyrics table upgraded successfully.");
        } else {
            await runQuery(lyricsDb, `
                CREATE TABLE IF NOT EXISTS lyrics (
                    song_id INTEGER,
                    username TEXT,
                    lyrics TEXT NOT NULL,
                    is_synced INTEGER DEFAULT 0,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY (song_id, username)
                )
            `);
        }
        console.log("[DB] Talking: Creating lyrics table is done!");
    },

    migrateLyrics: async () => {
        try {
            // 1. Get all songs to know owners
            const allSongs = await HandleDatabase.getAllSongs({ includeUnavailable: true });
            const songsMap = {};
            allSongs.forEach(s => songsMap[s.id] = s.uploaded_by);

            // 2. Find orphaned lyrics. We select rowid explicitly to ensure safe deletion.
            const rows = await allQuery(lyricsDb, "SELECT rowid, * FROM lyrics WHERE username IS NULL OR username = ''");
            if (!rows || rows.length === 0) return;

            console.log(`[MIGRATION] Migrating ${rows.length} lyrics to user-specific storage...`);

            for (const row of rows) {
                const owner = songsMap[row.song_id] || 'Unknown User';
                console.log(`[MIGRATION] Song ID ${row.song_id} -> Assigning to owner: ${owner}`);
                
                // 3. Save to owner (ON CONFLICT handles existing rows)
                await HandleDatabase.saveLyrics(row.song_id, owner, row.lyrics, row.is_synced);
                
                // 4. Delete orphan using its unique rowid
                await runQuery(lyricsDb, "DELETE FROM lyrics WHERE rowid = ?", [row.rowid]);
            }
            console.log("[MIGRATION] Lyrics migration complete.");
        } catch (err) {
            console.error("[MIGRATION] Lyrics migration failed:", err);
            throw err;
        }
    },

    getLyricsBySongId: async (songId, username) => {
        const query = username === null 
            ? `SELECT * FROM lyrics WHERE song_id = ? AND username IS NULL`
            : `SELECT * FROM lyrics WHERE song_id = ? AND username = ?`;
        return await getQuery(lyricsDb, query, username === null ? [songId] : [songId, username]);
    },

    saveLyrics: async (songId, username, lyrics, isSynced) => {
        const now = new Date().toISOString();
        return await runQuery(
            lyricsDb,
            `INSERT INTO lyrics (song_id, username, lyrics, is_synced, created_at, updated_at) 
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(song_id, username) DO UPDATE SET 
             lyrics = excluded.lyrics, 
             is_synced = excluded.is_synced, 
             updated_at = excluded.updated_at`,
            [songId, username, lyrics, isSynced ? 1 : 0, now, now]
        );
    },

    deleteLyrics: async (songId, username) => {
        return await runQuery(lyricsDb, `DELETE FROM lyrics WHERE song_id = ? AND username = ?`, [songId, username]);
    },

    createSongsTable: async () => {
        await runQuery(musicDb, `
            CREATE TABLE IF NOT EXISTS songs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                song_uid TEXT NOT NULL,
                recording_uid TEXT,
                songname TEXT NOT NULL,
                artist TEXT NOT NULL,
                album TEXT NOT NULL,
                genre TEXT,
                duration TEXT,
                duration_ms INTEGER,
                filepath TEXT NOT NULL,
                path_key TEXT,
                file_size_bytes INTEGER,
                file_mtime_ms INTEGER,
                created_at TEXT NOT NULL,
                uploaded_by TEXT DEFAULT 'Unknown User',
                is_private TEXT DEFAULT 'private',
                is_favorite INTEGER DEFAULT 0,
                play_count INTEGER DEFAULT 0,
                cover_path TEXT,
                cover_source_url TEXT,
                youtube_id TEXT,
                file_hash TEXT,
                bitrate INTEGER DEFAULT 128,
                source TEXT DEFAULT 'upload',
                hidden_from_library INTEGER DEFAULT 0,
                year INTEGER,
                ai_enriched INTEGER DEFAULT 0,
                availability TEXT NOT NULL DEFAULT 'available' CHECK (availability IN ('available', 'missing', 'removed')),
                metadata_status TEXT NOT NULL DEFAULT 'unreviewed' CHECK (metadata_status IN ('unreviewed', 'identified', 'review', 'unknown', 'conflict', 'error')),
                metadata_revision INTEGER NOT NULL DEFAULT 0,
                metadata_updated_at TEXT,
                metadata_pipeline_version TEXT,
                metadata_source TEXT
            )
        `);

        // Migration: Add columns if they don't exist
        const columns = await allQuery(musicDb, "PRAGMA table_info(songs)");
        const columnNames = columns.map(c => c.name);
        const migrations = [
            ['youtube_id', 'TEXT'],
            ['file_hash', 'TEXT'],
            ['bitrate', 'INTEGER DEFAULT 128'],
            ['source', "TEXT DEFAULT 'upload'"],
            ['hidden_from_library', 'INTEGER DEFAULT 0'],
            ['year', 'INTEGER'],
            ['ai_enriched', 'INTEGER DEFAULT 0'],
            ['song_uid', 'TEXT'],
            ['recording_uid', 'TEXT'],
            ['duration_ms', 'INTEGER'],
            ['path_key', 'TEXT'],
            ['file_size_bytes', 'INTEGER'],
            ['file_mtime_ms', 'INTEGER'],
            ['availability', "TEXT DEFAULT 'available'"],
            ['metadata_status', "TEXT DEFAULT 'unreviewed'"],
            ['metadata_revision', 'INTEGER DEFAULT 0'],
            ['metadata_updated_at', 'TEXT'],
            ['metadata_pipeline_version', 'TEXT'],
            ['metadata_source', 'TEXT'],
            // Public HTTPS URL the cover art came from (Apple CDN / Cover Art
            // Archive). cover_path is a LAN-only path that no external service
            // can reach, so anything that needs a publicly fetchable cover -
            // Discord Rich Presence today - reads this instead and avoids a
            // fresh provider lookup. NULL means "unknown", not "no cover".
            ['cover_source_url', 'TEXT']
        ];
        for (const [column, definition] of migrations) {
            if (!columnNames.includes(column)) {
                await runQuery(musicDb, `ALTER TABLE songs ADD COLUMN ${column} ${definition}`);
            }
        }

        const createUniqueSongUid = async () => {
            let uid;
            let existing;
            do {
                uid = crypto.randomUUID();
                existing = await getQuery(musicDb, 'SELECT id FROM songs WHERE song_uid = ?', [uid]);
            } while (existing);
            return uid;
        };

        const songsWithoutUid = await allQuery(musicDb, `
            SELECT id FROM songs WHERE song_uid IS NULL OR TRIM(song_uid) = ''
        `);
        for (const song of songsWithoutUid) {
            await runQuery(musicDb, 'UPDATE songs SET song_uid = ? WHERE id = ?', [await createUniqueSongUid(), song.id]);
        }

        // A partially-applied migration must not prevent the unique index from
        // being created. Keep the oldest row's identity and repair later copies.
        const duplicateSongUids = await allQuery(musicDb, `
            SELECT song_uid FROM songs
            WHERE song_uid IS NOT NULL AND TRIM(song_uid) != ''
            GROUP BY song_uid HAVING COUNT(*) > 1
        `);
        for (const duplicate of duplicateSongUids) {
            const duplicateRows = await allQuery(musicDb, 'SELECT id FROM songs WHERE song_uid = ? ORDER BY id', [duplicate.song_uid]);
            for (const song of duplicateRows.slice(1)) {
                await runQuery(musicDb, 'UPDATE songs SET song_uid = ? WHERE id = ?', [await createUniqueSongUid(), song.id]);
            }
        }

        const now = new Date().toISOString();
        await runQuery(musicDb, `
            UPDATE songs
            SET duration_ms = CAST(ROUND(COALESCE(CAST(duration AS REAL), 0) * 1000) AS INTEGER)
            WHERE duration_ms IS NULL
        `);
        await runQuery(musicDb, `
            UPDATE songs SET availability = 'available'
            WHERE availability IS NULL OR availability NOT IN ('available', 'missing', 'removed')
        `);
        await runQuery(musicDb, `
            UPDATE songs
            SET metadata_status = CASE WHEN COALESCE(ai_enriched, 0) = 1 THEN 'identified' ELSE 'unreviewed' END
            WHERE metadata_status IS NULL OR metadata_status NOT IN ('unreviewed', 'identified', 'review', 'unknown', 'conflict', 'error')
        `);
        await runQuery(musicDb, 'UPDATE songs SET metadata_revision = 0 WHERE metadata_revision IS NULL OR metadata_revision < 0');
        await runQuery(musicDb, `
            UPDATE songs
            SET metadata_updated_at = COALESCE(metadata_updated_at, created_at, ?),
                metadata_source = COALESCE(NULLIF(metadata_source, ''),
                    CASE WHEN COALESCE(ai_enriched, 0) = 1 THEN 'smart-auto-enrich-legacy' ELSE 'legacy' END)
        `, [now]);

        // Stat-only backfill is safe for every source and avoids hashing files
        // during migration. The active folder scan fills and reconciles the rest.
        const songsWithoutFileEvidence = await allQuery(musicDb, `
            SELECT id, filepath FROM songs
            WHERE file_size_bytes IS NULL OR file_mtime_ms IS NULL
        `);
        for (const song of songsWithoutFileEvidence) {
            const fullPath = path.isAbsolute(song.filepath)
                ? song.filepath
                : path.resolve(RT.DATA_ROOT, song.filepath);
            try {
                const stats = fs.statSync(fullPath);
                if (stats.isFile()) {
                    await runQuery(musicDb, `
                        UPDATE songs
                        SET file_size_bytes = COALESCE(file_size_bytes, ?),
                            file_mtime_ms = COALESCE(file_mtime_ms, ?)
                        WHERE id = ?
                    `, [stats.size, Math.trunc(stats.mtimeMs), song.id]);
                }
            } catch {
                // Missing files are reconciled only by a successful folder scan.
            }
        }

        // filepath preserves the original spelling for display and opening.
        // Cross-platform uniqueness is enforced by the canonical path_key.
        await runQuery(musicDb, "DROP INDEX IF EXISTS idx_songs_filepath");
        await runQuery(musicDb, "CREATE INDEX IF NOT EXISTS idx_songs_filepath_lookup ON songs(filepath)");
        await HandleDatabase.reconcileSongPathKeys();
        await runQuery(musicDb, "CREATE UNIQUE INDEX IF NOT EXISTS idx_songs_song_uid ON songs(song_uid)");
        await runQuery(musicDb, "CREATE INDEX IF NOT EXISTS idx_songs_uploaded_by ON songs(uploaded_by)");
        await runQuery(musicDb, "CREATE INDEX IF NOT EXISTS idx_songs_source ON songs(source)");
        await runQuery(musicDb, "CREATE INDEX IF NOT EXISTS idx_songs_recording_uid ON songs(recording_uid)");
        await runQuery(musicDb, "CREATE INDEX IF NOT EXISTS idx_songs_availability ON songs(availability)");
        await runQuery(musicDb, "CREATE INDEX IF NOT EXISTS idx_songs_metadata_status ON songs(metadata_status)");
        await runQuery(musicDb, "CREATE INDEX IF NOT EXISTS idx_songs_file_hash_availability ON songs(file_hash, availability)");

        // Migration: Fix legacy raw bitrates stored in bps instead of kbps (e.g. 192000 -> 192)
        await runQuery(musicDb, "UPDATE songs SET bitrate = ROUND(bitrate / 1000) WHERE bitrate > 1000");

        console.log("[DB] Talking: Creating/Updating songs table is done!");
    },

    insertSong: async (songname, artist, album, genre, duration, filepath, uploaded_by = "Unknown User", visibility = "private", youtube_id = null, file_hash = null, bitrate = 128, source = "upload", year = null, ai_enriched = 0, cover_path = null, metadata = {}) => {
        metadata = metadata && typeof metadata === 'object' ? metadata : {};
        const now = new Date().toISOString();
        const pathKey = canonicalSongPathKey(filepath);
        const numericDuration = Number(duration);
        const durationMs = Number.isFinite(metadata.duration_ms)
            ? Math.max(0, Math.round(metadata.duration_ms))
            : (Number.isFinite(numericDuration) ? Math.max(0, Math.round(numericDuration * 1000)) : 0);
        const availability = SONG_AVAILABILITIES.has(metadata.availability) ? metadata.availability : 'available';
        const metadataStatus = METADATA_STATUSES.has(metadata.metadata_status)
            ? metadata.metadata_status
            : (ai_enriched ? 'identified' : 'unreviewed');
        return await runQuery(
            musicDb,
            `INSERT OR IGNORE INTO songs (
                song_uid, recording_uid, songname, artist, album, genre, duration, duration_ms,
                filepath, path_key, file_size_bytes, file_mtime_ms, created_at, uploaded_by, is_private,
                is_favorite, play_count, youtube_id, file_hash, bitrate, source, year, ai_enriched,
                cover_path, availability, metadata_status, metadata_revision, metadata_updated_at,
                metadata_pipeline_version, metadata_source
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                metadata.song_uid || crypto.randomUUID(), metadata.recording_uid || null,
                songname, artist, album, genre, duration, durationMs, filepath, pathKey,
                Number.isFinite(metadata.file_size_bytes) ? metadata.file_size_bytes : null,
                Number.isFinite(metadata.file_mtime_ms) ? Math.trunc(metadata.file_mtime_ms) : null,
                now, uploaded_by, visibility, 0, 0, youtube_id, file_hash, bitrate, source, year,
                ai_enriched, cover_path, availability, metadataStatus,
                Number.isInteger(metadata.metadata_revision) ? metadata.metadata_revision : 0,
                metadata.metadata_updated_at || now, metadata.metadata_pipeline_version || null,
                metadata.metadata_source || (ai_enriched ? 'smart-auto-enrich' : (source === 'folder' ? 'embedded' : 'legacy'))
            ]
        );
    },

    getSongByMetadata: async (username, { youtube_id = null, file_hash = null }) => {
        if (youtube_id) {
            return await getQuery(musicDb, `SELECT * FROM songs WHERE uploaded_by = ? AND youtube_id = ?`, [username, youtube_id]);
        }
        if (file_hash) {
            return await getQuery(musicDb, `SELECT * FROM songs WHERE uploaded_by = ? AND file_hash = ?`, [username, file_hash]);
        }
        return null;
    },

    getSongPathKey: (filepath) => canonicalSongPathKey(filepath),

    getSongByPathKey: async (pathKey) => {
        const canonicalKey = canonicalSongPathKey(pathKey);
        if (!canonicalKey) return null;
        return await getQuery(musicDb, `
            SELECT s.*, si.release_uid AS identified_release_uid,
                   si.release_track_uid AS identified_release_track_uid,
                   si.artist_credit_json AS identity_artist_credit_json,
                   si.method AS identification_method, si.source AS identification_source,
                   si.confidence AS identification_confidence
            FROM songs s
            LEFT JOIN song_identifications si ON si.song_id = s.id AND si.is_current = 1
            WHERE s.path_key = ?
        `, [canonicalKey]);
    },

    getSongByFilepath: async (filepath) => {
        return await HandleDatabase.getSongByPathKey(canonicalSongPathKey(filepath));
    },

    getSongByUid: async (songUid, { includeUnavailable = false } = {}) => {
        const availabilityClause = includeUnavailable ? '' : "AND COALESCE(availability, 'available') = 'available'";
        return await getQuery(musicDb, `
            SELECT s.*, si.release_uid AS identified_release_uid,
                   si.release_track_uid AS identified_release_track_uid,
                   si.artist_credit_json AS identity_artist_credit_json,
                   si.method AS identification_method, si.source AS identification_source,
                   si.confidence AS identification_confidence
            FROM songs s
            LEFT JOIN song_identifications si ON si.song_id = s.id AND si.is_current = 1
            WHERE s.song_uid = ? ${availabilityClause}
        `, [songUid]);
    },

    getSong: async (identifier, { includeUnavailable = false } = {}) => {
        // Try to get by ID if it's a number, otherwise by name
        const isNumericIdentifier = typeof identifier === 'number' || /^\d+$/.test(String(identifier || '').trim());
        const availabilityClause = includeUnavailable ? '' : "AND COALESCE(availability, 'available') = 'available'";
        if (isNumericIdentifier) {
            return await getQuery(musicDb, `
                SELECT s.*, si.release_uid AS identified_release_uid,
                       si.release_track_uid AS identified_release_track_uid,
                       si.artist_credit_json AS identity_artist_credit_json,
                       si.method AS identification_method, si.source AS identification_source,
                       si.confidence AS identification_confidence
                FROM songs s
                LEFT JOIN song_identifications si ON si.song_id = s.id AND si.is_current = 1
                WHERE s.id = ? ${availabilityClause}
            `, [identifier]);
        }
        return await getQuery(musicDb, `
            SELECT s.*, si.release_uid AS identified_release_uid,
                   si.release_track_uid AS identified_release_track_uid,
                   si.artist_credit_json AS identity_artist_credit_json,
                   si.method AS identification_method, si.source AS identification_source,
                   si.confidence AS identification_confidence
            FROM songs s
            LEFT JOIN song_identifications si ON si.song_id = s.id AND si.is_current = 1
            WHERE (s.song_uid = ? OR s.songname = ?) ${availabilityClause}
            ORDER BY CASE WHEN s.song_uid = ? THEN 0 ELSE 1 END
            LIMIT 1
        `, [identifier, identifier, identifier]);
    },

    getAllSongs: async ({ includeUnavailable = false } = {}) => {
        const availabilityClause = includeUnavailable ? '' : "WHERE COALESCE(availability, 'available') = 'available'";
        return await allQuery(musicDb, `
            SELECT s.*, si.release_uid AS identified_release_uid,
                   si.release_track_uid AS identified_release_track_uid,
                   si.artist_credit_json AS identity_artist_credit_json,
                   si.method AS identification_method, si.source AS identification_source,
                   si.confidence AS identification_confidence
            FROM songs s
            LEFT JOIN song_identifications si ON si.song_id = s.id AND si.is_current = 1
            ${availabilityClause}
        `);
    },

    getSongsCount: async ({ includeUnavailable = false } = {}) => {
        const availabilityClause = includeUnavailable ? '' : "WHERE COALESCE(availability, 'available') = 'available'";
        const row = await getQuery(musicDb, `SELECT COUNT(*) as count FROM songs ${availabilityClause}`);
        return row ? row.count : 0;
    },

    getSongsByUser: async (username, { includeUnavailable = false } = {}) => {
        const availabilityClause = includeUnavailable ? '' : "AND COALESCE(availability, 'available') = 'available'";
        return await allQuery(musicDb, `
            SELECT s.*, si.release_uid AS identified_release_uid,
                   si.release_track_uid AS identified_release_track_uid,
                   si.artist_credit_json AS identity_artist_credit_json,
                   si.method AS identification_method, si.source AS identification_source,
                   si.confidence AS identification_confidence
            FROM songs s
            LEFT JOIN song_identifications si ON si.song_id = s.id AND si.is_current = 1
            WHERE s.uploaded_by = ? ${availabilityClause}
        `, [username]);
    },

    getUniqueMissingSongByFileHash: async (fileHash) => {
        if (!fileHash) return null;
        const matches = await allQuery(musicDb, `
            SELECT * FROM songs
            WHERE file_hash = ? AND source = 'folder' AND availability = 'missing'
            ORDER BY id
            LIMIT 2
        `, [fileHash]);
        return matches.length === 1 ? matches[0] : null;
    },

    setSongsAvailability: async (songIds, availability) => {
        if (!Array.isArray(songIds) || songIds.length === 0) return { changes: 0 };
        if (!SONG_AVAILABILITIES.has(availability)) throw new Error(`Invalid song availability: ${availability}`);
        const ids = [...new Set(songIds.map(Number).filter(Number.isInteger))];
        if (ids.length === 0) return { changes: 0 };
        const placeholders = ids.map(() => '?').join(', ');
        return await runQuery(musicDb, `UPDATE songs SET availability = ? WHERE id IN (${placeholders})`, [availability, ...ids]);
    },

    reconcileSongPathKeys: serializeTransaction(musicDb, async () => {
        const now = new Date().toISOString();
        let inTransaction = false;
        try {
            await runQuery(musicDb, 'BEGIN IMMEDIATE');
            inTransaction = true;
            await runQuery(musicDb, 'DROP INDEX IF EXISTS idx_songs_path_key');

            const rows = await allQuery(musicDb, `
                SELECT id, filepath, availability
                FROM songs
                ORDER BY id
            `);
            await runQuery(musicDb, `
                UPDATE songs SET path_key = NULL
                WHERE availability = 'removed' OR filepath IS NULL OR filepath = ''
            `);

            const groups = new Map();
            for (const row of rows) {
                if (row.availability === 'removed') continue;
                const pathKey = canonicalSongPathKey(row.filepath);
                if (!pathKey) continue;
                if (!groups.has(pathKey)) groups.set(pathKey, []);
                groups.get(pathKey).push(row);
            }

            const playlistSongsTable = await getQuery(musicDb, `
                SELECT 1 AS present FROM sqlite_master
                WHERE type = 'table' AND name = 'playlist_songs'
            `);
            const identificationsTable = await getQuery(musicDb, `
                SELECT 1 AS present FROM sqlite_master
                WHERE type = 'table' AND name = 'song_identifications'
            `);
            let retired = 0;

            for (const [pathKey, duplicates] of groups) {
                duplicates.sort((left, right) => {
                    const availabilityRank = value => value === 'available' ? 0 : (value === 'missing' ? 1 : 2);
                    return availabilityRank(left.availability) - availabilityRank(right.availability) || left.id - right.id;
                });
                const canonical = duplicates[0];
                await runQuery(musicDb, 'UPDATE songs SET path_key = ? WHERE id = ?', [pathKey, canonical.id]);

                for (const duplicate of duplicates.slice(1)) {
                    if (playlistSongsTable) {
                        // Membership rows that do not conflict retain their row id,
                        // ordering, and added_at timestamp on the canonical song.
                        await runQuery(musicDb, `
                            UPDATE OR IGNORE playlist_songs SET song_id = ? WHERE song_id = ?
                        `, [canonical.id, duplicate.id]);
                    }
                    if (identificationsTable) {
                        await runQuery(musicDb, `
                            UPDATE song_identifications
                            SET is_current = 0, updated_at = ?
                            WHERE song_id = ? AND is_current = 1
                        `, [now, duplicate.id]);
                    }
                    await runQuery(musicDb, `
                        UPDATE songs
                        SET path_key = NULL,
                            availability = 'removed',
                            metadata_status = 'conflict',
                            metadata_revision = COALESCE(metadata_revision, 0) + 1,
                            metadata_updated_at = ?
                        WHERE id = ?
                    `, [now, duplicate.id]);
                    retired++;
                }
            }

            if (identificationsTable) {
                await runQuery(musicDb, `
                    UPDATE song_identifications
                    SET is_current = 0, updated_at = ?
                    WHERE is_current = 1
                      AND song_id IN (
                          SELECT id FROM songs
                          WHERE availability = 'removed' AND path_key IS NULL
                      )
                `, [now]);
            }

            await runQuery(musicDb, `
                CREATE UNIQUE INDEX IF NOT EXISTS idx_songs_path_key
                ON songs(path_key) WHERE path_key IS NOT NULL
            `);
            await runQuery(musicDb, 'COMMIT');
            inTransaction = false;
            return { canonicalPaths: groups.size, retired };
        } catch (error) {
            if (inTransaction) {
                try { await runQuery(musicDb, 'ROLLBACK'); } catch { /* preserve original error */ }
            }
            throw error;
        }
    }),

    deleteSong: async (id) => {
        return await runQuery(musicDb, `DELETE FROM songs WHERE id = ?`, [id]);
    },

    updateSong: async (id, updates) => {
        const normalizedUpdates = { ...(updates || {}) };
        if (Object.prototype.hasOwnProperty.call(normalizedUpdates, 'filepath')) {
            normalizedUpdates.path_key = canonicalSongPathKey(normalizedUpdates.filepath);
        }
        const fields = Object.keys(normalizedUpdates);
        if (fields.length === 0) return { changes: 0 };
        const values = fields.map(field => normalizedUpdates[field]);
        const setClause = fields.map(f => `${f} = ?`).join(', ');
        const result = await runQuery(musicDb, `UPDATE songs SET ${setClause} WHERE id = ?`, [...values, id]);
        if (fields.some(field => ['songname', 'artist', 'duration', 'duration_ms', 'cover_path', 'cover_source_url'].includes(field))) {
            await runQuery(musicDb, 'DELETE FROM discord_artwork_cache WHERE song_id = ?', [id]);
        }
        return result;
    },

    /* --- Public cover source URL -------------------------------------------
     * songs.cover_path points at /Static/covers/..., which only resolves on the
     * LAN. Discord's media proxy fetches artwork server-side, so it needs a
     * publicly reachable HTTPS URL instead.
     *
     * Smart Auto already resolves exactly such a URL (Apple CDN or the Cover Art
     * Archive) before it downloads the image, so we record it and never have to
     * ask a provider again. Callers must pass an already-validated URL - the
     * trust check lives in AIMetadata.isTrustedCoverUrl and stays there so there
     * is a single allowlist. Pass null to clear a stale value. */
    setSongCoverSourceUrl: async (id, url) => {
        const value = typeof url === 'string' && url.trim() ? url.trim().slice(0, 2048) : null;
        const result = await runQuery(musicDb, 'UPDATE songs SET cover_source_url = ? WHERE id = ?', [value, id]);
        await runQuery(musicDb, 'DELETE FROM discord_artwork_cache WHERE song_id = ?', [id]);
        return result;
    },

    getSongCoverSourceUrl: async (id) => {
        const row = await getQuery(musicDb, 'SELECT cover_source_url FROM songs WHERE id = ?', [id]);
        return row && row.cover_source_url ? row.cover_source_url : null;
    },

    createDiscordArtworkCacheTable: async () => {
        await runQuery(musicDb, `
            CREATE TABLE IF NOT EXISTS discord_artwork_cache (
                song_id INTEGER PRIMARY KEY,
                status TEXT NOT NULL,
                lookup_mode TEXT NOT NULL,
                source TEXT,
                artwork_url TEXT,
                video_id TEXT,
                matched_title TEXT,
                matched_duration INTEGER,
                confidence REAL,
                reason TEXT,
                checked_at TEXT NOT NULL,
                expires_at TEXT NOT NULL,
                FOREIGN KEY (song_id) REFERENCES songs(id) ON DELETE CASCADE
            )
        `);
        await runQuery(musicDb, 'CREATE INDEX IF NOT EXISTS idx_discord_artwork_expiry ON discord_artwork_cache(expires_at)');
    },

    getDiscordArtworkCache: async songId => {
        return await getQuery(musicDb, 'SELECT * FROM discord_artwork_cache WHERE song_id = ?', [songId]);
    },

    setDiscordArtworkCache: async (songId, entry = {}) => {
        const checkedAt = entry.checkedAt || new Date().toISOString();
        const expiresAt = entry.expiresAt || checkedAt;
        await runQuery(musicDb, `
            INSERT INTO discord_artwork_cache (
                song_id, status, lookup_mode, source, artwork_url, video_id, matched_title,
                matched_duration, confidence, reason, checked_at, expires_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(song_id) DO UPDATE SET
                status = excluded.status,
                lookup_mode = excluded.lookup_mode,
                source = excluded.source,
                artwork_url = excluded.artwork_url,
                video_id = excluded.video_id,
                matched_title = excluded.matched_title,
                matched_duration = excluded.matched_duration,
                confidence = excluded.confidence,
                reason = excluded.reason,
                checked_at = excluded.checked_at,
                expires_at = excluded.expires_at
        `, [
            songId,
            entry.status || 'miss',
            entry.lookupMode || 'stored_only',
            entry.source || null,
            entry.artworkUrl || null,
            entry.videoId || null,
            entry.matchedTitle || null,
            Number.isFinite(entry.matchedDuration) ? Math.round(entry.matchedDuration) : null,
            Number.isFinite(entry.confidence) ? entry.confidence : null,
            entry.reason || null,
            checkedAt,
            expiresAt
        ]);
        return await getQuery(musicDb, 'SELECT * FROM discord_artwork_cache WHERE song_id = ?', [songId]);
    },

    clearDiscordArtworkCache: async songId => {
        return await runQuery(musicDb, 'DELETE FROM discord_artwork_cache WHERE song_id = ?', [songId]);
    },

    updateSongScanEvidence: async (id, updates, { evidenceChanged = false } = {}) => {
        const allowedFields = new Set([
            'filepath', 'path_key', 'duration', 'duration_ms', 'file_hash', 'file_size_bytes',
            'file_mtime_ms', 'bitrate', 'uploaded_by', 'is_private', 'source',
            'availability', 'cover_path', 'metadata_pipeline_version'
        ]);
        const normalizedUpdates = { ...(updates || {}) };
        if (Object.prototype.hasOwnProperty.call(normalizedUpdates, 'filepath')) {
            normalizedUpdates.path_key = canonicalSongPathKey(normalizedUpdates.filepath);
        }
        const fields = Object.keys(normalizedUpdates).filter(field => allowedFields.has(field));
        const setters = fields.map(field => `${field} = ?`);
        const values = fields.map(field => normalizedUpdates[field]);
        if (evidenceChanged) {
            setters.push(
                "metadata_status = CASE WHEN metadata_status = 'conflict' THEN 'conflict' ELSE 'review' END",
                'metadata_revision = COALESCE(metadata_revision, 0) + 1',
                'metadata_updated_at = ?'
            );
            values.push(new Date().toISOString());
        }
        if (setters.length === 0) return { changes: 0 };
        return await runQuery(musicDb, `UPDATE songs SET ${setters.join(', ')} WHERE id = ?`, [...values, id]);
    },

    invalidateSongIdentityForFileReplacement: serializeTransaction(musicDb, async (id, updates, {
        previousFileHash,
        embeddedProvenance = {},
        embeddedIdentifiers = []
    } = {}) => {
        const allowedFields = new Set([
            'filepath', 'path_key', 'duration', 'duration_ms', 'file_hash', 'file_size_bytes',
            'file_mtime_ms', 'bitrate', 'uploaded_by', 'is_private', 'source',
            'availability', 'cover_path', 'metadata_pipeline_version'
        ]);
        const normalizedUpdates = { ...(updates || {}) };
        if (Object.prototype.hasOwnProperty.call(normalizedUpdates, 'filepath')) {
            normalizedUpdates.path_key = canonicalSongPathKey(normalizedUpdates.filepath);
        }
        const scanUpdates = Object.fromEntries(
            Object.entries(normalizedUpdates).filter(([field]) => allowedFields.has(field))
        );
        const newFileHash = String(scanUpdates.file_hash || '').trim();
        if (!newFileHash) throw new Error('A replacement file hash is required');

        const now = new Date().toISOString();
        let inTransaction = false;
        try {
            await runQuery(musicDb, 'BEGIN IMMEDIATE');
            inTransaction = true;
            const current = await getQuery(musicDb, `
                SELECT id, file_hash, recording_uid, metadata_revision
                FROM songs WHERE id = ?
            `, [id]);
            if (!current) {
                await runQuery(musicDb, 'ROLLBACK');
                inTransaction = false;
                return { invalidated: false, notFound: true };
            }

            const currentHash = String(current.file_hash || '').trim();
            if (currentHash && currentHash === newFileHash) {
                await runQuery(musicDb, 'ROLLBACK');
                inTransaction = false;
                return { invalidated: false, hashChanged: false };
            }
            if (previousFileHash !== undefined && currentHash !== String(previousFileHash || '').trim()) {
                await runQuery(musicDb, 'ROLLBACK');
                inTransaction = false;
                return { invalidated: false, stale: true, currentFileHash: currentHash };
            }

            const currentRevision = Number(current.metadata_revision) || 0;
            const fields = Object.keys(scanUpdates);
            const setters = fields.map(field => `${field} = ?`);
            const values = fields.map(field => scanUpdates[field]);
            setters.push(
                'recording_uid = NULL',
                'ai_enriched = 0',
                "metadata_status = 'conflict'",
                'metadata_revision = COALESCE(metadata_revision, 0) + 1',
                'metadata_updated_at = ?'
            );
            const hashPredicate = currentHash
                ? 'file_hash = ?'
                : "(file_hash IS NULL OR TRIM(file_hash) = '')";
            values.push(now, id);
            if (currentHash) values.push(currentHash);
            values.push(currentRevision);
            const update = await runQuery(musicDb, `
                UPDATE songs SET ${setters.join(', ')}
                WHERE id = ? AND ${hashPredicate} AND COALESCE(metadata_revision, 0) = ?
            `, values);
            if (update.changes !== 1) {
                await runQuery(musicDb, 'ROLLBACK');
                inTransaction = false;
                return { invalidated: false, stale: true };
            }

            // Canonical recording/release rows remain as history. Only this
            // song's accepted projection and consumable evidence are retired.
            await runQuery(musicDb, `
                UPDATE song_identifications
                SET is_current = 0, updated_at = ?
                WHERE song_id = ? AND is_current = 1
            `, [now, id]);
            await runQuery(musicDb, 'DELETE FROM external_identifiers WHERE song_id = ?', [id]);
            await runQuery(musicDb, 'DELETE FROM metadata_provenance WHERE song_id = ?', [id]);

            for (const identifier of normalizeExternalIdentifiers(embeddedIdentifiers)) {
                await runQuery(musicDb, `
                    INSERT INTO external_identifiers (
                        song_id, identifier_type, identifier_value, source, created_at, updated_at
                    ) VALUES (?, ?, ?, 'embedded', ?, ?)
                `, [id, identifier.type, identifier.value, now, now]);
            }

            const provenanceEntries = Array.isArray(embeddedProvenance)
                ? embeddedProvenance.map(entry => ({
                    field: entry && (entry.field || entry.field_name),
                    value: entry && entry.value,
                    confidence: entry && entry.confidence
                }))
                : Object.entries(embeddedProvenance || {}).map(([field, value]) => ({ field, value }));
            for (const entry of provenanceEntries) {
                if (!entry.field || entry.value === undefined || entry.value === null) continue;
                await runQuery(musicDb, `
                    INSERT INTO metadata_provenance (
                        song_id, field_name, value_json, source, confidence, is_locked, created_at, updated_at
                    ) VALUES (?, ?, ?, 'embedded', ?, 0, ?, ?)
                `, [
                    id,
                    String(entry.field),
                    metadataValueToJson(entry.value),
                    Number.isFinite(entry.confidence) ? entry.confidence : null,
                    now,
                    now
                ]);
            }

            await runQuery(musicDb, 'COMMIT');
            inTransaction = false;
            return {
                invalidated: true,
                previousRecordingUid: current.recording_uid || null,
                metadataRevision: currentRevision + 1
            };
        } catch (error) {
            if (inTransaction) {
                try { await runQuery(musicDb, 'ROLLBACK'); } catch { /* preserve original error */ }
            }
            throw error;
        }
    }),

    updateSongMetadata: serializeTransaction(musicDb, async (id, updates, options = {}) => {
        const allowedFields = new Set([
            'songname', 'artist', 'album', 'genre', 'year', 'cover_path',
            'recording_uid', 'ai_enriched'
        ]);
        const metadataUpdates = Object.fromEntries(
            Object.entries(updates || {}).filter(([field]) => allowedFields.has(field))
        );
        const status = METADATA_STATUSES.has(options.status) ? options.status : 'identified';
        const source = String(options.source || 'manual');
        const pipelineVersion = options.pipelineVersion || null;
        const now = new Date().toISOString();
        let inTransaction = false;

        try {
            await runQuery(musicDb, 'BEGIN IMMEDIATE');
            inTransaction = true;
            const existing = await getQuery(musicDb, 'SELECT metadata_revision FROM songs WHERE id = ?', [id]);
            if (!existing) {
                await runQuery(musicDb, 'ROLLBACK');
                inTransaction = false;
                return { updated: false, notFound: true };
            }

            const currentRevision = Number(existing.metadata_revision) || 0;
            if (options.expectedRevision !== undefined && Number(options.expectedRevision) !== currentRevision) {
                await runQuery(musicDb, 'ROLLBACK');
                inTransaction = false;
                return { updated: false, conflict: true, currentRevision };
            }

            if (options.rejectLocked) {
                const lockedRows = await allQuery(musicDb, `
                    SELECT DISTINCT field_name FROM metadata_provenance
                    WHERE song_id = ? AND is_locked = 1
                `, [id]);
                const locked = new Set(lockedRows.map(row => normalizeMetadataField(row.field_name)));
                const lockedFields = Object.keys(metadataUpdates)
                    .filter(field => field !== 'ai_enriched' && locked.has(normalizeMetadataField(field)));
                if (lockedFields.length) {
                    await runQuery(musicDb, 'ROLLBACK');
                    inTransaction = false;
                    return { updated: false, lockedFields };
                }
            }

            const fields = Object.keys(metadataUpdates);
            const values = Object.values(metadataUpdates);
            const setters = fields.map(field => `${field} = ?`);
            setters.push(
                'metadata_status = ?',
                'metadata_revision = COALESCE(metadata_revision, 0) + 1',
                'metadata_updated_at = ?',
                'metadata_pipeline_version = ?',
                'metadata_source = ?'
            );
            values.push(status, now, pipelineVersion, source, id, currentRevision);
            const update = await runQuery(musicDb, `
                UPDATE songs SET ${setters.join(', ')}
                WHERE id = ? AND COALESCE(metadata_revision, 0) = ?
            `, values);
            if (update.changes !== 1) {
                await runQuery(musicDb, 'ROLLBACK');
                inTransaction = false;
                const current = await getQuery(musicDb, 'SELECT metadata_revision FROM songs WHERE id = ?', [id]);
                return { updated: false, conflict: true, currentRevision: current ? Number(current.metadata_revision) || 0 : null };
            }

            const confidence = Number.isFinite(options.confidence) ? options.confidence : null;
            for (const [field, value] of Object.entries(metadataUpdates)) {
                const isLocked = shouldLockMetadataField(options.lockFields, field) ? 1 : 0;
                await runQuery(musicDb, `
                    INSERT INTO metadata_provenance (
                        song_id, field_name, value_json, source, confidence, is_locked, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(song_id, field_name, source) DO UPDATE SET
                        value_json = excluded.value_json,
                        confidence = excluded.confidence,
                        is_locked = MAX(metadata_provenance.is_locked, excluded.is_locked),
                        updated_at = excluded.updated_at
                `, [id, field, metadataValueToJson(value), source, confidence, isLocked, now, now]);
            }

            const song = await getQuery(musicDb, 'SELECT * FROM songs WHERE id = ?', [id]);
            await runQuery(musicDb, 'COMMIT');
            inTransaction = false;
            return { updated: true, conflict: false, song };
        } catch (error) {
            if (inTransaction) {
                try { await runQuery(musicDb, 'ROLLBACK'); } catch { /* preserve original error */ }
            }
            throw error;
        }
    }),

    createMetadataTables: async () => {
        await runQuery(musicDb, `
            CREATE TABLE IF NOT EXISTS external_identifiers (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                song_id INTEGER NOT NULL,
                identifier_type TEXT NOT NULL,
                identifier_value TEXT NOT NULL,
                source TEXT NOT NULL DEFAULT 'unknown',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY (song_id) REFERENCES songs(id) ON DELETE CASCADE,
                UNIQUE(song_id, identifier_type, identifier_value, source)
            )
        `);
        await runQuery(musicDb, `
            CREATE TABLE IF NOT EXISTS metadata_provenance (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                song_id INTEGER NOT NULL,
                field_name TEXT NOT NULL,
                value_json TEXT,
                source TEXT NOT NULL,
                confidence REAL,
                is_locked INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY (song_id) REFERENCES songs(id) ON DELETE CASCADE,
                UNIQUE(song_id, field_name, source)
            )
        `);
        await runQuery(musicDb, `
            CREATE TABLE IF NOT EXISTS recordings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                recording_uid TEXT NOT NULL UNIQUE,
                title TEXT,
                duration_ms INTEGER,
                first_release_year INTEGER,
                source TEXT,
                confidence REAL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
        `);
        await runQuery(musicDb, `
            CREATE TABLE IF NOT EXISTS artists (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                artist_uid TEXT NOT NULL UNIQUE,
                name TEXT NOT NULL,
                sort_name TEXT,
                source TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
        `);
        await runQuery(musicDb, `
            CREATE TABLE IF NOT EXISTS recording_artists (
                recording_uid TEXT NOT NULL,
                artist_uid TEXT NOT NULL,
                credit_order INTEGER NOT NULL DEFAULT 0,
                role TEXT NOT NULL DEFAULT 'primary',
                credited_name TEXT,
                join_phrase TEXT NOT NULL DEFAULT '',
                PRIMARY KEY (recording_uid, credit_order),
                FOREIGN KEY (recording_uid) REFERENCES recordings(recording_uid) ON DELETE CASCADE,
                FOREIGN KEY (artist_uid) REFERENCES artists(artist_uid) ON DELETE CASCADE
            )
        `);
        await runQuery(musicDb, `
            CREATE TABLE IF NOT EXISTS releases (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                release_uid TEXT NOT NULL UNIQUE,
                title TEXT,
                release_date TEXT,
                release_year INTEGER,
                country TEXT,
                release_status TEXT,
                release_group_type TEXT,
                source TEXT,
                confidence REAL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
        `);
        await runQuery(musicDb, `
            CREATE TABLE IF NOT EXISTS release_tracks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                release_track_uid TEXT NOT NULL UNIQUE,
                release_uid TEXT NOT NULL,
                recording_uid TEXT NOT NULL,
                title TEXT,
                disc_number INTEGER,
                track_number INTEGER,
                duration_ms INTEGER,
                source TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY (release_uid) REFERENCES releases(release_uid) ON DELETE CASCADE,
                FOREIGN KEY (recording_uid) REFERENCES recordings(recording_uid) ON DELETE CASCADE
            )
        `);
        await runQuery(musicDb, `
            CREATE TABLE IF NOT EXISTS song_identifications (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                identification_uid TEXT NOT NULL UNIQUE,
                song_id INTEGER NOT NULL,
                recording_uid TEXT NOT NULL,
                release_uid TEXT,
                release_track_uid TEXT,
                method TEXT NOT NULL,
                source TEXT NOT NULL,
                confidence REAL,
                candidate_json TEXT,
                artist_credit_json TEXT,
                pipeline_version TEXT,
                is_current INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY (song_id) REFERENCES songs(id) ON DELETE CASCADE,
                FOREIGN KEY (recording_uid) REFERENCES recordings(recording_uid) ON DELETE RESTRICT,
                FOREIGN KEY (release_uid) REFERENCES releases(release_uid) ON DELETE SET NULL,
                FOREIGN KEY (release_track_uid) REFERENCES release_tracks(release_track_uid) ON DELETE SET NULL
            )
        `);
        await runQuery(musicDb, `
            CREATE TABLE IF NOT EXISTS enrichment_jobs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                job_uid TEXT NOT NULL UNIQUE,
                requested_by TEXT,
                mode TEXT NOT NULL DEFAULT 'auto',
                status TEXT NOT NULL DEFAULT 'queued',
                pipeline_version TEXT,
                options_json TEXT,
                total_items INTEGER NOT NULL DEFAULT 0,
                processed_items INTEGER NOT NULL DEFAULT 0,
                succeeded_items INTEGER NOT NULL DEFAULT 0,
                failed_items INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                started_at TEXT,
                completed_at TEXT,
                error TEXT
            )
        `);
        await runQuery(musicDb, `
            CREATE TABLE IF NOT EXISTS enrichment_job_items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                job_id INTEGER NOT NULL,
                song_id INTEGER NOT NULL,
                status TEXT NOT NULL DEFAULT 'queued',
                metadata_revision INTEGER NOT NULL DEFAULT 0,
                attempts INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                started_at TEXT,
                completed_at TEXT,
                error TEXT,
                result_json TEXT,
                decision TEXT,
                decision_json TEXT,
                selected_candidate_id INTEGER,
                decided_by TEXT,
                decided_at TEXT,
                FOREIGN KEY (job_id) REFERENCES enrichment_jobs(id) ON DELETE CASCADE,
                FOREIGN KEY (song_id) REFERENCES songs(id) ON DELETE CASCADE,
                UNIQUE(job_id, song_id)
            )
        `);
        await runQuery(musicDb, `
            CREATE TABLE IF NOT EXISTS enrichment_candidates (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                job_item_id INTEGER NOT NULL,
                song_id INTEGER NOT NULL,
                provider TEXT NOT NULL,
                provider_recording_id TEXT,
                rank INTEGER NOT NULL DEFAULT 0,
                confidence REAL,
                status TEXT NOT NULL DEFAULT 'pending',
                payload_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY (job_item_id) REFERENCES enrichment_job_items(id) ON DELETE CASCADE,
                FOREIGN KEY (song_id) REFERENCES songs(id) ON DELETE CASCADE
            )
        `);
        await runQuery(musicDb, `
            CREATE TABLE IF NOT EXISTS metadata_lookup_cache (
                cache_key TEXT PRIMARY KEY,
                provider TEXT NOT NULL,
                query_json TEXT,
                result_json TEXT,
                status TEXT NOT NULL DEFAULT 'success',
                error TEXT,
                expires_at INTEGER,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
        `);

        const itemColumns = await allQuery(musicDb, 'PRAGMA table_info(enrichment_job_items)');
        const itemColumnNames = new Set(itemColumns.map(column => column.name));
        const itemMigrations = [
            ['result_json', 'TEXT'],
            ['decision', 'TEXT'],
            ['decision_json', 'TEXT'],
            ['selected_candidate_id', 'INTEGER'],
            ['decided_by', 'TEXT'],
            ['decided_at', 'TEXT']
        ];
        for (const [column, definition] of itemMigrations) {
            if (!itemColumnNames.has(column)) {
                await runQuery(musicDb, `ALTER TABLE enrichment_job_items ADD COLUMN ${column} ${definition}`);
            }
        }

        const storedJobs = await allQuery(musicDb, 'SELECT id, options_json FROM enrichment_jobs WHERE options_json IS NOT NULL');
        for (const job of storedJobs) {
            const sanitized = metadataValueToJson(sanitizeEnrichmentOptions(parseMetadataValue(job.options_json)));
            if (sanitized !== job.options_json) {
                await runQuery(musicDb, 'UPDATE enrichment_jobs SET options_json = ? WHERE id = ?', [sanitized, job.id]);
            }
        }
        const storedResults = await allQuery(musicDb, 'SELECT id, result_json FROM enrichment_job_items WHERE result_json IS NOT NULL');
        for (const item of storedResults) {
            const sanitized = metadataValueToJson(sanitizeEnrichmentPayload(parseMetadataValue(item.result_json)));
            if (sanitized !== item.result_json) {
                await runQuery(musicDb, 'UPDATE enrichment_job_items SET result_json = ? WHERE id = ?', [sanitized, item.id]);
            }
        }
        const storedCandidates = await allQuery(musicDb, 'SELECT id, payload_json FROM enrichment_candidates');
        for (const candidate of storedCandidates) {
            const sanitized = metadataValueToJson(sanitizeEnrichmentPayload(parseMetadataValue(candidate.payload_json)));
            if (sanitized !== candidate.payload_json) {
                await runQuery(musicDb, 'UPDATE enrichment_candidates SET payload_json = ? WHERE id = ?', [sanitized, candidate.id]);
            }
        }

        await runQuery(musicDb, 'CREATE INDEX IF NOT EXISTS idx_external_identifiers_lookup ON external_identifiers(identifier_type, identifier_value)');
        await runQuery(musicDb, 'CREATE INDEX IF NOT EXISTS idx_external_identifiers_song ON external_identifiers(song_id)');
        await runQuery(musicDb, 'CREATE INDEX IF NOT EXISTS idx_metadata_provenance_song ON metadata_provenance(song_id, field_name)');
        await runQuery(musicDb, 'CREATE INDEX IF NOT EXISTS idx_recordings_title ON recordings(title)');
        await runQuery(musicDb, 'CREATE INDEX IF NOT EXISTS idx_artists_name ON artists(name)');
        await runQuery(musicDb, 'CREATE INDEX IF NOT EXISTS idx_recording_artists_artist ON recording_artists(artist_uid, recording_uid)');
        await runQuery(musicDb, 'CREATE INDEX IF NOT EXISTS idx_releases_title_year ON releases(title, release_year)');
        await runQuery(musicDb, 'CREATE INDEX IF NOT EXISTS idx_release_tracks_release_position ON release_tracks(release_uid, disc_number, track_number)');
        await runQuery(musicDb, 'CREATE INDEX IF NOT EXISTS idx_release_tracks_recording ON release_tracks(recording_uid)');
        await runQuery(musicDb, 'CREATE INDEX IF NOT EXISTS idx_song_identifications_song_history ON song_identifications(song_id, created_at)');
        await runQuery(musicDb, 'CREATE INDEX IF NOT EXISTS idx_song_identifications_recording ON song_identifications(recording_uid, is_current)');
        await runQuery(musicDb, 'CREATE UNIQUE INDEX IF NOT EXISTS idx_song_identifications_current ON song_identifications(song_id) WHERE is_current = 1');
        await runQuery(musicDb, 'CREATE INDEX IF NOT EXISTS idx_enrichment_jobs_status ON enrichment_jobs(status, created_at)');
        await runQuery(musicDb, 'CREATE INDEX IF NOT EXISTS idx_enrichment_job_items_status ON enrichment_job_items(job_id, status)');
        await runQuery(musicDb, 'CREATE INDEX IF NOT EXISTS idx_enrichment_job_items_song ON enrichment_job_items(song_id)');
        await runQuery(musicDb, 'CREATE INDEX IF NOT EXISTS idx_enrichment_candidates_item ON enrichment_candidates(job_item_id, rank)');
        await runQuery(musicDb, 'CREATE INDEX IF NOT EXISTS idx_enrichment_candidates_song ON enrichment_candidates(song_id)');
        await runQuery(musicDb, 'CREATE INDEX IF NOT EXISTS idx_metadata_lookup_cache_expiry ON metadata_lookup_cache(expires_at)');

        const legacyIdentifiedSongs = await allQuery(musicDb, `
            SELECT s.*
            FROM songs s
            LEFT JOIN recordings r ON r.recording_uid = s.recording_uid
            WHERE s.recording_uid IS NOT NULL AND TRIM(s.recording_uid) != '' AND r.recording_uid IS NULL
        `);
        const identityBackfillTime = new Date().toISOString();
        for (const song of legacyIdentifiedSongs) {
            await runQuery(musicDb, `
                INSERT OR IGNORE INTO recordings (
                    recording_uid, title, duration_ms, first_release_year, source, confidence, created_at, updated_at
                ) VALUES (?, ?, ?, ?, 'legacy', NULL, ?, ?)
            `, [song.recording_uid, song.songname, song.duration_ms || null, song.year || null, identityBackfillTime, identityBackfillTime]);
        }
        const songsWithoutIdentification = await allQuery(musicDb, `
            SELECT s.id, s.recording_uid, s.metadata_source, s.metadata_pipeline_version
            FROM songs s
            LEFT JOIN song_identifications si ON si.song_id = s.id AND si.is_current = 1
            WHERE s.recording_uid IS NOT NULL AND TRIM(s.recording_uid) != '' AND si.id IS NULL
              AND COALESCE(s.availability, 'available') != 'removed'
        `);
        for (const song of songsWithoutIdentification) {
            await runQuery(musicDb, `
                INSERT INTO song_identifications (
                    identification_uid, song_id, recording_uid, method, source, confidence,
                    candidate_json, artist_credit_json, pipeline_version, is_current, created_at, updated_at
                ) VALUES (?, ?, ?, 'legacy', ?, NULL, NULL, '[]', ?, 1, ?, ?)
            `, [
                crypto.randomUUID(),
                song.id,
                song.recording_uid,
                song.metadata_source || 'legacy',
                song.metadata_pipeline_version || null,
                identityBackfillTime,
                identityBackfillTime
            ]);
        }

        console.log('[DB] Talking: Creating metadata identity/enrichment tables is done!');
    },

    replaceExternalIdentifiers: serializeTransaction(musicDb, async (songId, identifiers, source = 'embedded') => {
        const normalized = [];
        const seen = new Set();
        for (const identifier of identifiers || []) {
            const type = String(identifier.type || identifier.identifier_type || '').trim().toLowerCase();
            const value = String(identifier.value || identifier.identifier_value || '').trim();
            if (!type || !value) continue;
            const key = `${type}\u0000${value}`;
            if (seen.has(key)) continue;
            seen.add(key);
            normalized.push({ type, value });
        }

        const now = new Date().toISOString();
        let inTransaction = false;
        try {
            await runQuery(musicDb, 'BEGIN IMMEDIATE');
            inTransaction = true;
            await runQuery(musicDb, 'DELETE FROM external_identifiers WHERE song_id = ? AND source = ?', [songId, source]);
            for (const identifier of normalized) {
                await runQuery(musicDb, `
                    INSERT INTO external_identifiers (
                        song_id, identifier_type, identifier_value, source, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?)
                `, [songId, identifier.type, identifier.value, source, now, now]);
            }
            await runQuery(musicDb, 'COMMIT');
            inTransaction = false;
            return normalized;
        } catch (error) {
            if (inTransaction) {
                try { await runQuery(musicDb, 'ROLLBACK'); } catch { /* preserve original error */ }
            }
            throw error;
        }
    }),

    upsertExternalIdentifier: async (songId, identifierType, identifierValue, source = 'unknown') => {
        const type = String(identifierType || '').trim().toLowerCase();
        const value = String(identifierValue || '').trim();
        if (!type || !value) return null;
        const now = new Date().toISOString();
        return await runQuery(musicDb, `
            INSERT INTO external_identifiers (
                song_id, identifier_type, identifier_value, source, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(song_id, identifier_type, identifier_value, source) DO UPDATE SET
                updated_at = excluded.updated_at
        `, [songId, type, value, source, now, now]);
    },

    getExternalIdentifiers: async (songId) => {
        return await allQuery(musicDb, `
            SELECT * FROM external_identifiers WHERE song_id = ?
            ORDER BY identifier_type, id
        `, [songId]);
    },

    findSongsByExternalIdentifier: async (identifierType, identifierValue, { includeUnavailable = false } = {}) => {
        const availabilityClause = includeUnavailable ? '' : "AND COALESCE(s.availability, 'available') = 'available'";
        return await allQuery(musicDb, `
            SELECT DISTINCT s.*
            FROM external_identifiers e
            JOIN songs s ON s.id = e.song_id
            WHERE e.identifier_type = ? AND e.identifier_value = ? ${availabilityClause}
            ORDER BY s.id
        `, [String(identifierType || '').toLowerCase(), String(identifierValue || '')]);
    },

    getSongByExternalIdentifier: async (identifierType, identifierValue, options = {}) => {
        const songs = await HandleDatabase.findSongsByExternalIdentifier(identifierType, identifierValue, options);
        return songs.length === 1 ? songs[0] : null;
    },

    replaceMetadataProvenance: serializeTransaction(musicDb, async (songId, entries, source = 'embedded', options = {}) => {
        const normalized = Array.isArray(entries)
            ? entries.map(entry => ({
                field: entry.field || entry.field_name,
                value: entry.value,
                confidence: entry.confidence,
                isLocked: entry.is_locked === 1 || entry.isLocked === true
            }))
            : Object.entries(entries || {}).map(([field, value]) => ({ field, value }));
        const usable = normalized.filter(entry => entry.field && entry.value !== undefined && entry.value !== null);
        const now = new Date().toISOString();
        let inTransaction = false;

        try {
            await runQuery(musicDb, 'BEGIN IMMEDIATE');
            inTransaction = true;
            await runQuery(musicDb, 'DELETE FROM metadata_provenance WHERE song_id = ? AND source = ?', [songId, source]);
            for (const entry of usable) {
                const confidence = Number.isFinite(entry.confidence)
                    ? entry.confidence
                    : (Number.isFinite(options.confidence) ? options.confidence : null);
                const isLocked = entry.isLocked || shouldLockMetadataField(options.lockFields, entry.field) ? 1 : 0;
                await runQuery(musicDb, `
                    INSERT INTO metadata_provenance (
                        song_id, field_name, value_json, source, confidence, is_locked, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                `, [songId, String(entry.field), metadataValueToJson(entry.value), source, confidence, isLocked, now, now]);
            }
            await runQuery(musicDb, 'COMMIT');
            inTransaction = false;
            return usable.length;
        } catch (error) {
            if (inTransaction) {
                try { await runQuery(musicDb, 'ROLLBACK'); } catch { /* preserve original error */ }
            }
            throw error;
        }
    }),

    upsertMetadataProvenance: async (songId, fieldName, value, source, options = {}) => {
        const now = new Date().toISOString();
        const confidence = Number.isFinite(options.confidence) ? options.confidence : null;
        const isLocked = options.isLocked || shouldLockMetadataField(options.lockFields, fieldName) ? 1 : 0;
        return await runQuery(musicDb, `
            INSERT INTO metadata_provenance (
                song_id, field_name, value_json, source, confidence, is_locked, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(song_id, field_name, source) DO UPDATE SET
                value_json = excluded.value_json,
                confidence = excluded.confidence,
                is_locked = MAX(metadata_provenance.is_locked, excluded.is_locked),
                updated_at = excluded.updated_at
        `, [songId, fieldName, metadataValueToJson(value), source, confidence, isLocked, now, now]);
    },

    getMetadataProvenance: async (songId) => {
        const rows = await allQuery(musicDb, `
            SELECT * FROM metadata_provenance WHERE song_id = ?
            ORDER BY field_name, id
        `, [songId]);
        return rows.map(row => ({ ...row, value: parseMetadataValue(row.value_json) }));
    },

    getLockedMetadataFields: async (songId) => {
        const rows = await allQuery(musicDb, `
            SELECT DISTINCT field_name FROM metadata_provenance
            WHERE song_id = ? AND is_locked = 1
            ORDER BY field_name
        `, [songId]);
        return rows.map(row => row.field_name);
    },

    getSongIdentification: async (songId) => {
        const row = await getQuery(musicDb, `
            SELECT si.*, r.title AS recording_title, r.duration_ms AS recording_duration_ms,
                   rel.title AS release_title, rel.release_date, rel.release_year, rel.country AS release_country,
                   rt.disc_number, rt.track_number
            FROM song_identifications si
            JOIN recordings r ON r.recording_uid = si.recording_uid
            LEFT JOIN releases rel ON rel.release_uid = si.release_uid
            LEFT JOIN release_tracks rt ON rt.release_track_uid = si.release_track_uid
            WHERE si.song_id = ? AND si.is_current = 1
            LIMIT 1
        `, [songId]);
        if (!row) return null;
        const artistCredits = parseMetadataValue(row.artist_credit_json);
        return {
            recording_uid: row.recording_uid,
            release_uid: row.release_uid || null,
            release_track_uid: row.release_track_uid || null,
            recording_title: row.recording_title || null,
            release_title: row.release_title || null,
            release_date: row.release_date || null,
            release_year: row.release_year || null,
            release_country: row.release_country || null,
            disc_number: row.disc_number || null,
            track_number: row.track_number || null,
            artists: Array.isArray(artistCredits) ? artistCredits : [],
            method: row.method,
            source: row.source,
            confidence: row.confidence,
            pipeline_version: row.pipeline_version || null
        };
    },

    createEnrichmentJob: serializeTransaction(musicDb, async ({ requestedBy = null, mode = 'auto', options = {}, songIds = [], pipelineVersion = null } = {}) => {
        const ids = [...new Set(songIds.map(Number).filter(Number.isInteger))];
        const safeOptions = sanitizeEnrichmentOptions(options);
        const now = new Date().toISOString();
        const jobUid = crypto.randomUUID();
        let inTransaction = false;

        try {
            await runQuery(musicDb, 'BEGIN IMMEDIATE');
            inTransaction = true;
            if (requestedBy) {
                const existing = await getQuery(musicDb, `
                    SELECT * FROM enrichment_jobs
                    WHERE requested_by = ? AND status IN ('queued', 'running', 'paused', 'awaiting_review')
                    ORDER BY created_at DESC
                    LIMIT 1
                `, [requestedBy]);
                if (existing) {
                    const open = await getQuery(musicDb, `
                        SELECT COUNT(*) AS count FROM enrichment_job_items
                        WHERE job_id = ? AND status IN ('queued', 'processing', 'review', 'unidentified', 'error')
                    `, [existing.id]);
                    if ((Number(open && open.count) || 0) > 0) {
                        await runQuery(musicDb, 'ROLLBACK');
                        inTransaction = false;
                        return { ...existing, existing: true };
                    }
                    await runQuery(musicDb, `
                        UPDATE enrichment_jobs SET status = 'completed', completed_at = COALESCE(completed_at, ?)
                        WHERE id = ?
                    `, [now, existing.id]);
                }
            }
            const result = await runQuery(musicDb, `
                INSERT INTO enrichment_jobs (
                    job_uid, requested_by, mode, status, pipeline_version, options_json,
                    total_items, created_at
                ) VALUES (?, ?, ?, 'queued', ?, ?, 0, ?)
            `, [jobUid, requestedBy, mode, pipelineVersion, metadataValueToJson(safeOptions), now]);

            let totalItems = 0;
            for (const songId of ids) {
                const song = await getQuery(musicDb, `
                    SELECT id, metadata_revision FROM songs
                    WHERE id = ? AND COALESCE(availability, 'available') = 'available'
                `, [songId]);
                if (!song) continue;
                await runQuery(musicDb, `
                    INSERT INTO enrichment_job_items (
                        job_id, song_id, status, metadata_revision, attempts, created_at
                    ) VALUES (?, ?, 'queued', ?, 0, ?)
                `, [result.lastID, song.id, Number(song.metadata_revision) || 0, now]);
                totalItems++;
            }
            await runQuery(musicDb, 'UPDATE enrichment_jobs SET total_items = ? WHERE id = ?', [totalItems, result.lastID]);
            await runQuery(musicDb, 'COMMIT');
            inTransaction = false;
            return await getQuery(musicDb, 'SELECT * FROM enrichment_jobs WHERE id = ?', [result.lastID]);
        } catch (error) {
            if (inTransaction) {
                try { await runQuery(musicDb, 'ROLLBACK'); } catch { /* preserve original error */ }
            }
            throw error;
        }
    }),

    getEnrichmentJob: async (identifier) => {
        const isNumeric = typeof identifier === 'number' || /^\d+$/.test(String(identifier || '').trim());
        return await getQuery(
            musicDb,
            isNumeric ? 'SELECT * FROM enrichment_jobs WHERE id = ?' : 'SELECT * FROM enrichment_jobs WHERE job_uid = ?',
            [identifier]
        );
    },

    getEnrichmentJobs: async ({ status = null, limit = 50, offset = 0 } = {}) => {
        const safeLimit = Math.min(Math.max(Math.trunc(Number(limit)) || 50, 1), 500);
        const safeOffset = Math.max(Math.trunc(Number(offset)) || 0, 0);
        if (status) {
            return await allQuery(musicDb, `
                SELECT * FROM enrichment_jobs WHERE status = ?
                ORDER BY created_at DESC LIMIT ? OFFSET ?
            `, [status, safeLimit, safeOffset]);
        }
        return await allQuery(musicDb, `
            SELECT * FROM enrichment_jobs ORDER BY created_at DESC LIMIT ? OFFSET ?
        `, [safeLimit, safeOffset]);
    },

    getActiveEnrichmentJobForRequester: async (requestedBy) => {
        return await getQuery(musicDb, `
            SELECT * FROM enrichment_jobs
            WHERE requested_by = ? AND status IN ('queued', 'running', 'paused', 'awaiting_review')
            ORDER BY created_at DESC
            LIMIT 1
        `, [requestedBy]);
    },

    getEnrichmentJobItems: async (jobIdentifier, { status = null } = {}) => {
        const job = await HandleDatabase.getEnrichmentJob(jobIdentifier);
        if (!job) return [];
        const statusClause = status ? 'AND i.status = ?' : '';
        const params = status ? [job.id, status] : [job.id];
        return await allQuery(musicDb, `
            SELECT i.*, s.song_uid, s.recording_uid, s.songname, s.artist, s.album,
                   s.genre, s.year, s.duration_ms, s.metadata_status, s.metadata_source
            FROM enrichment_job_items i
            JOIN songs s ON s.id = i.song_id
            WHERE i.job_id = ? ${statusClause}
            ORDER BY i.id
        `, params);
    },

    getEnrichmentJobItem: async (itemId) => {
        const row = await getQuery(musicDb, `
            SELECT i.*,
                   j.job_uid, j.requested_by, j.mode AS job_mode, j.status AS job_status,
                   j.pipeline_version AS job_pipeline_version, j.options_json,
                   s.metadata_revision AS song_metadata_revision,
                   s.availability AS song_availability
            FROM enrichment_job_items i
            JOIN enrichment_jobs j ON j.id = i.job_id
            JOIN songs s ON s.id = i.song_id
            WHERE i.id = ?
        `, [itemId]);
        if (!row) return null;
        return {
            ...row,
            result: parseMetadataValue(row.result_json),
            decisionData: parseMetadataValue(row.decision_json),
            options: sanitizeEnrichmentOptions(parseMetadataValue(row.options_json))
        };
    },

    claimNextEnrichmentJobItem: serializeTransaction(musicDb, async (jobIdentifier) => {
        const job = await HandleDatabase.getEnrichmentJob(jobIdentifier);
        if (!job || !['queued', 'running'].includes(job.status)) return null;
        let inTransaction = false;
        try {
            await runQuery(musicDb, 'BEGIN IMMEDIATE');
            inTransaction = true;
            const item = await getQuery(musicDb, `
                SELECT i.id
                FROM enrichment_job_items i
                WHERE i.job_id = ? AND i.status = 'queued'
                ORDER BY i.id
                LIMIT 1
            `, [job.id]);
            if (!item) {
                await runQuery(musicDb, 'COMMIT');
                inTransaction = false;
                return null;
            }
            const now = new Date().toISOString();
            const claimed = await runQuery(musicDb, `
                UPDATE enrichment_job_items
                SET status = 'processing', attempts = attempts + 1, started_at = ?,
                    completed_at = NULL, error = NULL,
                    metadata_revision = COALESCE((SELECT metadata_revision FROM songs WHERE id = song_id), metadata_revision)
                WHERE id = ? AND status = 'queued'
            `, [now, item.id]);
            if (claimed.changes !== 1) {
                await runQuery(musicDb, 'ROLLBACK');
                inTransaction = false;
                return null;
            }
            await runQuery(musicDb, `
                UPDATE enrichment_jobs
                SET status = 'running', started_at = COALESCE(started_at, ?), error = NULL
                WHERE id = ? AND status IN ('queued', 'running')
            `, [now, job.id]);
            await runQuery(musicDb, 'COMMIT');
            inTransaction = false;
            return await HandleDatabase.getEnrichmentJobItem(item.id);
        } catch (error) {
            if (inTransaction) {
                try { await runQuery(musicDb, 'ROLLBACK'); } catch { /* preserve original error */ }
            }
            throw error;
        }
    }),

    updateEnrichmentJob: async (identifier, updates) => {
        const allowedFields = new Set([
            'status', 'processed_items', 'succeeded_items', 'failed_items',
            'started_at', 'completed_at', 'error'
        ]);
        const fields = Object.keys(updates || {}).filter(field => allowedFields.has(field));
        if (fields.length === 0) return { changes: 0 };
        const values = fields.map(field => updates[field]);
        const isNumeric = typeof identifier === 'number' || /^\d+$/.test(String(identifier || '').trim());
        return await runQuery(musicDb, `
            UPDATE enrichment_jobs SET ${fields.map(field => `${field} = ?`).join(', ')}
            WHERE ${isNumeric ? 'id' : 'job_uid'} = ?
        `, [...values, identifier]);
    },

    updateEnrichmentJobItem: async (itemId, updates) => {
        const allowedFields = new Set([
            'status', 'metadata_revision', 'attempts', 'started_at', 'completed_at',
            'error', 'result_json', 'decision', 'decision_json',
            'selected_candidate_id', 'decided_by', 'decided_at'
        ]);
        const fields = Object.keys(updates || {}).filter(field => allowedFields.has(field));
        if (fields.length === 0) return { changes: 0 };
        return await runQuery(musicDb, `
            UPDATE enrichment_job_items SET ${fields.map(field => `${field} = ?`).join(', ')} WHERE id = ?
        `, [...fields.map(field => updates[field]), itemId]);
    },

    clearEnrichmentCandidates: async (jobItemId) => {
        return await runQuery(musicDb, 'DELETE FROM enrichment_candidates WHERE job_item_id = ?', [jobItemId]);
    },

    addEnrichmentCandidate: async (jobItemId, candidate) => {
        const item = await getQuery(musicDb, 'SELECT song_id FROM enrichment_job_items WHERE id = ?', [jobItemId]);
        if (!item) throw new Error('Enrichment job item not found');
        const now = new Date().toISOString();
        return await runQuery(musicDb, `
            INSERT INTO enrichment_candidates (
                job_item_id, song_id, provider, provider_recording_id, rank,
                confidence, status, payload_json, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            jobItemId, item.song_id, String(candidate.provider || 'unknown'),
            candidate.providerRecordingId || candidate.provider_recording_id || null,
            Number.isInteger(candidate.rank) ? candidate.rank : 0,
            Number.isFinite(candidate.confidence) ? candidate.confidence : null,
            candidate.status || 'pending', metadataValueToJson(sanitizeEnrichmentPayload(candidate.payload || candidate)), now
        ]);
    },

    getEnrichmentCandidate: async (candidateId) => {
        const row = await getQuery(musicDb, 'SELECT * FROM enrichment_candidates WHERE id = ?', [candidateId]);
        return row ? { ...row, payload: parseMetadataValue(row.payload_json) } : null;
    },

    getEnrichmentCandidates: async (jobItemId) => {
        const rows = await allQuery(musicDb, `
            SELECT * FROM enrichment_candidates WHERE job_item_id = ?
            ORDER BY rank, confidence DESC, id
        `, [jobItemId]);
        return rows.map(row => ({ ...row, payload: parseMetadataValue(row.payload_json) }));
    },

    storeEnrichmentItemResult: serializeTransaction(musicDb, async (itemId, {
        result = null,
        candidates = [],
        status = 'review',
        error = null,
        songStatus = null,
        automatic = null
    } = {}) => {
        const now = new Date().toISOString();
        let inTransaction = false;
        try {
            await runQuery(musicDb, 'BEGIN IMMEDIATE');
            inTransaction = true;
            const item = await getQuery(musicDb, `
                SELECT i.*,
                       s.songname, s.artist, s.album, s.genre, s.year, s.cover_path,
                       s.recording_uid, s.metadata_status AS song_metadata_status,
                       s.metadata_revision AS current_metadata_revision
                FROM enrichment_job_items i
                JOIN songs s ON s.id = i.song_id
                WHERE i.id = ?
            `, [itemId]);
            if (!item || item.status !== 'processing') {
                await runQuery(musicDb, 'ROLLBACK');
                inTransaction = false;
                return { stored: false, stale: true };
            }

            await runQuery(musicDb, 'DELETE FROM enrichment_candidates WHERE job_item_id = ?', [itemId]);
            const candidateIds = [];
            for (let index = 0; index < candidates.length; index++) {
                const candidate = sanitizeEnrichmentPayload(candidates[index] || {});
                const insert = await runQuery(musicDb, `
                    INSERT INTO enrichment_candidates (
                        job_item_id, song_id, provider, provider_recording_id, rank,
                        confidence, status, payload_json, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
                `, [
                    itemId,
                    item.song_id,
                    String(candidate.provider || candidate.source || 'unknown').slice(0, 80),
                    candidate.recordingId || candidate.providerRecordingId || candidate.provider_recording_id || null,
                    index,
                    Number.isFinite(candidate.confidence) ? candidate.confidence : null,
                    metadataValueToJson(candidate),
                    now
                ]);
                candidateIds.push(insert.lastID);
            }

            let finalStatus = status;
            let finalError = error ? String(error).slice(0, 1000) : null;
            let expectedRevision = Number(item.metadata_revision) || 0;
            const songRevision = Number(item.current_metadata_revision) || 0;
            const lockedRows = await allQuery(musicDb, `
                SELECT DISTINCT field_name FROM metadata_provenance
                WHERE song_id = ? AND is_locked = 1
            `, [item.song_id]);
            const lockedFields = new Set(lockedRows.map(row => normalizeMetadataField(row.field_name)));
            let appliedFields = [];
            let canonicalIdentity = null;

            if (automatic) {
                if (songRevision !== expectedRevision) {
                    finalStatus = 'review';
                    finalError = 'metadata_revision_conflict';
                } else if (lockedFields.has('recording_uid') && item.recording_uid) {
                    finalStatus = 'review';
                } else {
                    const requested = automatic.updates && typeof automatic.updates === 'object' ? automatic.updates : {};
                    const safeUpdates = {};
                    for (const [rawField, value] of Object.entries(requested)) {
                        const field = normalizeMetadataField(rawField);
                        if (!ENRICHMENT_METADATA_FIELDS.has(field) || field === 'cover_path' || lockedFields.has(field)) continue;
                        if (!isPlaceholderMetadataValue(field, item[field])) continue;
                        safeUpdates[field] = value;
                    }
                    const identifiers = normalizeExternalIdentifiers(automatic.identifiers);
                    const source = String(automatic.source || 'smart-auto-enrich').slice(0, 120);
                    const pipelineVersion = automatic.pipelineVersion ? String(automatic.pipelineVersion).slice(0, 120) : null;
                    const confidence = Number.isFinite(automatic.confidence) ? automatic.confidence : null;
                    const acceptedCandidate = sanitizeEnrichmentPayload(automatic.candidate || {});
                    const recordingUid = await resolveCanonicalRecordingUid(item.song_id, identifiers, acceptedCandidate);
                    const setters = Object.keys(safeUpdates).map(field => `${field} = ?`);
                    const values = Object.values(safeUpdates);
                    setters.push('recording_uid = ?');
                    values.push(recordingUid);
                    setters.push(
                        'ai_enriched = 1',
                        'metadata_status = ?',
                        'metadata_revision = COALESCE(metadata_revision, 0) + 1',
                        'metadata_updated_at = ?',
                        'metadata_pipeline_version = ?',
                        'metadata_source = ?'
                    );
                    values.push(METADATA_STATUSES.has(songStatus) ? songStatus : 'identified', now, pipelineVersion, source);
                    const update = await runQuery(musicDb, `
                        UPDATE songs SET ${setters.join(', ')}
                        WHERE id = ? AND COALESCE(metadata_revision, 0) = ?
                    `, [...values, item.song_id, expectedRevision]);
                    if (update.changes !== 1) {
                        finalStatus = 'review';
                        finalError = 'metadata_revision_conflict';
                    } else {
                        expectedRevision++;
                        appliedFields = Object.keys(safeUpdates);
                        const provenance = { ...safeUpdates };
                        provenance.recording_uid = recordingUid;
                        await insertEnrichmentProvenance(item.song_id, provenance, source, confidence, false, now);
                        await insertEnrichmentIdentifiers(item.song_id, identifiers, source, now);
                        canonicalIdentity = await persistCanonicalIdentity(item.song_id, recordingUid, acceptedCandidate, identifiers, {
                            method: String(automatic.method || 'strict_automatic').slice(0, 80),
                            source: String(automatic.identitySource || source).slice(0, 120),
                            confidence,
                            pipelineVersion,
                            now
                        });
                    }
                }
            } else if (METADATA_STATUSES.has(songStatus)) {
                const stateUpdate = await runQuery(musicDb, `
                    UPDATE songs
                    SET metadata_status = ?, metadata_revision = COALESCE(metadata_revision, 0) + 1,
                        metadata_updated_at = ?, metadata_pipeline_version = COALESCE(?, metadata_pipeline_version),
                        metadata_source = 'smart-auto-enrich'
                    WHERE id = ? AND COALESCE(metadata_revision, 0) = ?
                `, [songStatus, now, result && result.pipelineVersion || null, item.song_id, expectedRevision]);
                if (stateUpdate.changes === 1) {
                    expectedRevision++;
                } else {
                    finalStatus = 'review';
                    finalError = 'metadata_revision_conflict';
                }
            }

            await runQuery(musicDb, `
                UPDATE enrichment_job_items
                SET status = ?, metadata_revision = ?, result_json = ?, error = ?, completed_at = ?
                WHERE id = ?
            `, [finalStatus, expectedRevision, metadataValueToJson(sanitizeEnrichmentPayload(result)), finalError, now, itemId]);
            const updatedSong = await getQuery(musicDb, 'SELECT * FROM songs WHERE id = ?', [item.song_id]);
            await runQuery(musicDb, 'COMMIT');
            inTransaction = false;
            return {
                stored: true,
                status: finalStatus,
                error: finalError,
                candidateIds,
                appliedFields,
                metadataRevision: expectedRevision,
                identity: canonicalIdentity
            };
        } catch (transactionError) {
            if (inTransaction) {
                try { await runQuery(musicDb, 'ROLLBACK'); } catch { /* preserve original error */ }
            }
            throw transactionError;
        }
    }),

    decideEnrichmentJobItem: serializeTransaction(musicDb, async (itemId, {
        decision,
        decisionData,
        selectedCandidateId = null,
        persistedCandidateId = null,
        decidedBy,
        updates = {},
        identifiers = [],
        candidate = null,
        method = 'owner_decision',
        identitySource = null,
        source = 'smart-auto-enrich',
        pipelineVersion = null,
        confidence = null,
        expectedRevision
    } = {}) => {
        const now = new Date().toISOString();
        const serializedDecision = metadataValueToJson(decisionData || { decision });
        let inTransaction = false;
        try {
            await runQuery(musicDb, 'BEGIN IMMEDIATE');
            inTransaction = true;
            const item = await getQuery(musicDb, 'SELECT * FROM enrichment_job_items WHERE id = ?', [itemId]);
            if (!item) {
                await runQuery(musicDb, 'ROLLBACK');
                inTransaction = false;
                return { decided: false, notFound: true };
            }
            if (item.decision) {
                const idempotent = item.decision === decision && item.decision_json === serializedDecision;
                await runQuery(musicDb, idempotent ? 'COMMIT' : 'ROLLBACK');
                inTransaction = false;
                return { decided: idempotent, idempotent, conflict: !idempotent, item };
            }
            if (!['review', 'unidentified', 'error'].includes(item.status)) {
                await runQuery(musicDb, 'ROLLBACK');
                inTransaction = false;
                return { decided: false, conflict: true, stateConflict: true, item };
            }

            let newRevision = Number(item.metadata_revision) || 0;
            const sourceName = String(source || 'smart-auto-enrich').slice(0, 120);
            let canonicalIdentity = null;
            if (decision === 'apply' || decision === 'mark_unknown') {
                const song = await getQuery(musicDb, 'SELECT * FROM songs WHERE id = ?', [item.song_id]);
                if (!song) {
                    await runQuery(musicDb, 'ROLLBACK');
                    inTransaction = false;
                    return { decided: false, notFound: true };
                }
                const currentRevision = Number(song.metadata_revision) || 0;
                const requiredRevision = expectedRevision === undefined ? newRevision : Number(expectedRevision);
                if (currentRevision !== newRevision || requiredRevision !== newRevision) {
                    await runQuery(musicDb, 'ROLLBACK');
                    inTransaction = false;
                    return { decided: false, conflict: true, currentRevision };
                }

                if (decision === 'apply') {
                    const metadataUpdates = {};
                    for (const [rawField, value] of Object.entries(updates || {})) {
                        const field = normalizeMetadataField(rawField);
                        if (ENRICHMENT_METADATA_FIELDS.has(field)) metadataUpdates[field] = value;
                    }
                    const lockedRows = await allQuery(musicDb, `
                        SELECT DISTINCT field_name FROM metadata_provenance
                        WHERE song_id = ? AND is_locked = 1
                    `, [item.song_id]);
                    const locked = new Set(lockedRows.map(row => normalizeMetadataField(row.field_name)));
                    const normalizedIdentifiers = normalizeExternalIdentifiers(identifiers);
                    const cleanRecordingUid = await resolveCanonicalRecordingUid(
                        item.song_id,
                        normalizedIdentifiers,
                        candidate
                    );
                    const lockedFields = Object.keys(metadataUpdates).filter(field => locked.has(normalizeMetadataField(field)));
                    if (locked.has('recording_uid') && song.recording_uid && cleanRecordingUid !== song.recording_uid) {
                        lockedFields.push('recording_uid');
                    }
                    if (lockedFields.length) {
                        await runQuery(musicDb, 'ROLLBACK');
                        inTransaction = false;
                        return { decided: false, lockedFields };
                    }
                    const setters = Object.keys(metadataUpdates).map(field => `${field} = ?`);
                    const values = Object.values(metadataUpdates);
                    setters.push('recording_uid = ?');
                    values.push(cleanRecordingUid);
                    setters.push(
                        'ai_enriched = 1',
                        "metadata_status = 'identified'",
                        'metadata_revision = COALESCE(metadata_revision, 0) + 1',
                        'metadata_updated_at = ?',
                        'metadata_pipeline_version = ?',
                        'metadata_source = ?'
                    );
                    values.push(now, pipelineVersion ? String(pipelineVersion).slice(0, 120) : null, sourceName);
                    const songUpdate = await runQuery(musicDb, `
                        UPDATE songs SET ${setters.join(', ')}
                        WHERE id = ? AND COALESCE(metadata_revision, 0) = ?
                    `, [...values, item.song_id, newRevision]);
                    if (songUpdate.changes !== 1) {
                        await runQuery(musicDb, 'ROLLBACK');
                        inTransaction = false;
                        return { decided: false, conflict: true };
                    }
                    newRevision++;
                    const provenance = { ...metadataUpdates };
                    provenance.recording_uid = cleanRecordingUid;
                    await insertEnrichmentProvenance(
                        item.song_id,
                        provenance,
                        sourceName,
                        Number.isFinite(confidence) ? confidence : null,
                        true,
                        now
                    );
                    await insertEnrichmentIdentifiers(item.song_id, normalizedIdentifiers, sourceName, now);
                    canonicalIdentity = await persistCanonicalIdentity(
                        item.song_id,
                        cleanRecordingUid,
                        sanitizeEnrichmentPayload(candidate || {}),
                        normalizedIdentifiers,
                        {
                            method: String(method || 'owner_decision').slice(0, 80),
                            source: String(identitySource || sourceName).slice(0, 120),
                            confidence: Number.isFinite(confidence) ? confidence : null,
                            pipelineVersion: pipelineVersion ? String(pipelineVersion).slice(0, 120) : null,
                            now
                        }
                    );
                } else {
                    const songUpdate = await runQuery(musicDb, `
                        UPDATE songs
                        SET metadata_status = 'unknown', metadata_revision = COALESCE(metadata_revision, 0) + 1,
                            metadata_updated_at = ?, metadata_pipeline_version = ?, metadata_source = ?
                        WHERE id = ? AND COALESCE(metadata_revision, 0) = ?
                    `, [now, pipelineVersion ? String(pipelineVersion).slice(0, 120) : null, sourceName, item.song_id, newRevision]);
                    if (songUpdate.changes !== 1) {
                        await runQuery(musicDb, 'ROLLBACK');
                        inTransaction = false;
                        return { decided: false, conflict: true };
                    }
                    newRevision++;
                }
            }

            const itemStatus = decision === 'apply' ? 'applied' : 'skipped';
            await runQuery(musicDb, `
                UPDATE enrichment_job_items
                SET status = ?, metadata_revision = ?, decision = ?, decision_json = ?,
                    selected_candidate_id = ?, decided_by = ?, decided_at = ?, completed_at = ?, error = NULL
                WHERE id = ? AND decision IS NULL
            `, [
                itemStatus,
                newRevision,
                decision,
                serializedDecision,
                persistedCandidateId !== null && persistedCandidateId !== undefined && Number.isInteger(Number(persistedCandidateId))
                    ? Number(persistedCandidateId)
                    : null,
                decidedBy || null,
                now,
                now,
                itemId
            ]);
            if (decision === 'apply' && persistedCandidateId) {
                await runQuery(musicDb, `
                    UPDATE enrichment_candidates
                    SET status = CASE WHEN id = ? THEN 'selected' ELSE 'rejected' END
                    WHERE job_item_id = ?
                `, [persistedCandidateId, itemId]);
            }
            const updatedSong = await getQuery(musicDb, 'SELECT * FROM songs WHERE id = ?', [item.song_id]);
            await runQuery(musicDb, 'COMMIT');
            inTransaction = false;
            return {
                decided: true,
                idempotent: false,
                decision,
                selectedCandidateId,
                metadataRevision: newRevision,
                identity: canonicalIdentity,
                song: updatedSong
            };
        } catch (transactionError) {
            if (inTransaction) {
                try { await runQuery(musicDb, 'ROLLBACK'); } catch { /* preserve original error */ }
            }
            throw transactionError;
        }
    }),

    getNextEnrichmentReviewItem: async (jobIdentifier) => {
        const job = await HandleDatabase.getEnrichmentJob(jobIdentifier);
        if (!job) return null;
        const row = await getQuery(musicDb, `
            SELECT id FROM enrichment_job_items
            WHERE job_id = ? AND status IN ('review', 'unidentified', 'error')
            ORDER BY CASE status WHEN 'review' THEN 0 WHEN 'unidentified' THEN 1 ELSE 2 END, id
            LIMIT 1
        `, [job.id]);
        return row ? await HandleDatabase.getEnrichmentJobItem(row.id) : null;
    },

    syncEnrichmentJobState: async (jobIdentifier) => {
        const job = await HandleDatabase.getEnrichmentJob(jobIdentifier);
        if (!job) return null;
        const rows = await allQuery(musicDb, `
            SELECT status, COUNT(*) AS count
            FROM enrichment_job_items
            WHERE job_id = ?
            GROUP BY status
        `, [job.id]);
        const counts = Object.fromEntries(rows.map(row => [row.status, Number(row.count) || 0]));
        const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
        const processed = total - (counts.queued || 0) - (counts.processing || 0);
        const succeeded = counts.applied || 0;
        const failed = counts.error || 0;
        let status = job.status;
        let completedAt = job.completed_at;
        if (!['paused', 'cancelled'].includes(status)) {
            if ((counts.queued || 0) + (counts.processing || 0) > 0) status = 'running';
            else if ((counts.review || 0) + (counts.unidentified || 0) + (counts.error || 0) > 0) status = 'awaiting_review';
            else {
                status = 'completed';
                completedAt = completedAt || new Date().toISOString();
            }
        }
        await runQuery(musicDb, `
            UPDATE enrichment_jobs
            SET status = ?, total_items = ?, processed_items = ?, succeeded_items = ?,
                failed_items = ?, completed_at = ?
            WHERE id = ? AND status = ?
        `, [status, total, processed, succeeded, failed, completedAt, job.id, job.status]);
        return await HandleDatabase.getEnrichmentJob(job.id);
    },

    pauseEnrichmentJob: serializeTransaction(musicDb, async (jobIdentifier) => {
        const job = await HandleDatabase.getEnrichmentJob(jobIdentifier);
        if (!job) return null;
        if (['cancelled', 'completed'].includes(job.status)) return job;
        let inTransaction = false;
        try {
            await runQuery(musicDb, 'BEGIN IMMEDIATE');
            inTransaction = true;
            await runQuery(musicDb, "UPDATE enrichment_jobs SET status = 'paused' WHERE id = ?", [job.id]);
            await runQuery(musicDb, `
                UPDATE enrichment_job_items
                SET status = 'queued', started_at = NULL, completed_at = NULL, error = NULL
                WHERE job_id = ? AND status = 'processing'
            `, [job.id]);
            await runQuery(musicDb, 'COMMIT');
            inTransaction = false;
        } catch (error) {
            if (inTransaction) {
                try { await runQuery(musicDb, 'ROLLBACK'); } catch { /* preserve original error */ }
            }
            throw error;
        }
        return await HandleDatabase.getEnrichmentJob(job.id);
    }),

    resumeEnrichmentJob: async (jobIdentifier) => {
        const job = await HandleDatabase.getEnrichmentJob(jobIdentifier);
        if (!job) return null;
        if (job.status === 'paused') {
            await runQuery(musicDb, "UPDATE enrichment_jobs SET status = 'queued', completed_at = NULL WHERE id = ?", [job.id]);
        }
        return await HandleDatabase.syncEnrichmentJobState(job.id);
    },

    cancelEnrichmentJob: serializeTransaction(musicDb, async (jobIdentifier) => {
        const job = await HandleDatabase.getEnrichmentJob(jobIdentifier);
        if (!job) return null;
        if (job.status === 'cancelled') return job;
        const now = new Date().toISOString();
        let inTransaction = false;
        try {
            await runQuery(musicDb, 'BEGIN IMMEDIATE');
            inTransaction = true;
            await runQuery(musicDb, `
                UPDATE enrichment_jobs SET status = 'cancelled', completed_at = ?, error = NULL WHERE id = ?
            `, [now, job.id]);
            await runQuery(musicDb, `
                UPDATE enrichment_job_items
                SET status = 'cancelled', completed_at = ?, error = NULL
                WHERE job_id = ? AND status IN ('queued', 'processing')
            `, [now, job.id]);
            await runQuery(musicDb, 'COMMIT');
            inTransaction = false;
            return await HandleDatabase.getEnrichmentJob(job.id);
        } catch (error) {
            if (inTransaction) {
                try { await runQuery(musicDb, 'ROLLBACK'); } catch { /* preserve original error */ }
            }
            throw error;
        }
    }),

    requeueEnrichmentJobItem: async (itemId, { cancelled = false } = {}) => {
        const status = cancelled ? 'cancelled' : 'queued';
        return await runQuery(musicDb, `
            UPDATE enrichment_job_items
            SET status = ?, started_at = CASE WHEN ? = 'queued' THEN NULL ELSE started_at END,
                completed_at = CASE WHEN ? = 'cancelled' THEN ? ELSE NULL END,
                error = NULL
            WHERE id = ? AND status = 'processing'
        `, [status, status, status, new Date().toISOString(), itemId]);
    },

    recoverEnrichmentJobs: async () => {
        await runQuery(musicDb, `
            UPDATE enrichment_job_items SET status = 'queued', started_at = NULL, completed_at = NULL, error = NULL
            WHERE status = 'processing'
              AND job_id IN (SELECT id FROM enrichment_jobs WHERE status IN ('queued', 'running', 'paused', 'awaiting_review'))
        `);
        await runQuery(musicDb, `
            UPDATE enrichment_jobs SET status = 'queued'
            WHERE status = 'running'
        `);
        const jobs = await allQuery(musicDb, `
            SELECT * FROM enrichment_jobs
            WHERE status IN ('queued', 'awaiting_review')
            ORDER BY created_at
        `);
        for (const job of jobs) await HandleDatabase.syncEnrichmentJobState(job.id);
        return await allQuery(musicDb, `
            SELECT * FROM enrichment_jobs
            WHERE status IN ('queued', 'running')
            ORDER BY created_at
        `);
    },

    getMetadataLookupCache: async (cacheKey) => {
        const row = await getQuery(musicDb, `
            SELECT * FROM metadata_lookup_cache
            WHERE cache_key = ? AND (expires_at IS NULL OR expires_at > ?)
        `, [cacheKey, Date.now()]);
        if (!row) return null;
        return {
            ...row,
            query: parseMetadataValue(row.query_json),
            result: parseMetadataValue(row.result_json)
        };
    },

    setMetadataLookupCache: async (cacheKey, provider, query, result, { ttlMs = null, status = 'success', error = null } = {}) => {
        const now = new Date().toISOString();
        const expiresAt = Number.isFinite(ttlMs) ? Date.now() + Math.max(0, ttlMs) : null;
        return await runQuery(musicDb, `
            INSERT INTO metadata_lookup_cache (
                cache_key, provider, query_json, result_json, status, error,
                expires_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(cache_key) DO UPDATE SET
                provider = excluded.provider,
                query_json = excluded.query_json,
                result_json = excluded.result_json,
                status = excluded.status,
                error = excluded.error,
                expires_at = excluded.expires_at,
                updated_at = excluded.updated_at
        `, [
            cacheKey, provider, metadataValueToJson(query), metadataValueToJson(result),
            status, error, expiresAt, now, now
        ]);
    },

    pruneMetadataLookupCache: async () => {
        return await runQuery(musicDb, `
            DELETE FROM metadata_lookup_cache WHERE expires_at IS NOT NULL AND expires_at <= ?
        `, [Date.now()]);
    },

    createPostsTable: async () => {
        await runQuery(socialDb, `
            CREATE TABLE IF NOT EXISTS posts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL,
                body TEXT NOT NULL,
                created_at TEXT NOT NULL,
                likes INTEGER DEFAULT 0,
                comments INTEGER DEFAULT 0,
                type TEXT DEFAULT 'text',
                image_url TEXT
            )
        `);

        // Migration: Add image_url if it doesn't exist
        const columns = await allQuery(socialDb, "PRAGMA table_info(posts)");
        const columnNames = columns.map(c => c.name);
        if (!columnNames.includes('image_url')) {
            await runQuery(socialDb, "ALTER TABLE posts ADD COLUMN image_url TEXT");
        }
        if (!columnNames.includes('is_flagged')) {
            await runQuery(socialDb, "ALTER TABLE posts ADD COLUMN is_flagged INTEGER DEFAULT 0");
        }

        console.log("[DB] Talking: Creating/Updating posts table is done!");
    },

    createPostLikesTable: async () => {
        await runQuery(socialDb, `
            CREATE TABLE IF NOT EXISTS post_likes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                post_id INTEGER NOT NULL,
                username TEXT NOT NULL,
                created_at TEXT NOT NULL,
                UNIQUE(post_id, username)
            )
        `);
        console.log("[DB] Talking: Creating post_likes table is done!");
    },

    createPostCommentsTable: async () => {
        await runQuery(socialDb, `
            CREATE TABLE IF NOT EXISTS post_comments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                post_id INTEGER NOT NULL,
                username TEXT NOT NULL,
                body TEXT NOT NULL,
                created_at TEXT NOT NULL,
                is_flagged INTEGER DEFAULT 0
            )
        `);

        // Migration: Add is_flagged if it doesn't exist
        const columns = await allQuery(socialDb, "PRAGMA table_info(post_comments)");
        const columnNames = columns.map(c => c.name);
        if (!columnNames.includes('is_flagged')) {
            await runQuery(socialDb, "ALTER TABLE post_comments ADD COLUMN is_flagged INTEGER DEFAULT 0");
        }

        console.log("[DB] Talking: Creating post_comments table is done!");
    },

    createPlaylistsTable: async () => {
        await runQuery(musicDb, `
            CREATE TABLE IF NOT EXISTS playlists (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                owner TEXT NOT NULL,
                created_at TEXT NOT NULL,
                cover_path TEXT,
                bio TEXT DEFAULT '',
                is_private TEXT DEFAULT 'private',
                share_id TEXT,
                original_owner TEXT
            )
        `);

        const columns = await allQuery(musicDb, "PRAGMA table_info(playlists)");
        const columnNames = columns.map(c => c.name);
        
        if (!columnNames.includes('bio')) {
            await runQuery(musicDb, "ALTER TABLE playlists ADD COLUMN bio TEXT DEFAULT ''");
        }
        
        if (!columnNames.includes('is_private')) {
            await runQuery(musicDb, "ALTER TABLE playlists ADD COLUMN is_private TEXT DEFAULT 'private'");
            console.log("[DB] Added is_private column to playlists table.");
        }
        
        if (!columnNames.includes('share_id')) {
            // SQLite cannot add a UNIQUE column with ALTER TABLE. Add the plain
            // column, populate it, then enforce uniqueness with an index.
            await runQuery(musicDb, "ALTER TABLE playlists ADD COLUMN share_id TEXT");
        }

        const crypto = require('crypto');
        const createShareId = async () => {
            let shareId;
            let existing;
            do {
                shareId = crypto.randomBytes(8).toString('hex');
                existing = await getQuery(musicDb, "SELECT id FROM playlists WHERE share_id = ?", [shareId]);
            } while (existing);
            return shareId;
        };

        const playlistsWithoutShareId = await allQuery(musicDb, "SELECT id FROM playlists WHERE share_id IS NULL OR share_id = ''");
        for (const playlist of playlistsWithoutShareId) {
            await runQuery(musicDb, "UPDATE playlists SET share_id = ? WHERE id = ?", [await createShareId(), playlist.id]);
        }

        // Repair any legacy duplicate IDs before creating the unique index.
        const duplicateShareIds = await allQuery(musicDb, `
            SELECT share_id FROM playlists
            WHERE share_id IS NOT NULL AND share_id != ''
            GROUP BY share_id HAVING COUNT(*) > 1
        `);
        for (const duplicate of duplicateShareIds) {
            const duplicates = await allQuery(musicDb, "SELECT id FROM playlists WHERE share_id = ? ORDER BY id", [duplicate.share_id]);
            for (const playlist of duplicates.slice(1)) {
                await runQuery(musicDb, "UPDATE playlists SET share_id = ? WHERE id = ?", [await createShareId(), playlist.id]);
            }
        }
        await runQuery(musicDb, "CREATE UNIQUE INDEX IF NOT EXISTS idx_playlists_share_id ON playlists(share_id)");

        if (!columnNames.includes('original_owner')) {
            await runQuery(musicDb, "ALTER TABLE playlists ADD COLUMN original_owner TEXT");
            await runQuery(musicDb, "UPDATE playlists SET original_owner = owner WHERE original_owner IS NULL");
            console.log("[DB] Added original_owner column to playlists table.");
        }

        console.log("[DB] Talking: Creating playlists table is done!");
    },

    createPlaylistSongsTable: async () => {
        await runQuery(musicDb, `
            CREATE TABLE IF NOT EXISTS playlist_songs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                playlist_id INTEGER NOT NULL,
                song_id INTEGER NOT NULL,
                position INTEGER NOT NULL,
                added_at TEXT NOT NULL,
                FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
                FOREIGN KEY (song_id) REFERENCES songs(id) ON DELETE CASCADE,
                UNIQUE(playlist_id, song_id)
            )
        `);
        await runQuery(musicDb, "CREATE INDEX IF NOT EXISTS idx_playlist_songs_song_id ON playlist_songs(song_id)");
        await runQuery(musicDb, "CREATE INDEX IF NOT EXISTS idx_playlist_songs_position ON playlist_songs(playlist_id, position)");
        console.log("[DB] Talking: Creating playlist_songs table is done!");
    },

    insertPlaylist: async (name, owner, originalOwner = null) => {
        const crypto = require('crypto');
        const share_id = crypto.randomBytes(8).toString('hex');
        return await runQuery(
            musicDb,
            `INSERT INTO playlists (name, owner, created_at, share_id, original_owner) VALUES (?, ?, ?, ?, ?)`,
            [name, owner, new Date().toISOString(), share_id, originalOwner || owner]
        );
    },

    getPlaylistByShareId: async (shareId) => {
        return await getQuery(musicDb, "SELECT * FROM playlists WHERE share_id = ?", [shareId]);
    },

    getPlaylistById: async (id) => {
        return await getQuery(musicDb, "SELECT * FROM playlists WHERE id = ?", [id]);
    },

    getPlaylistsByUser: async (username) => {
        return await allQuery(musicDb, `SELECT * FROM playlists WHERE owner = ? ORDER BY created_at DESC`, [username]);
    },

    getPlaylist: async (id) => {
        return await getQuery(musicDb, `SELECT * FROM playlists WHERE id = ?`, [id]);
    },

    updatePlaylistMetadata: async (id, newName, bio, isPrivate) => {
        return await runQuery(musicDb, `UPDATE playlists SET name = ?, bio = ?, is_private = ? WHERE id = ?`, [newName, bio || '', isPrivate || 'private', id]);
    },

    updatePlaylist: async (id, fields) => {
        const keys = Object.keys(fields);
        if (keys.length === 0) return;
        const setClause = keys.map(k => `${k} = ?`).join(', ');
        const values = Object.values(fields);
        values.push(id);
        return await runQuery(musicDb, `UPDATE playlists SET ${setClause} WHERE id = ?`, values);
    },

    deletePlaylist: async (id) => {
        await runQuery(musicDb, `DELETE FROM playlist_songs WHERE playlist_id = ?`, [id]);
        return await runQuery(musicDb, `DELETE FROM playlists WHERE id = ?`, [id]);
    },

    addSongToPlaylist: async (playlistId, songId, position) => {
        return await runQuery(
            musicDb,
            `INSERT INTO playlist_songs (playlist_id, song_id, position, added_at) VALUES (?, ?, ?, ?)`,
            [playlistId, songId, position, new Date().toISOString()]
        );
    },

    removeSongFromPlaylist: async (playlistId, songId) => {
        return await runQuery(musicDb, `DELETE FROM playlist_songs WHERE playlist_id = ? AND song_id = ?`, [playlistId, songId]);
    },

    removeSongFromAllPlaylists: async (songId) => {
        return await runQuery(musicDb, `DELETE FROM playlist_songs WHERE song_id = ?`, [songId]);
    },

    getPlaylistUsageCount: async (songId, excludeUser) => {
        const row = await getQuery(musicDb, `
            SELECT COUNT(*) as count 
            FROM playlist_songs ps
            JOIN playlists p ON ps.playlist_id = p.id
            WHERE ps.song_id = ? AND p.owner != ?
        `, [songId, excludeUser]);
        return row ? row.count : 0;
    },

    hideSongFromUploader: async (songId) => {
        return await runQuery(musicDb, `UPDATE songs SET hidden_from_library = 1 WHERE id = ?`, [songId]);
    },

    isSongInUserPlaylist: async (songId, username) => {
        const row = await getQuery(musicDb, `
            SELECT 1 FROM playlist_songs ps
            JOIN playlists p ON ps.playlist_id = p.id
            WHERE ps.song_id = ? AND p.owner = ?
            LIMIT 1
        `, [songId, username]);
        return row !== null;
    },

    removeSongFromUserPlaylists: async (songId, username) => {
        return await runQuery(musicDb, `
            DELETE FROM playlist_songs 
            WHERE song_id = ? AND playlist_id IN (SELECT id FROM playlists WHERE owner = ?)
        `, [songId, username]);
    },

    isSongInPublicPlaylist: async (songId) => {
        const row = await getQuery(musicDb, `
            SELECT COUNT(*) as count 
            FROM playlist_songs ps
            JOIN playlists p ON ps.playlist_id = p.id
            WHERE ps.song_id = ? AND p.is_private = 'public'
        `, [songId]);
        return row && row.count > 0;
    },

    getPlaylistSongs: async (playlistId) => {
        return await allQuery(
            musicDb,
             `SELECT ps.*, s.song_uid, s.recording_uid, s.songname, s.artist, s.album,
                     s.genre, s.year, s.duration, s.duration_ms, s.filepath, s.cover_path,
                     s.uploaded_by, s.is_private, s.bitrate, s.source, s.metadata_status,
                     s.metadata_revision, s.metadata_source, s.availability,
                     si.release_uid AS identified_release_uid,
                     si.release_track_uid AS identified_release_track_uid,
                     si.artist_credit_json AS identity_artist_credit_json,
                     si.method AS identification_method, si.source AS identification_source,
                     si.confidence AS identification_confidence
              FROM playlist_songs ps
              JOIN songs s ON ps.song_id = s.id
              LEFT JOIN song_identifications si ON si.song_id = s.id AND si.is_current = 1
             WHERE ps.playlist_id = ? AND COALESCE(s.availability, 'available') = 'available'
             ORDER BY ps.position ASC`,
            [playlistId]
        );
    },

    getPlaylistSongCount: async (playlistId) => {
        const row = await getQuery(musicDb, `
            SELECT COUNT(*) as count
            FROM playlist_songs ps
            JOIN songs s ON s.id = ps.song_id
            WHERE ps.playlist_id = ? AND COALESCE(s.availability, 'available') = 'available'
        `, [playlistId]);
        return row ? row.count : 0;
    },

    createNotificationsTable: async () => {
        await runQuery(socialDb, `
            CREATE TABLE IF NOT EXISTS notifications (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                recipient_username TEXT NOT NULL,
                actor_username TEXT NOT NULL,
                type TEXT NOT NULL, -- 'like', 'comment', 'mention'
                post_id INTEGER,
                created_at TEXT NOT NULL,
                is_read INTEGER DEFAULT 0
            )
        `);
        console.log("[DB] Talking: Creating notifications table is done!");
    },

    createMentionsTable: async () => {
        await runQuery(socialDb, `
            CREATE TABLE IF NOT EXISTS mentions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT NOT NULL, -- The one who mentioned
                target_id INTEGER NOT NULL, -- Post ID or Comment ID
                target_type TEXT NOT NULL, -- 'post' or 'comment'
                mentioned_username TEXT NOT NULL,
                created_at TEXT NOT NULL
            )
        `);
        console.log("[DB] Talking: Creating mentions table is done!");
    },

    createSocialTriggers: async () => {
        // Trigger for Social likes increment
        await runQuery(socialDb, `
            CREATE TRIGGER IF NOT EXISTS trg_likes_inc AFTER INSERT ON post_likes
            BEGIN
                UPDATE posts SET likes = likes + 1 WHERE id = NEW.post_id;
            END;
        `);
        // Trigger for Social likes decrement
        await runQuery(socialDb, `
            CREATE TRIGGER IF NOT EXISTS trg_likes_dec AFTER DELETE ON post_likes
            BEGIN
                UPDATE posts SET likes = MAX(0, likes - 1) WHERE id = OLD.post_id;
            END;
        `);
        console.log("[DB] Talking: Social triggers initialized!");
    },

    recalculateLikes: async () => {
        console.log("[DB] Repair: Recalculating like counts...");
        // Reset all to 0
        await runQuery(socialDb, `UPDATE posts SET likes = 0`);
        // Recalculate based on real data
        await runQuery(socialDb, `
            UPDATE posts 
            SET likes = (SELECT COUNT(*) FROM post_likes WHERE post_id = posts.id)
        `);
    },

    insertPost: async (username, body, type = 'text', imageUrl = null, isFlagged = 0) => {
        return await runQuery(
            socialDb,
            `INSERT INTO posts (username, body, created_at, type, image_url, is_flagged) VALUES (?, ?, ?, ?, ?, ?)`,
            [username, body, new Date().toISOString(), type, imageUrl, isFlagged]
        );
    },

    getPosts: async (options = {}, currentUsername = null, showFlagged = false) => {
        const { sortBy = 'newest', limit = 10, offset = 0 } = options;

        let orderClause = 'ORDER BY created_at DESC';
        if (sortBy === 'oldest') orderClause = 'ORDER BY created_at ASC';
        else if (sortBy === 'most_liked') orderClause = 'ORDER BY likes DESC, created_at DESC';
        else if (sortBy === 'most_commented') orderClause = 'ORDER BY comments DESC, created_at DESC';

        let whereClause = '';
        if (!showFlagged) {
            whereClause = currentUsername
                ? `WHERE (is_flagged = 0 OR username = ?)`
                : `WHERE is_flagged = 0`;
        }

        const params = [];
        if (!showFlagged && currentUsername) params.push(currentUsername);

        if (!currentUsername) {
            return await allQuery(socialDb, `SELECT * FROM posts ${whereClause} ${orderClause} LIMIT ? OFFSET ?`, [...params, limit, offset]);
        }

        params.unshift(currentUsername); // For user_has_liked
        return await allQuery(socialDb, `
            SELECT p.*, 
            (SELECT COUNT(*) FROM post_likes l WHERE l.post_id = p.id AND l.username = ?) as user_has_liked
            FROM posts p 
            ${whereClause}
            ${orderClause}
            LIMIT ? OFFSET ?
        `, [...params, limit, offset]);
    },

    getPostsCount: async () => {
        const row = await getQuery(socialDb, `SELECT COUNT(*) as count FROM posts`);
        return row ? row.count : 0;
    },

    getPostsByUser: async (targetUsername, currentUsername = null, options = {}, showFlagged = false) => {
        const { sortBy = 'newest', limit = 10, offset = 0 } = options;

        let orderClause = 'ORDER BY created_at DESC';
        if (sortBy === 'oldest') orderClause = 'ORDER BY created_at ASC';
        else if (sortBy === 'most_liked') orderClause = 'ORDER BY likes DESC, created_at DESC';
        else if (sortBy === 'most_commented') orderClause = 'ORDER BY comments DESC, created_at DESC';

        let whereClause = `WHERE p.username = ?`;
        if (!showFlagged) {
            whereClause += (currentUsername === targetUsername)
                ? `` // Author sees everything
                : ` AND is_flagged = 0`;
        }

        if (!currentUsername) {
            return await allQuery(socialDb, `SELECT * FROM posts p ${whereClause} ${orderClause} LIMIT ? OFFSET ?`, [targetUsername, limit, offset]);
        }
        return await allQuery(socialDb, `
            SELECT p.*, 
            (SELECT COUNT(*) FROM post_likes l WHERE l.post_id = p.id AND l.username = ?) as user_has_liked
            FROM posts p 
            ${whereClause}
            ${orderClause}
            LIMIT ? OFFSET ?
        `, [currentUsername, targetUsername, limit, offset]);
    },

    getPost: async (id, currentUsername = null, showFlagged = false) => {
        let whereClause = `WHERE p.id = ?`;
        if (!showFlagged && currentUsername) {
            whereClause += ` AND (p.is_flagged = 0 OR p.username = ?)`;
        } else if (!showFlagged) {
            whereClause += ` AND p.is_flagged = 0`;
        }

        const params = [id];
        if (!showFlagged && currentUsername) params.push(currentUsername);

        if (!currentUsername) {
            return await getQuery(socialDb, `SELECT * FROM posts p ${whereClause}`, params);
        }

        params.unshift(currentUsername); // For user_has_liked
        return await getQuery(socialDb, `
            SELECT p.*, 
            (SELECT COUNT(*) FROM post_likes l WHERE l.post_id = p.id AND l.username = ?) as user_has_liked
            FROM posts p 
            ${whereClause}
        `, params);
    },

    updatePostFlag: async (id, isFlagged) => {
        return await runQuery(socialDb, `UPDATE posts SET is_flagged = ? WHERE id = ?`, [isFlagged, id]);
    },

    deletePost: async (id) => {
        await runQuery(socialDb, `DELETE FROM post_likes WHERE post_id = ?`, [id]);
        await runQuery(socialDb, `DELETE FROM post_comments WHERE post_id = ?`, [id]);
        return await runQuery(socialDb, `DELETE FROM posts WHERE id = ?`, [id]);
    },

    toggleLike: async (postId, username) => {
        // Atomic Toggle: Try to delete first. 
        // If it was there, it's removed (decrement handled by trigger).
        // If it wasn't there, we insert it (increment handled by trigger).

        try {
            const result = await runQuery(socialDb, `DELETE FROM post_likes WHERE post_id = ? AND username = ?`, [postId, username]);
            if (result.changes > 0) {
                return { liked: false };
            } else {
                await runQuery(socialDb, `INSERT INTO post_likes (post_id, username, created_at) VALUES (?, ?, ?)`, [postId, username, new Date().toISOString()]);
                return { liked: true };
            }
        } catch (err) {
            // Concurrent request might have inserted it between our DELETE and INSERT
            if (err.code === 'SQLITE_CONSTRAINT') {
                // Fallback: Delete it if the insert failed due to it being there now
                await runQuery(socialDb, `DELETE FROM post_likes WHERE post_id = ? AND username = ?`, [postId, username]);
                return { liked: false };
            }
            throw err;
        }
    },

    addComment: async (postId, username, body, isFlagged = 0) => {
        await runQuery(socialDb, `INSERT INTO post_comments (post_id, username, body, created_at, is_flagged) VALUES (?, ?, ?, ?, ?)`, [postId, username, body, new Date().toISOString(), isFlagged]);
        await runQuery(socialDb, `UPDATE posts SET comments = comments + 1 WHERE id = ?`, [postId]);
        return { success: true };
    },

    getComments: async (postId, currentUsername = null, showFlagged = false) => {
        let whereClause = `WHERE post_id = ?`;
        const params = [postId];

        if (!showFlagged) {
            if (currentUsername) {
                whereClause += ` AND (is_flagged = 0 OR username = ?)`;
                params.push(currentUsername);
            } else {
                whereClause += ` AND is_flagged = 0`;
            }
        }

        return await allQuery(socialDb, `SELECT * FROM post_comments ${whereClause} ORDER BY created_at ASC`, params);
    },

    getComment: async (id) => {
        return await getQuery(socialDb, `SELECT * FROM post_comments WHERE id = ?`, [id]);
    },

    deleteComment: async (id) => {
        const comment = await getQuery(socialDb, `SELECT post_id FROM post_comments WHERE id = ?`, [id]);
        if (comment) {
            await runQuery(socialDb, `UPDATE posts SET comments = MAX(0, comments - 1) WHERE id = ?`, [comment.post_id]);
        }
        return await runQuery(socialDb, `DELETE FROM post_comments WHERE id = ?`, [id]);
    },

    addNotification: async (recipient, actor, type, postId) => {
        if (recipient === actor) return; // Don't notify yourself
        return await runQuery(socialDb, `
            INSERT INTO notifications (recipient_username, actor_username, type, post_id, created_at)
            VALUES (?, ?, ?, ?, ?)
        `, [recipient, actor, type, postId, new Date().toISOString()]);
    },

    insertMention: async (userId, targetId, targetType, mentionedUsername) => {
        return await runQuery(socialDb, `
            INSERT INTO mentions (user_id, target_id, target_type, mentioned_username, created_at)
            VALUES (?, ?, ?, ?, ?)
        `, [userId, targetId, targetType, mentionedUsername, new Date().toISOString()]);
    },

    getNotifications: async (username, offset = 0, limit = 20) => {
        return await allQuery(socialDb, `
            SELECT * FROM notifications 
            WHERE recipient_username = ? 
            ORDER BY created_at DESC 
            LIMIT ? OFFSET ?
        `, [username, limit, offset]);
    },

    markNotificationsAsRead: async (username) => {
        return await runQuery(socialDb, `
            UPDATE notifications SET is_read = 1 
            WHERE recipient_username = ? AND is_read = 0
        `, [username]);
    },

    backupDatabase: async () => {
        const baseBackupDir = RT.paths.backups;
        if (!fs.existsSync(baseBackupDir)) fs.mkdirSync(baseBackupDir, { recursive: true });

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const currentBackupDir = path.join(baseBackupDir, `backup_${timestamp}`);

        if (!fs.existsSync(currentBackupDir)) fs.mkdirSync(currentBackupDir, { recursive: true });

        const dbs = [
            { name: 'users', db: usersDb },
            { name: 'music', db: musicDb },
            { name: 'lyrics', db: lyricsDb }
        ];

        console.log(`[DB] Backup: Starting maintenance (Session: backup_${timestamp})...`);

        for (const item of dbs) {
            const backupPath = path.join(currentBackupDir, `${item.name}.db`);
            try {
                await runQuery(item.db, `VACUUM INTO ?`, [backupPath]);
            } catch (err) {
                console.error(`[DB] Backup ERROR for ${item.name}:`, err);
            }
        }

        // Retention Policy: Keep last 7 backup folders
        try {
            const items = fs.readdirSync(baseBackupDir);
            const folders = items
                .map(name => ({ name, path: path.join(baseBackupDir, name) }))
                .filter(item => fs.statSync(item.path).isDirectory() && item.name.startsWith('backup_'))
                .map(item => ({ ...item, time: fs.statSync(item.path).mtime.getTime() }))
                .sort((a, b) => b.time - a.time);

            if (folders.length > 7) {
                const toDelete = folders.slice(7);
                for (const folder of toDelete) {
                    fs.rmSync(folder.path, { recursive: true, force: true });
                }
                console.log(`[DB] Backup: Cleaned up ${toDelete.length} old backup sessions.`);
            }

            // Optional: Clean up loose .db files from the old system if any remain
            const looseFiles = items.filter(f => f.endsWith('.db'));
            for (const file of looseFiles) {
                fs.unlinkSync(path.join(baseBackupDir, file));
            }
        } catch (err) {
            console.error("[DB] Backup Cleanup ERROR:", err);
        }

        console.log(`[DB] Backup: All databases successfully saved to Database/Backups/backup_${timestamp}/`);
    },

    createDmRequestsTable: async () => {
        await runQuery(socialDb, `
            CREATE TABLE IF NOT EXISTS dm_requests (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                from_username TEXT NOT NULL,
                to_username TEXT NOT NULL,
                status TEXT DEFAULT 'pending',
                created_at TEXT NOT NULL,
                UNIQUE(from_username, to_username)
            )
        `);
        console.log("[DB] Talking: Creating dm_requests table is done!");
    },

    createDmConversationsTable: async () => {
        await runQuery(socialDb, `
            CREATE TABLE IF NOT EXISTS dm_conversations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user1 TEXT NOT NULL,
                user2 TEXT NOT NULL,
                created_at TEXT NOT NULL,
                UNIQUE(user1, user2)
            )
        `);
        console.log("[DB] Talking: Creating dm_conversations table is done!");
    },

    createDmMessagesTable: async () => {
        await runQuery(socialDb, `
            CREATE TABLE IF NOT EXISTS dm_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                conversation_id INTEGER NOT NULL,
                sender_username TEXT NOT NULL,
                body TEXT NOT NULL,
                is_read INTEGER DEFAULT 0,
                created_at TEXT NOT NULL,
                FOREIGN KEY (conversation_id) REFERENCES dm_conversations(id)
            )
        `);
        console.log("[DB] Talking: Creating dm_messages table is done!");
    },

    createSystemLogsTable: async () => {
        await runQuery(usersDb, `
            CREATE TABLE IF NOT EXISTS system_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL,
                action TEXT NOT NULL,
                details TEXT,
                timestamp TEXT NOT NULL
            )
        `);
        console.log("[DB] Talking: Creating system_logs table is done!");
    },

    createSystemConfigTable: async () => {
        await runQuery(usersDb, `
            CREATE TABLE IF NOT EXISTS system_config (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                key TEXT UNIQUE NOT NULL,
                value TEXT NOT NULL
            )
        `);
        console.log("[DB] Talking: Creating system_config table is done!");
    },

    // --- DM Query Methods ---

    sendDmRequest: async (fromUsername, toUsername) => {
        return await runQuery(
            socialDb,
            `INSERT INTO dm_requests (from_username, to_username, status, created_at) VALUES (?, ?, 'pending', ?)`,
            [fromUsername, toUsername, new Date().toISOString()]
        );
    },

    getDmRequest: async (id) => {
        return await getQuery(socialDb, `SELECT * FROM dm_requests WHERE id = ?`, [id]);
    },

    getPendingDmRequests: async (username) => {
        return await allQuery(socialDb, `SELECT * FROM dm_requests WHERE to_username = ? AND status = 'pending' ORDER BY created_at DESC`, [username]);
    },

    getSentDmRequests: async (username) => {
        return await allQuery(socialDb, `SELECT * FROM dm_requests WHERE from_username = ? ORDER BY created_at DESC`, [username]);
    },

    getDmRequestBetween: async (user1, user2) => {
        return await getQuery(
            socialDb,
            `SELECT * FROM dm_requests WHERE ((from_username = ? AND to_username = ?) OR (from_username = ? AND to_username = ?)) AND status IN ('pending', 'accepted')`,
            [user1, user2, user2, user1]
        );
    },

    updateDmRequestStatus: async (id, status) => {
        return await runQuery(socialDb, `UPDATE dm_requests SET status = ? WHERE id = ?`, [status, id]);
    },

    createDmConversation: async (user1, user2) => {
        const sorted = [user1, user2].sort();
        return await runQuery(
            socialDb,
            `INSERT INTO dm_conversations (user1, user2, created_at) VALUES (?, ?, ?)`,
            [sorted[0], sorted[1], new Date().toISOString()]
        );
    },

    getDmConversation: async (user1, user2) => {
        const sorted = [user1, user2].sort();
        return await getQuery(socialDb, `SELECT * FROM dm_conversations WHERE user1 = ? AND user2 = ?`, [sorted[0], sorted[1]]);
    },

    getDmConversationById: async (id) => {
        return await getQuery(socialDb, `SELECT * FROM dm_conversations WHERE id = ?`, [id]);
    },

    getDmContacts: async (username) => {
        return await allQuery(
            socialDb,
            `SELECT c.*, m.body AS last_message, m.created_at AS last_message_time, m.sender_username AS last_sender,
                (SELECT COUNT(*) FROM dm_messages WHERE conversation_id = c.id AND sender_username != ? AND is_read = 0) AS unread_count
            FROM dm_conversations c
            LEFT JOIN dm_messages m ON m.id = (SELECT id FROM dm_messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1)
            WHERE c.user1 = ? OR c.user2 = ?
            ORDER BY m.created_at DESC NULLS LAST`,
            [username, username, username]
        );
    },

    getDmMessages: async (conversationId, limit = 30, offset = 0) => {
        return await allQuery(
            socialDb,
            `SELECT * FROM dm_messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`,
            [conversationId, limit, offset]
        );
    },

    insertDmMessage: async (conversationId, senderUsername, body) => {
        return await runQuery(
            socialDb,
            `INSERT INTO dm_messages (conversation_id, sender_username, body, created_at) VALUES (?, ?, ?, ?)`,
            [conversationId, senderUsername, body, new Date().toISOString()]
        );
    },

    markDmMessagesRead: async (conversationId, username) => {
        return await runQuery(
            socialDb,
            `UPDATE dm_messages SET is_read = 1 WHERE conversation_id = ? AND sender_username != ? AND is_read = 0`,
            [conversationId, username]
        );
    },

    getDmUnreadCount: async (username) => {
        const row = await getQuery(
            socialDb,
            `SELECT COUNT(*) AS count FROM dm_messages m
            JOIN dm_conversations c ON m.conversation_id = c.id
            WHERE (c.user1 = ? OR c.user2 = ?) AND m.sender_username != ? AND m.is_read = 0`,
            [username, username, username]
        );
        return row ? row.count : 0;
    },

    close: async () => {
        console.log("[DB] Shutting down: Merging WAL logs and closing connections...");
        const dbs = [
            { name: 'Users', db: usersDb },
            { name: 'Music', db: musicDb },
            { name: 'Lyrics', db: lyricsDb }
        ];

        const errors = [];
        for (const item of dbs) {
            try {
                // Perform a full checkpoint to merge WAL into the main DB file
                await runQuery(item.db, 'PRAGMA wal_checkpoint(FULL)');
            } catch (err) {
                errors.push(new Error(`${item.name} checkpoint failed: ${err.message}`));
                console.error(`[DB] Error checkpointing ${item.name} database:`, err);
            }

            try {
                await new Promise((resolve, reject) => {
                    item.db.close((err) => {
                        if (err) reject(err);
                        else resolve();
                    });
                });
                console.log(`[DB] ${item.name} database closed safely.`);
            } catch (err) {
                errors.push(new Error(`${item.name} close failed: ${err.message}`));
                console.error(`[DB] Error closing ${item.name} database:`, err);
            }
        }
        if (errors.length > 0) throw new AggregateError(errors, 'One or more databases did not shut down cleanly');
    },

    updateUserTelemetry: async (username, songId, listenTimeDelta, playCountDelta) => {
        const now = new Date().toISOString();
        return await runQuery(
            usersDb,
            `INSERT INTO listening_telemetry (username, song_id, listen_time, play_count, last_listened_at) 
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(username, song_id) DO UPDATE SET 
             listen_time = listen_time + excluded.listen_time,
             play_count = play_count + excluded.play_count,
             last_listened_at = excluded.last_listened_at`,
            [username, songId, listenTimeDelta, playCountDelta, now]
        );
    },

    getAllUserTelemetry: async (username) => {
        return await allQuery(
            usersDb,
            `SELECT * FROM listening_telemetry WHERE username = ?`,
            [username]
        );
    },

    getUserTelemetryStats: async (username) => {
        // Because listening_telemetry is in usersDb and songs is in musicDb, 
        // we can't join them directly in SQLite using a simple JOIN unless we attach the DBs.
        // We will fetch telemetry, then fetch songs, and join them in JS.
        const telemetry = await HandleDatabase.getAllUserTelemetry(username);

        let totalTime = 0;
        let topSongsMap = {}; // song_id -> stats
        let artistMap = {}; // artist -> listen_time
        let genreMap = {}; // genre -> listen_time

        for (const t of telemetry) {
            totalTime += t.listen_time;
            topSongsMap[t.song_id] = t;
        }

        // Fetch song info from musicDb for all collected song_ids
        if (telemetry.length > 0) {
            const songIds = telemetry.map(t => t.song_id);
            const placeholders = songIds.map(() => '?').join(',');
            const songs = await allQuery(musicDb, `SELECT id, songname, artist, genre, cover_path FROM songs WHERE id IN (${placeholders})`, songIds);

            for (const song of songs) {
                const t = topSongsMap[song.id];
                if (!t) continue;

                // Aggregate artist
                if (song.artist) {
                    artistMap[song.artist] = (artistMap[song.artist] || 0) + t.listen_time;
                }
                // Aggregate genre
                if (song.genre) {
                    genreMap[song.genre] = (genreMap[song.genre] || 0) + t.listen_time;
                }
            }
        }

        const sortedArtists = Object.entries(artistMap).sort((a, b) => b[1] - a[1]);
        const sortedGenres = Object.entries(genreMap).sort((a, b) => b[1] - a[1]);

        return {
            total_listen_time: totalTime, // in seconds
            favorite_artist: sortedArtists.length > 0 ? sortedArtists[0][0] : "Unknown",
            favorite_genre: sortedGenres.length > 0 ? sortedGenres[0][0] : "Unknown"
        };
    },

    insertSystemLog: async (username, action, details) => {
        return await runQuery(
            usersDb,
            `INSERT INTO system_logs (username, action, details, timestamp) VALUES (?, ?, ?, ?)`,
            [username, action, details, new Date().toISOString()]
        );
    },

    getSystemConfig: async () => {
        return await allQuery(usersDb, `SELECT * FROM system_config`);
    },

    getSystemConfigValue: async (key) => {
        const row = await getQuery(usersDb, 'SELECT value FROM system_config WHERE key = ?', [key]);
        return row ? row.value : null;
    },

    updateSystemConfig: async (key, value) => {
        return await runQuery(
            usersDb,
            `INSERT INTO system_config (key, value) VALUES (?, ?) 
             ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
            [key, value]
        );
    },

    updateMetadataSystemConfig: serializeTransaction(usersDb, async ({
        mode,
        acoustidKey,
        updateKey = false,
        requireAcoustidKey = false,
        environmentKeyConfigured = false
    }) => {
        let inTransaction = false;
        try {
            await runQuery(usersDb, 'BEGIN IMMEDIATE');
            inTransaction = true;
            if (updateKey) {
                await runQuery(usersDb, `
                    INSERT INTO system_config (key, value) VALUES ('acoustid_client_key', ?)
                    ON CONFLICT(key) DO UPDATE SET value = excluded.value
                `, [JSON.stringify(acoustidKey || '')]);
            }
            if (requireAcoustidKey && !environmentKeyConfigured) {
                const storedRow = await getQuery(usersDb, "SELECT value FROM system_config WHERE key = 'acoustid_client_key'");
                const storedKey = storedRow ? parseMetadataValue(storedRow.value) : '';
                if (typeof storedKey !== 'string' || storedKey.length === 0) {
                    await runQuery(usersDb, 'ROLLBACK');
                    inTransaction = false;
                    return { updated: false, missingAcoustidKey: true };
                }
            }
            await runQuery(usersDb, `
                INSERT INTO system_config (key, value) VALUES ('metadata_lookup_mode', ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value
            `, [JSON.stringify(mode)]);
            await runQuery(usersDb, 'COMMIT');
            inTransaction = false;
            return { updated: true };
        } catch (error) {
            if (inTransaction) {
                try { await runQuery(usersDb, 'ROLLBACK'); } catch { /* preserve original error */ }
            }
            throw error;
        }
    }),

    deleteSystemConfig: async (key) => {
        return await runQuery(usersDb, 'DELETE FROM system_config WHERE key = ?', [key]);
    },

    /* =====================================================================
     * Download queue
     * ---------------------------------------------------------------------
     * Acquiring music from Soulseek is slow, network-bound and easy to
     * interrupt (a Spotify album is 15 sequential downloads). The queue is
     * therefore persisted rather than held in memory, so a restart mid-import
     * resumes instead of silently losing the remaining tracks.
     * ===================================================================== */

    createDownloadQueueTable: async () => {
        await runQuery(musicDb, `
            CREATE TABLE IF NOT EXISTS download_queue (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                queue_uid TEXT UNIQUE NOT NULL,
                batch_uid TEXT,
                batch_label TEXT,
                status TEXT NOT NULL DEFAULT 'queued',
                stage TEXT,
                requested_source TEXT NOT NULL DEFAULT 'auto',
                resolved_source TEXT,
                title TEXT NOT NULL,
                artist TEXT,
                album TEXT,
                duration_seconds INTEGER,
                search_query TEXT,
                source_url TEXT,
                source_payload TEXT,
                artwork_url TEXT,
                dedupe_key TEXT,
                progress REAL NOT NULL DEFAULT 0,
                eta_seconds INTEGER,
                transferred_bytes INTEGER NOT NULL DEFAULT 0,
                total_bytes INTEGER NOT NULL DEFAULT 0,
                attempts INTEGER NOT NULL DEFAULT 0,
                file_path TEXT,
                song_id INTEGER,
                error TEXT,
                requested_by TEXT NOT NULL,
                created_at TEXT NOT NULL,
                started_at TEXT,
                completed_at TEXT
            )
        `);

        await runQuery(musicDb, 'CREATE INDEX IF NOT EXISTS idx_download_queue_status ON download_queue(status, id)');
        await runQuery(musicDb, 'CREATE INDEX IF NOT EXISTS idx_download_queue_batch ON download_queue(batch_uid, id)');
        await runQuery(musicDb, 'CREATE INDEX IF NOT EXISTS idx_download_queue_created ON download_queue(created_at)');
        // Partial uniqueness only over live rows: the same track may legitimately
        // be downloaded again later, but must never sit in the queue twice.
        await runQuery(musicDb, `
            CREATE UNIQUE INDEX IF NOT EXISTS idx_download_queue_active_dedupe
            ON download_queue(dedupe_key)
            WHERE dedupe_key IS NOT NULL AND status IN ('queued', 'running')
        `);

        console.log("[DB] Talking: Creating download_queue table is done!");
    },

    enqueueDownloads: serializeTransaction(musicDb, async (items, requestedBy) => {
        if (!Array.isArray(items) || items.length === 0) return { accepted: [], skipped: [] };

        const createdAt = new Date().toISOString();
        const accepted = [];
        const skipped = [];
        let inTransaction = false;

        try {
            await runQuery(musicDb, 'BEGIN IMMEDIATE');
            inTransaction = true;

            for (const item of items) {
                // A duplicate is not an error: bulk imports overlap constantly.
                // Report it back so the UI can say "already queued" per track.
                if (item.dedupeKey) {
                    const clash = await getQuery(musicDb, `
                        SELECT id FROM download_queue
                        WHERE dedupe_key = ? AND status IN ('queued', 'running')
                    `, [item.dedupeKey]);
                    if (clash) {
                        skipped.push({ title: item.title, reason: 'already_queued' });
                        continue;
                    }
                }

                const queueUid = crypto.randomUUID();
                const result = await runQuery(musicDb, `
                    INSERT INTO download_queue (
                        queue_uid, batch_uid, batch_label, status, stage, requested_source,
                        title, artist, album, duration_seconds, search_query, source_url,
                        source_payload, artwork_url, dedupe_key, requested_by, created_at
                    ) VALUES (?, ?, ?, 'queued', 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `, [
                    queueUid,
                    item.batchUid || null,
                    item.batchLabel || null,
                    item.requestedSource || 'auto',
                    item.title,
                    item.artist || null,
                    item.album || null,
                    Number.isFinite(item.durationSeconds) ? Math.round(item.durationSeconds) : null,
                    item.searchQuery || null,
                    item.sourceUrl || null,
                    item.sourcePayload ? JSON.stringify(item.sourcePayload) : null,
                    item.artworkUrl || null,
                    item.dedupeKey || null,
                    requestedBy,
                    createdAt
                ]);

                accepted.push(await getQuery(musicDb, 'SELECT * FROM download_queue WHERE id = ?', [result.lastID]));
            }

            await runQuery(musicDb, 'COMMIT');
            inTransaction = false;
            return { accepted, skipped };
        } catch (error) {
            if (inTransaction) {
                try { await runQuery(musicDb, 'ROLLBACK'); } catch { /* preserve original error */ }
            }
            throw error;
        }
    }),

    getDownloadQueue: async ({ limit = 200 } = {}) => {
        const safeLimit = Math.min(Math.max(Number(limit) || 200, 1), 500);
        return await allQuery(musicDb, `
            SELECT * FROM download_queue
            ORDER BY
                CASE status WHEN 'running' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END,
                CASE WHEN status IN ('running', 'queued') THEN id ELSE -id END
            LIMIT ?
        `, [safeLimit]);
    },

    getDownloadItem: async (identifier) => {
        const isNumeric = /^\d+$/.test(String(identifier));
        return await getQuery(
            musicDb,
            isNumeric ? 'SELECT * FROM download_queue WHERE id = ?' : 'SELECT * FROM download_queue WHERE queue_uid = ?',
            [isNumeric ? Number(identifier) : String(identifier)]
        );
    },

    /** Public thumbnail retained by an explicit YouTube download made before
     * cover_source_url was populated correctly. Callers still validate it. */
    getCompletedYoutubeArtworkForSong: async (songId) => {
        const row = await getQuery(musicDb, `
            SELECT artwork_url FROM download_queue
            WHERE song_id = ? AND status = 'completed'
              AND requested_source = 'youtube' AND resolved_source = 'youtube'
              AND artwork_url IS NOT NULL
            ORDER BY id DESC LIMIT 1
        `, [songId]);
        return row && row.artwork_url ? row.artwork_url : null;
    },

    /**
     * Atomically moves the oldest queued row to 'running'.
     * The UPDATE ... WHERE status = 'queued' guard is what makes this safe if a
     * second worker is ever introduced.
     */
    claimNextDownload: serializeTransaction(musicDb, async () => {
        const next = await getQuery(musicDb, `
            SELECT * FROM download_queue WHERE status = 'queued' ORDER BY id ASC LIMIT 1
        `);
        if (!next) return null;

        const claimed = await runQuery(musicDb, `
            UPDATE download_queue
            SET status = 'running', stage = 'preparing', started_at = ?, attempts = attempts + 1,
                error = NULL, progress = 0, eta_seconds = NULL, transferred_bytes = 0
            WHERE id = ? AND status = 'queued'
        `, [new Date().toISOString(), next.id]);

        if (!claimed.changes) return null;
        return await getQuery(musicDb, 'SELECT * FROM download_queue WHERE id = ?', [next.id]);
    }),

    updateDownloadItem: async (id, updates = {}) => {
        const allowed = new Set([
            'status', 'stage', 'resolved_source', 'progress', 'eta_seconds',
            'transferred_bytes', 'total_bytes', 'file_path', 'song_id', 'error',
            'title', 'artist', 'album', 'duration_seconds', 'artwork_url',
            'source_url', 'source_payload', 'completed_at', 'dedupe_key'
        ]);
        const fields = Object.keys(updates).filter(field => allowed.has(field));
        if (fields.length === 0) return null;

        await runQuery(
            musicDb,
            `UPDATE download_queue SET ${fields.map(field => `${field} = ?`).join(', ')} WHERE id = ?`,
            [...fields.map(field => updates[field]), id]
        );
        return await getQuery(musicDb, 'SELECT * FROM download_queue WHERE id = ?', [id]);
    },

    /**
     * Only a row still marked 'running' may be finished. Without that guard a
     * cancel that lands mid-transfer would be silently overwritten by the
     * worker's completion write, resurrecting a download the user stopped.
     */
    finishDownloadItem: async (id, { status, error = null, filePath = null, songId = null, resolvedSource = null }) => {
        await runQuery(musicDb, `
            UPDATE download_queue
            SET status = ?, stage = NULL, error = ?, file_path = COALESCE(?, file_path),
                song_id = COALESCE(?, song_id), resolved_source = COALESCE(?, resolved_source),
                progress = CASE WHEN ? = 'completed' THEN 1 ELSE progress END,
                eta_seconds = NULL, completed_at = ?
            WHERE id = ? AND status = 'running'
        `, [status, error, filePath, songId, resolvedSource, status, new Date().toISOString(), id]);
        return await getQuery(musicDb, 'SELECT * FROM download_queue WHERE id = ?', [id]);
    },

    cancelDownloadItem: async (id) => {
        const result = await runQuery(musicDb, `
            UPDATE download_queue
            SET status = 'cancelled', stage = NULL, eta_seconds = NULL, completed_at = ?
            WHERE id = ? AND status IN ('queued', 'running')
        `, [new Date().toISOString(), id]);
        return result.changes > 0;
    },

    cancelDownloadBatch: async (batchUid) => {
        const result = await runQuery(musicDb, `
            UPDATE download_queue
            SET status = 'cancelled', stage = NULL, eta_seconds = NULL, completed_at = ?
            WHERE batch_uid = ? AND status IN ('queued', 'running')
        `, [new Date().toISOString(), batchUid]);
        return result.changes;
    },

    cancelAllPendingDownloads: async () => {
        const result = await runQuery(musicDb, `
            UPDATE download_queue
            SET status = 'cancelled', stage = NULL, eta_seconds = NULL, completed_at = ?
            WHERE status IN ('queued', 'running')
        `, [new Date().toISOString()]);
        return result.changes;
    },

    retryDownloadItem: async (id) => {
        const result = await runQuery(musicDb, `
            UPDATE download_queue
            SET status = 'queued', stage = 'pending', error = NULL, progress = 0,
                eta_seconds = NULL, transferred_bytes = 0, started_at = NULL, completed_at = NULL
            WHERE id = ? AND status IN ('failed', 'cancelled')
              AND requested_source != 'youtube'
        `, [id]);
        if (!result.changes) return null;
        return await getQuery(musicDb, 'SELECT * FROM download_queue WHERE id = ?', [id]);
    },

    clearFinishedDownloads: async () => {
        const result = await runQuery(
            musicDb,
            "DELETE FROM download_queue WHERE status IN ('completed', 'failed', 'cancelled')"
        );
        return result.changes;
    },

    /**
     * Boot recovery. A row left in 'running' means the process died mid-transfer,
     * so its temp file is gone and it must start over rather than hang forever.
     */
    recoverDownloadQueue: async () => {
        const result = await runQuery(musicDb, `
            UPDATE download_queue
            SET status = 'queued', stage = 'pending', progress = 0, eta_seconds = NULL,
                transferred_bytes = 0, started_at = NULL
            WHERE status = 'running'
        `);
        return result.changes;
    },

    retireYoutubeDownloads: async () => {
        const result = await runQuery(musicDb, `
            UPDATE download_queue
            SET status = 'failed', stage = NULL, eta_seconds = NULL,
                error = 'YouTube downloads are no longer supported.', completed_at = ?
            WHERE status IN ('queued', 'running')
              AND (requested_source = 'youtube' OR resolved_source = 'youtube')
        `, [new Date().toISOString()]);
        return result.changes;
    },

    countPendingDownloads: async () => {
        const row = await getQuery(
            musicDb,
            "SELECT COUNT(*) AS total FROM download_queue WHERE status IN ('queued', 'running')"
        );
        return row ? Number(row.total) || 0 : 0;
    },

    allQuery: async (dbName, query, params = []) => {
        const db = dbName === 'users' ? usersDb : (dbName === 'music' ? musicDb : usersDb);
        return await allQuery(db, query, params);
    }
};


module.exports = HandleDatabase;

