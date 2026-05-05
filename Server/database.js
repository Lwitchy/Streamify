const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

// Ensure Database directories exist
const dbUsersDir = path.join(__dirname, '../Database/Dev/Users');
const dbMusicDir = path.join(__dirname, '../Database/Dev/Music');
const dbSocialDir = path.join(__dirname, '../Database/Dev/Social');

if (!fs.existsSync(dbUsersDir)) fs.mkdirSync(dbUsersDir, { recursive: true });
if (!fs.existsSync(dbMusicDir)) fs.mkdirSync(dbMusicDir, { recursive: true });
if (!fs.existsSync(dbSocialDir)) fs.mkdirSync(dbSocialDir, { recursive: true });

// Initialize connections
const usersDb = new sqlite3.Database(path.join(dbUsersDir, 'users.db'), (err) => {
    if (err) console.error("Error opening users db:", err);
    else usersDb.run("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;");
});

const musicDb = new sqlite3.Database(path.join(dbMusicDir, 'music.db'), (err) => {
    if (err) console.error("Error opening music db:", err);
    else musicDb.run("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;");
});

const socialDb = new sqlite3.Database(path.join(dbSocialDir, 'social.db'), (err) => {
    if (err) console.error("Error opening social db:", err);
    else socialDb.run("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;");
});

const lyricsDb = new sqlite3.Database(path.join(dbMusicDir, 'lyrics.db'), (err) => {
    if (err) console.error("Error opening lyrics db:", err);
    else lyricsDb.run("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;");
});

// Helper for Promises
const runQuery = (db, query, params = []) => {
    return new Promise((resolve, reject) => {
        db.run(query, params, function (err) {
            if (err) reject(err);
            else resolve(this);
        });
    });
};

const getQuery = (db, query, params = []) => {
    return new Promise((resolve, reject) => {
        db.get(query, params, (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
};

const allQuery = (db, query, params = []) => {
    return new Promise((resolve, reject) => {
        db.all(query, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
};

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
                timeout_until TEXT
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

        // Set initial owner
        await runQuery(usersDb, "UPDATE users SET role = 'Owner' WHERE username = 'lwitchy'");

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

        console.log("[DB] Talking: Creating/Updating sessions table is done!");
    },

    insertUser: async (username, password, email = "") => {
        // Default role is User unless explicitly set
        const role = 'User';
        return await runQuery(
            usersDb,
            `INSERT INTO users (username, password, email, created_at, storage_used, is_admin, total_likes, role) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [username, password, email, new Date().toISOString(), 0, 0, 0, role]
        );
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
        const songs = await allQuery(musicDb, `SELECT filepath, uploaded_by FROM songs`);
        
        for (const user of users) {
            let totalBytes = 0;
            const userSongs = songs.filter(s => s.uploaded_by === user.username);
            for (const song of userSongs) {
                const fullPath = path.join(__dirname, '../', song.filepath);
                try {
                    if (fs.existsSync(fullPath)) {
                        const stats = fs.statSync(fullPath);
                        totalBytes += stats.size;
                    }
                } catch (e) {
                    console.error(`[DB] Error calculating size for ${fullPath}:`, e);
                }
            }
            await runQuery(usersDb, `UPDATE users SET storage_used = ? WHERE username = ?`, [totalBytes, user.username]);
        }
        console.log("[DB] Recalculated storage_used for all users.");
    },

    deleteUser: async (username) => {
        return await runQuery(usersDb, `DELETE FROM users WHERE username = ?`, [username]);
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
            const allSongs = await HandleDatabase.getAllSongs();
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
                songname TEXT NOT NULL,
                artist TEXT NOT NULL,
                album TEXT NOT NULL,
                genre TEXT,
                duration TEXT,
                filepath TEXT NOT NULL,
                created_at TEXT NOT NULL,
                uploaded_by TEXT DEFAULT 'Unknown User',
                is_private TEXT DEFAULT 'private',
                is_favorite INTEGER DEFAULT 0,
                play_count INTEGER DEFAULT 0,
                cover_path TEXT,
                youtube_id TEXT,
                file_hash TEXT,
                bitrate INTEGER DEFAULT 128,
                source TEXT DEFAULT 'upload',
                hidden_from_library INTEGER DEFAULT 0
            )
        `);

        // Migration: Add columns if they don't exist
        const columns = await allQuery(musicDb, "PRAGMA table_info(songs)");
        const columnNames = columns.map(c => c.name);
        if (!columnNames.includes('youtube_id')) {
            await runQuery(musicDb, "ALTER TABLE songs ADD COLUMN youtube_id TEXT");
        }
        if (!columnNames.includes('file_hash')) {
            await runQuery(musicDb, "ALTER TABLE songs ADD COLUMN file_hash TEXT");
        }
        if (!columnNames.includes('bitrate')) {
            await runQuery(musicDb, "ALTER TABLE songs ADD COLUMN bitrate INTEGER DEFAULT 128");
        }
        if (!columnNames.includes('source')) {
            await runQuery(musicDb, "ALTER TABLE songs ADD COLUMN source TEXT DEFAULT 'upload'");
        }
        if (!columnNames.includes('hidden_from_library')) {
            await runQuery(musicDb, "ALTER TABLE songs ADD COLUMN hidden_from_library INTEGER DEFAULT 0");
        }

        console.log("[DB] Talking: Creating/Updating songs table is done!");
    },

    insertSong: async (songname, artist, album, genre, duration, filepath, uploaded_by = "Unknown User", visibility = "private", youtube_id = null, file_hash = null, bitrate = 128, source = "upload") => {
        return await runQuery(
            musicDb,
            `INSERT OR IGNORE INTO songs (songname, artist, album, genre, duration, filepath, created_at, uploaded_by, is_private, is_favorite, play_count, youtube_id, file_hash, bitrate, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [songname, artist, album, genre, duration, filepath, new Date().toISOString(), uploaded_by, visibility, 0, 0, youtube_id, file_hash, bitrate, source]
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

    getSongByFilepath: async (filepath) => {
        return await getQuery(musicDb, `SELECT * FROM songs WHERE filepath = ?`, [filepath]);
    },

    getSong: async (identifier) => {
        // Try to get by ID if it's a number, otherwise by name
        const query = (typeof identifier === 'number' || !isNaN(identifier))
            ? `SELECT * FROM songs WHERE id = ?`
            : `SELECT * FROM songs WHERE songname = ?`;
        return await getQuery(musicDb, query, [identifier]);
    },

    getAllSongs: async () => {
        return await allQuery(musicDb, `SELECT * FROM songs`);
    },

    getSongsCount: async () => {
        const row = await getQuery(musicDb, `SELECT COUNT(*) as count FROM songs`);
        return row ? row.count : 0;
    },

    getSongsByUser: async (username) => {
        return await allQuery(musicDb, `SELECT * FROM songs WHERE uploaded_by = ?`, [username]);
    },

    deleteSong: async (id) => {
        return await runQuery(musicDb, `DELETE FROM songs WHERE id = ?`, [id]);
    },

    updateSong: async (id, updates) => {
        const fields = Object.keys(updates);
        const values = Object.values(updates);
        const setClause = fields.map(f => `${f} = ?`).join(', ');
        return await runQuery(musicDb, `UPDATE songs SET ${setClause} WHERE id = ?`, [...values, id]);
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
                share_id TEXT UNIQUE,
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
            await runQuery(musicDb, "ALTER TABLE playlists ADD COLUMN share_id TEXT UNIQUE");
            // Fill existing playlists with share_ids
            const playlists = await allQuery(musicDb, "SELECT id FROM playlists WHERE share_id IS NULL");
            const crypto = require('crypto');
            for (const p of playlists) {
                const sid = crypto.randomBytes(8).toString('hex');
                await runQuery(musicDb, "UPDATE playlists SET share_id = ? WHERE id = ?", [sid, p.id]);
            }
            console.log("[DB] Added share_id column and populated existing playlists.");
        }

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
            `SELECT ps.*, s.songname, s.artist, s.album, s.duration, s.filepath, s.cover_path, s.uploaded_by, s.is_private, s.bitrate
             FROM playlist_songs ps
             JOIN songs s ON ps.song_id = s.id
             WHERE ps.playlist_id = ?
             ORDER BY ps.position ASC`,
            [playlistId]
        );
    },

    getPlaylistSongCount: async (playlistId) => {
        const row = await getQuery(musicDb, `SELECT COUNT(*) as count FROM playlist_songs WHERE playlist_id = ?`, [playlistId]);
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
        const baseBackupDir = path.join(__dirname, '../Database/Backups');
        if (!fs.existsSync(baseBackupDir)) fs.mkdirSync(baseBackupDir, { recursive: true });

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const currentBackupDir = path.join(baseBackupDir, `backup_${timestamp}`);

        if (!fs.existsSync(currentBackupDir)) fs.mkdirSync(currentBackupDir, { recursive: true });

        const dbs = [
            { name: 'users', db: usersDb },
            { name: 'music', db: musicDb },
            { name: 'social', db: socialDb },
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
            { name: 'Social', db: socialDb },
            { name: 'Lyrics', db: lyricsDb }
        ];

        for (const item of dbs) {
            try {
                // Perform a full checkpoint to merge WAL into the main DB file
                await runQuery(item.db, 'PRAGMA wal_checkpoint(FULL)');
                
                // Close the connection
                await new Promise((resolve, reject) => {
                    item.db.close((err) => {
                        if (err) reject(err);
                        else resolve();
                    });
                });
                console.log(`[DB] ${item.name} database closed safely.`);
            } catch (err) {
                console.error(`[DB] Error closing ${item.name} database:`, err);
            }
        }
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

    updateSystemConfig: async (key, value) => {
        return await runQuery(
            usersDb,
            `INSERT INTO system_config (key, value) VALUES (?, ?) 
             ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
            [key, value]
        );
    },

    allQuery: async (dbName, query, params = []) => {
        const db = dbName === 'users' ? usersDb : (dbName === 'music' ? musicDb : socialDb);
        return await allQuery(db, query, params);
    }
};


module.exports = HandleDatabase;

