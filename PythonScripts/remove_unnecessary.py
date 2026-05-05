import sqlite3
import os

DB_PATH = "Database/Dev/Music/music.db"
MUSIC_DIR = "MusicLibrary/"
AUDIO_EXTENSIONS = ('.mp3', '.wav', '.flac', '.ogg', '.m4a', '.opus', '.webm')


def cleanup():
    print("--- STARTING CLEANUP ---")
    
    # Connect to Database
    if not os.path.exists(DB_PATH):
        print(f"Error: Database not found at {DB_PATH}")
        return

    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()

    print("\n[1/3] Checking for broken database entries...")
    
    try:
        cursor.execute("SELECT id, songname, filepath FROM songs")
        all_songs = cursor.fetchall()
    except sqlite3.OperationalError:
        print("Error: Could not read songs table. Make sure the server is running or DB exists.")
        return

    db_ids_to_delete = []
    valid_file_paths = set() 

    for song_id, name, path in all_songs:
        normalized_path = os.path.normpath(path)
        
        if not os.path.exists(normalized_path):
            print(f"  [MISSING] ID: {song_id} | Song: {name} | Path: {path}")
            db_ids_to_delete.append(song_id)
        else:
            valid_file_paths.add(os.path.abspath(normalized_path))

    if not db_ids_to_delete:
        print("  > Database is healthy.")

    print("\n[2/3] Scanning for junk files (orphans)...")
    
    files_to_delete = []

    for root, dirs, files in os.walk(MUSIC_DIR):
        for file in files:

            if file.lower().endswith(AUDIO_EXTENSIONS):
                full_path = os.path.join(root, file)
                abs_path = os.path.abspath(full_path)

                if abs_path not in valid_file_paths:
                    print(f"  [ORPHAN] {full_path}")
                    files_to_delete.append(full_path)

    if not files_to_delete:
        print("  > File system is clean.")

    total_issues = len(db_ids_to_delete) + len(files_to_delete)
    
    if total_issues == 0:
        print("\n--- NO ISSUES FOUND. YOUR LIBRARY IS PERFECT! ---")
        conn.close()
        return

    print(f"\n--- SUMMARY ---")
    print(f"Database entries to remove: {len(db_ids_to_delete)}")
    print(f"Junk files to delete:       {len(files_to_delete)}")
    print("---------------------------------------------------")
    
    confirm = input("Are you sure you want to apply these fixes? (type 'yes'): ")

    if confirm.lower() == 'yes':
        if db_ids_to_delete:
            print("\nCleaning Database...")
            for song_id in db_ids_to_delete:
                cursor.execute("DELETE FROM songs WHERE id = ?", (song_id,))
            conn.commit()
            print("  > Database entries removed.")

        if files_to_delete:
            print("\nDeleting Files...")
            for fpath in files_to_delete:
                try:
                    os.remove(fpath)
                    print(f"  > Deleted: {fpath}")
                except Exception as e:
                    print(f"  > Failed to delete {fpath}: {e}")
            

            print("  > Checking for empty folders...")
            for root, dirs, files in os.walk(MUSIC_DIR, topdown=False):
                for name in dirs:
                    try:
                        os.rmdir(os.path.join(root, name))
                    except:
                        pass
            
        print("\n--- CLEANUP COMPLETE ---")
    else:
        print("\nOperation cancelled. No changes made.")

    conn.close()

if __name__ == "__main__":
    cleanup()