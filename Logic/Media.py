import os
import base64
from mutagen import File
from mutagen.flac import Picture as FLACPicture
from functools import lru_cache

# Cache for cover art path resolution to avoid excessive IO
@lru_cache(maxsize=1024)
def resolve_cover(song_base_name):
    """
    Checks for existing cover art for a given song base name.
    Returns relative web path (e.g. '/Static/covers/song.jpg') or None.
    """
    # Common extensions to check
    # Note: We assume the server is running from the root where Static/ is located.
    base_path = "Static/covers/"
    if not os.path.exists(base_path):
        return None
        
    for ext in ('.jpg', '.jpeg', '.png', '.webp', '.gif'):
        filename = f"{song_base_name}{ext}"
        if os.path.exists(os.path.join(base_path, filename)):
            return f"/{base_path}{filename}"
    return None

def extract_cover_art(audio_path, output_base_path):
    """
    Extracts cover art from an audio file and saves it to output_base_path + extension.
    Returns the final file path on success, or False on failure.
    """
    try:
        audio = File(audio_path)
        if audio is None:
            return False

        art_data = None
        extension = ".jpg"  # Default fallback

        # 1. Native Mutagen Pictures (FLAC & Some Ogg/Opus)
        if hasattr(audio, 'pictures') and audio.pictures:
            pic = audio.pictures[0]
            art_data = pic.data
            if pic.mime == "image/png":
                extension = ".png"

        # 2. ID3 Tags (MP3)
        elif audio.tags:
            for key, value in audio.tags.items():
                if key.startswith("APIC"):
                    art_data = value.data
                    if value.mime == "image/png" or (art_data and art_data.startswith(b'\x89PNG')):
                        extension = ".png"
                    break

        # 3. Vorbis Comments (Ogg/Opus)
        if not art_data and audio.tags:
            for key in ['METADATA_BLOCK_PICTURE', 'COVERART']:
                if key in audio.tags:
                    try:
                        b64_data = audio.tags[key][0]
                        block_data = base64.b64decode(b64_data)
                        pic = FLACPicture(block_data)
                        art_data = pic.data
                        if pic.mime == "image/png":
                            extension = ".png"
                        break
                    except Exception as e:
                        # logging.warning(f"Error parsing Vorbis block: {e}")
                        continue

        if art_data:
            final_path = f"{output_base_path}{extension}"
            with open(final_path, 'wb') as img:
                img.write(art_data)
            return final_path

    except Exception as e:
        print(f"Error executing extract_cover_art: {e}")
    
    return False

def format_duration(duration):
    """Format the duration from seconds to mm:ss."""
    try:
        if not duration:
            return "0:00"
        seconds = float(duration)
        minutes = int(seconds // 60)
        seconds = int(seconds % 60)
        return f"{minutes}:{str(seconds).zfill(2)}"
    except Exception:
        return "0:00"
