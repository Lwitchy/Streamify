import sqlite3
import os

db_path = "Database/Dev/Users/users.db"
print(f"Checking DB at: {os.path.abspath(db_path)}")

if not os.path.exists(db_path):
    print("file does not exist")
else:
    print("File exists.")
    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.cursor()
        cursor.execute("SELECT name FROM sqlite_master WHERE type='table';")
        tables = cursor.fetchall()
        print(f"Tables: {tables}")
        
        if ('users',) in tables:
            cursor.execute("SELECT * FROM users")
            users = cursor.fetchall()
            print(f"Users: {users}")
        else:
            print("Users table missing!")
        conn.close()
    except Exception as e:
        print(f"Error: {e}")
