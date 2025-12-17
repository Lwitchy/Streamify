import os
import subprocess
import json
from mutagen import File as MutagenFile
from Logic import HandleDatabase

def _get_tag(tags, keys):
    if not tags:
        return None
    for k in keys:
        if k in tags:
            val = tags.get(k)
            if isinstance(val, (list, tuple)):
                return str(val[0]) if val else None
            return str(val)
    return None

def get_duration_ffmpeg(file_path):
    """Fallback to get duration using ffprobe if mutagen fails"""
    try:
        cmd = [
            'ffprobe', 
            '-v', 'error', 
            '-show_entries', 'format=duration', 
            '-of', 'default=noprint_wrappers=1:nokey=1', 
            file_path
        ]
        result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        return round(float(result.stdout.strip()))
    except Exception:
        return 0

def save_song(file_path, base_directory="MusicLibrary/", uploaded_by="Unknown User", compress=True, visibility="private"):
    print(f"Processing file: {file_path}")
    
    # 1. READ METADATA
    try:
        audio = MutagenFile(file_path, easy=False)
        tags = audio.tags if audio else {}
        
        title = _get_tag(tags, ["TIT2", "TITLE"])
        artist = _get_tag(tags, ["TPE1", "ARTIST"])
        album = _get_tag(tags, ["TALB", "ALBUM"])
        genre = _get_tag(tags, ["TCON", "GENRE"])

        # Try getting duration from mutagen
        try:
            duration = round(audio.info.length)
        except:
            duration = 0

    except Exception:
        tags = {}
        title = artist = album = genre = None
        duration = 0

    # Fill defaults
    if not title:
        title = os.path.splitext(os.path.basename(file_path))[0]
    if not artist: artist = "Unknown Artist"
    if not album: album = "Unknown Album"
    if not genre: genre = "Unknown Genre"

    # If mutagen failed to get duration, try ffprobe
    if duration == 0:
        duration = get_duration_ffmpeg(file_path)

    # 2. PREPARE PATHS
    artist_dir = os.path.join(base_directory, sanitize_filename(artist))
    album_dir = os.path.join(artist_dir, sanitize_filename(album))
    os.makedirs(album_dir, exist_ok=True)

    safe_title = sanitize_filename(title)
    new_filename = f"{safe_title}.mp3"
    new_path = os.path.join(album_dir, new_filename)

    # Handle duplicates
    idx = 1
    while os.path.exists(new_path):
        new_path = os.path.join(album_dir, f"{safe_title}-{idx}.mp3")
        idx += 1

    # 3. COMPRESS WITH FFMPEG (Direct System Call)
    if(compress):
        print(f"Compressing to {new_path}...")
        
        # This command converts input to MP3 at 128k bitrate
        # -y overwrites output if exists (though we handled that above)
        # -map_metadata 0 copies ID3 tags from original
        ffmpeg_cmd = [
            'ffmpeg', '-y',
            '-i', file_path,
            '-b:a', '128k',
            '-map_metadata', '0',
            new_path
        ]

        try:
            # Run ffmpeg. Check=True raises an error if ffmpeg fails (e.g., not found)
            subprocess.run(ffmpeg_cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            
            # Delete the original heavy upload
            if os.path.exists(file_path):
                os.remove(file_path)

        except FileNotFoundError:
            print("ERROR: FFmpeg is not installed or not in your PATH.")
            print("Please ensure you downloaded the BINARIES (exe files) and added them to PATH.")
            return None
        except subprocess.CalledProcessError as e:
            print(f"FFmpeg conversion failed: {e}")
            return None
    else:
        print(f"Moving file to {new_path} without compression...")
        os.rename(file_path, new_path)

    # 4. UPDATE DATABASE
    try:
        with HandleDatabase.HandleDatabase() as database:
            print("Inserting song into database...")
            print(f"Title: {title}, Artist: {artist}, Album: {album}, Genre: {genre}, Duration: {duration}, Path: {new_path}, Uploaded by: {uploaded_by}, Visibility: {visibility}")
            
            # try updating User's uploaded songs count
            user = database.getUser(uploaded_by)
            if(user):
                user_uploaded_count = user[10] 
                new_count = user_uploaded_count + 1
                database.updateUser(uploaded_by, "uploaded_songs_count", new_count)
                
            database.insertSong(title, artist, album, genre, duration, new_path, uploaded_by, visibility)
    except Exception as e:
        print(f"Database error: {e}")
        return None

    print(f"Success! Saved to {new_path}")
    return new_path

def sanitize_filename(name: str) -> str:
    return "".join(c for c in name if c not in "\\/\0").strip() or "unknown"