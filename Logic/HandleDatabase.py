import sqlite3
from datetime import datetime

class HandleDatabase:
    def __init__(self, databaseName="Database/Dev/Users/users.db"):
        self.databaseName = databaseName
        self.connection = sqlite3.connect(databaseName)
        self.musicConnection = sqlite3.connect("Database/Dev/Music/music.db")

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
                created_at TEXT NOT NULL
            )
        """)

    def insertUser(self, username, password, email):
        with self.connection:
            self.connection.execute("""
            INSERT INTO users (username, password, email, created_at)
            VALUES (?, ?, ?, ?)
                                    """, (username, password, email, datetime.now()))

    def getUser(self, username):
        with self.connection:
            return self.connection.execute("""
            SELECT * FROM users WHERE username = ?
            """, (username,)).fetchone()

    def getAllUsers(self):
        with self.connection:
            return self.connection.execute("SELECT id, username FROM users").fetchall()
        

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
                uploaded_by TEXT DEFAULT 'Unknown User'
            );
        """)
            

    def insertSong(self, songname, artist, album, genre, duration, filepath, uploaded_by="Unknown User"):
        with self.musicConnection:
            self.musicConnection.execute("""
            INSERT OR IGNORE INTO songs (songname, artist, album, genre, duration, filepath, created_at, uploaded_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """, (songname, artist, album, genre, duration, filepath, datetime.now(), uploaded_by))

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

    def deleteSong(self, song_id):
        with self.musicConnection:
            self.musicConnection.execute("DELETE FROM songs WHERE id = ?", (song_id,))


    def close(self):
        self.connection.close()
        self.musicConnection.close()

    def checkDatabase(self):
        pass