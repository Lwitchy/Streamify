import sqlite3
from datetime import datetime

class HandleDatabase:
    def __init__(self, databaseName="Database/Dev/Users/users.db"):
        self.databaseName = databaseName
        self.connection = sqlite3.connect(databaseName, timeout=10)
        self.musicConnection = sqlite3.connect("Database/Dev/Music/music.db", timeout=10)

        self.connection.execute("PRAGMA journal_mode=WAL;")
        self.musicConnection.execute("PRAGMA journal_mode=WAL;")

        self.connection.execute("PRAGMA synchronous=NORMAL;")
        self.musicConnection.execute("PRAGMA synchronous=NORMAL;")


    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        self.close()

    def createUsersTable(self):
        print("[DB] Talking: Creating users table is done!")
        with self.connection:
            self.connection.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL,
                password TEXT NOT NULL,
                email TEXT NOT NULL,
                created_at TEXT NOT NULL,
                playlists TEXT,
                favorites TEXT,
                settings TEXT,
                last_login TEXT,
                notifications TEXT,
                uploaded_songs_count INTEGER DEFAULT 0,
                is_admin INTEGER DEFAULT 0,
                total_likes INTEGER DEFAULT 0
            )
        """)

    def insertUser(self, username, password, email):
        with self.connection:
            self.connection.execute("""
            INSERT INTO users (username, password, email, created_at, playlists, favorites, settings, last_login, notifications, uploaded_songs_count, is_admin, total_likes)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                                    """, (username, password, email, datetime.now(), None, None, None, None, None, 0, 0, 0))

    def getUser(self, username):
        with self.connection:
            return self.connection.execute("""
            SELECT * FROM users WHERE username = ?
            """, (username,)).fetchone()

    def getAllUsers(self):
        with self.connection:
            return self.connection.execute("SELECT id, username, uploaded_songs_count, total_likes FROM users").fetchall()
        

    def createSongsTable(self):
        print("[DB] Talking: Creating songs table is done!")
        with self.musicConnection:
            self.musicConnection.execute("""
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
                cover_path TEXT
            );
        """)
            

    def insertSong(self, songname, artist, album, genre, duration, filepath, uploaded_by="Unknown User", visibility="private"):
        with self.musicConnection:
            self.musicConnection.execute("""
            INSERT OR IGNORE INTO songs (songname, artist, album, genre, duration, filepath, created_at, uploaded_by, is_private, is_favorite, play_count, cover_path)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (songname, artist, album, genre, duration, filepath, datetime.now(), uploaded_by, visibility if visibility else "private", 0, 0, None))

    def getSong(self, songname):
        with self.musicConnection:
            return self.musicConnection.execute("""
            SELECT * FROM songs WHERE songname = ?
            """, (songname,)).fetchone()
    
    def getAllSongs(self):
        with self.musicConnection:
            return self.musicConnection.execute("SELECT * FROM songs").fetchall()

    def updateSong(self, song_id, songname=None, artist=None, album=None, genre=None, duration=None, filepath=None):
        with self.musicConnection:
            query = "UPDATE songs SET "
            params = []
            if songname:
                query += "songname = ?, "
                params.append(songname)
            if artist:
                query += "artist = ?, "
                params.append(artist)
            if album:
                query += "album = ?, "
                params.append(album)
            if genre:
                query += "genre = ?, "
                params.append(genre)
            if duration:
                query += "duration = ?, "
                params.append(duration)
            if filepath:
                query += "filepath = ?, "
                params.append(filepath)
            query = query.rstrip(", ") + " WHERE id = ?"
            params.append(song_id)
            self.musicConnection.execute(query, params)


    def updateUser(self, username, param, new_value):
        with self.connection:
            query = f"UPDATE users SET {param} = ? WHERE username = ?"
            self.connection.execute(query, (new_value, username))
            print(f"[DB] Updated user {username}: set {param} to {new_value}")


    def deleteSong(self, song_id, uploaded_by=None):
        with self.musicConnection:
            self.musicConnection.execute("DELETE FROM songs WHERE id = ? AND uploaded_by = ?", (song_id, uploaded_by))


    def close(self):
        self.connection.close()
        self.musicConnection.close()

    def checkDatabase(self):
        pass