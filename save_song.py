import os
from mutagen import File as MutagenFile
from Logic import HandleDatabase


def _get_tag(tags, keys):
    if not tags:
        return None
    for k in keys:
        if k in tags:
            val = tags.get(k)
            # mutagen often returns list-like values
            if isinstance(val, (list, tuple)):
                return str(val[0]) if val else None
            return str(val)
    return None


def save_song(file_path, base_directory="Database/Dev/Music", uploaded_by="Unknown User"):
    """Process an uploaded audio file and move it into the music library.

    Returns the new file path on success, or None on failure/unsupported file.
    """
    print(f"Processing file: {file_path}")
    try:
        audio = MutagenFile(file_path, easy=False)
        if audio is None:
            print("Unsupported or invalid audio file (mutagen could not detect type).")
            return None

        tags = audio.tags

        # Common tag keys for different formats
        title = _get_tag(tags, ["TIT2", "TITLE"])
        artist = _get_tag(tags, ["TPE1", "ARTIST"])
        album = _get_tag(tags, ["TALB", "ALBUM"])
        genre = _get_tag(tags, ["TCON", "GENRE"])

        if not title:
            title = os.path.splitext(os.path.basename(file_path))[0]
        if not artist:
            artist = "Unknown Artist"
        if not album:
            album = "Unknown Album"
        if not genre:
            genre = "Unknown Genre"

        # Duration in seconds (rounded)
        try:
            duration = round(audio.info.length)
        except Exception:
            duration = 0

        # Preserve original extension
        _, ext = os.path.splitext(file_path)
        ext = ext.lower() or ".mp3"

        # Create directory structure
        artist_dir = os.path.join(base_directory, sanitize_filename(artist))
        album_dir = os.path.join(artist_dir, sanitize_filename(album))
        os.makedirs(album_dir, exist_ok=True)

        # Define the new file path; avoid overwriting by appending index if needed
        safe_title = sanitize_filename(title)
        new_path = os.path.join(album_dir, f"{safe_title}{ext}")
        idx = 1
        while os.path.exists(new_path):
            new_path = os.path.join(album_dir, f"{safe_title}-{idx}{ext}")
            idx += 1

        # Initialize database handler and insert record
        with HandleDatabase.HandleDatabase() as database:
            database.insertSong(title, artist, album, genre, duration, new_path, uploaded_by)

        # Move the uploaded file to the final location
        os.rename(file_path, new_path)
        print(f"Saved to {new_path}")
        return new_path

    except Exception as e:
        print(f"Error saving song: {e}")
        return None


def sanitize_filename(name: str) -> str:
    # Simple sanitizer: remove path separators and trim
    return "".join(c for c in name if c not in "\\/\0").strip() or "unknown"
