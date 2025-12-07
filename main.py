import http.server
import socketserver
import ssl, json, os
import mimetypes
import http.cookies
import logging
import urllib.parse
import urllib.request
from email.parser import BytesParser
from email.policy import default
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

# Project Imports
from Security import HandleSafeLogin
from Security.SessionManager import session_manager
from Security.RateLimiter import login_limiter
from Logic import HandleDatabase, Media
from save_song import save_song

# Logging Setup
logging.basicConfig(level=logging.DEBUG, format="%(asctime)s - %(levelname)s - %(message)s")

class HTTPSServer(http.server.SimpleHTTPRequestHandler):
    def get_database(self):
        return HandleDatabase.HandleDatabase()

    @staticmethod
    def format_duration(duration):
        return Media.format_duration(duration)

    def get_current_user(self):
        """Helper to get username from session cookie using SessionManager."""
        if "Cookie" in self.headers:
            try:
                cookie = http.cookies.SimpleCookie(self.headers["Cookie"])
                if "session_id" in cookie:
                    session_id = cookie["session_id"].value
                    return session_manager.get_user(session_id)
            except Exception:
                pass
        return None

    def send_json(self, data, status=200):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())

    def send_error_msg(self, msg, status=400):
        self.send_response(status)
        self.send_header("Content-Type", "text/plain")
        self.end_headers()
        self.wfile.write(msg.encode())

    def verify_turnstile(self, token):
        secret = os.getenv("TURNSTILE_SECRET_KEY")
        if not secret:
            logging.error("Turnstile Secret Key not found in environment variables.")
            return False

        url = "https://challenges.cloudflare.com/turnstile/v0/siteverify"
        data = urllib.parse.urlencode({
            'secret': secret,
            'response': token,
            'remoteip': self.client_address[0]
        }).encode('utf-8')
        
        try:
            req = urllib.request.Request(url, data=data)
            with urllib.request.urlopen(req) as response:
                result = json.loads(response.read().decode('utf-8'))
                return result.get('success', False)
        except Exception as e:
            logging.error(f"Turnstile verification error: {e}")
            return False

    def do_GET(self):
        

        self.path = os.path.normpath(self.path).replace('\\', '/')
        
        # ---------------------------------------------------------
        # Authorization Check
        # ---------------------------------------------------------
        public_prefixes = [
            "/login", 
            "/Static/loginpage", 
            "/register", 
            "/favicon.ico"
        ]
        
        # Allow checking public prefixes
        is_public = any(self.path.startswith(prefix) for prefix in public_prefixes)
        
        if self.path.startswith("/Static/"):
            if self.path.startswith("/Static/loginpage") or self.path.startswith("/Static/avatars"):
                is_public = True
            elif self.path.startswith("/Static/covers"):
                # Covers should generally be public or at least low-risk
                is_public = True
            else:
                # Requires Login
                is_public = False
        
        current_user = self.get_current_user()
        
        if not is_public and not current_user:
            if self.path.startswith("/api/"):
                self.send_error_msg("Unauthorized", 401)
                return
            else:
                self.send_response(302)
                self.send_header("Location", "/login")
                self.end_headers()
                return

        # ---------------------------------------------------------
        #  Request Routing
        # ---------------------------------------------------------

        # --- Base Navigation ---
        if self.path == "/" or self.path == "/home":
            self.path = "/Static/home/home.html"
            return super().do_GET()

        elif self.path.startswith("/login"):
            ip = self.client_address[0]
            
            if login_limiter.is_blocked(ip):

                if "blocked=true" not in self.path:
                    self.send_response(302)
                    self.send_header("Location", "/login?blocked=true")
                    self.end_headers()
                    return
                self.path = "/Static/loginpage/login.html"
            else:
                # Add failed and count parameters if they don't exist
                attempts = login_limiter.get_attempts(ip)
                if '?' not in self.path:
                    self.path = f"/Static/loginpage/login.html?failed=false&count={attempts}"
                else:
                    path, query = self.path.split('?', 1)
                    if "failed" not in query:
                        query += f"&failed=false&count={attempts}"
                    self.path = f"/Static/loginpage/login.html?{query}"
            
            # Inject Site Key into Login Page
            try:
                # Extract the actual file path from the URL path (ignoring query params)
                file_path = self.path.split('?')[0].lstrip('/')
                # Fix path separators for Windows
                file_path = file_path.replace('/', os.sep)
                
                if os.path.exists(file_path):
                    with open(file_path, 'r', encoding='utf-8') as f:
                        content = f.read()
                    
                    site_key = os.getenv("TURNSTILE_SITE_KEY", "")
                    content = content.replace("{{TURNSTILE_SITE_KEY}}", site_key)
                    
                    self.send_response(200)
                    self.send_header("Content-Type", "text/html")
                    self.end_headers()
                    self.wfile.write(content.encode('utf-8'))
                    return
            except Exception as e:
                logging.error(f"Error serving login page with injection: {e}")
                # Fallback to default serving if injection fails
                return super().do_GET()
            
            return super().do_GET()

        # --- Static Files ---
        elif self.path.startswith("/Static/"):
            return super().do_GET()

        # --- Database File Pushing ---
        elif self.path.startswith("/Database"):
            if not current_user: # Double check (though caught above)
                self.send_response(403); self.end_headers(); return

            BASE_DB_DIR = os.path.abspath("Database")
            requested = urllib.parse.unquote(self.path.lstrip('/'))
            requested = requested.replace('/', os.sep)
            
            candidate = os.path.abspath(os.path.join(os.getcwd(), requested))

            try:
                if os.path.commonpath([BASE_DB_DIR, candidate]) != BASE_DB_DIR:
                    logging.warning(f"Attempted unauthorized database access: {candidate}")
                    self.send_error_msg("Forbidden", 403)
                    return
            except ValueError:
                 self.send_error_msg("Forbidden", 403)
                 return

            file_path = candidate
            if not os.path.isfile(file_path):
                self.send_error_msg("File not found.", 404)
                return
            
            self.serve_file_range(file_path)

        # --- API: Current User ---
        elif self.path == "/api/me":
            avatar_url = Media.resolve_cover(current_user) 
            avatar_url = None
            for ext in ('.jpg', '.jpeg', '.png', '.webp', '.gif'):
                cand = f"Static/avatars/{current_user}{ext}"
                if os.path.exists(cand):
                    avatar_url = "/" + cand
                    break
            
            response_data = {
                "username": current_user,
                "avatar": avatar_url
            }
            self.send_json(response_data)

        # --- API: Users List ---
        elif self.path == "/api/users":
            with HandleDatabase.HandleDatabase() as db:
                users = db.getAllUsers()
                user_list = []
                for u in users:
                    # u: (id, username)
                    uname = u[1]
                    avatar_url = None
                    for ext in ('.jpg', '.jpeg', '.png', '.webp', '.gif'):
                        cand = f"Static/avatars/{uname}{ext}"
                        if os.path.exists(cand):
                            avatar_url = "/" + cand
                            break

                    user_list.append({
                        "id": u[0], 
                        "username": uname, 
                        "avatar": avatar_url
                    })
                self.send_json(user_list)

        # --- API: Search ---
        elif self.path.startswith("/api/search"):
            query_str = ""
            if '?' in self.path:
                try:
                    qs = urllib.parse.parse_qs(self.path.split('?')[1])
                    query_str = qs.get('q', [''])[0].lower()
                except: pass
            
            if not query_str:
                self.send_json({"users": [], "songs": []})
                return

            with HandleDatabase.HandleDatabase() as db:
                # Note: This could be optimized at DB level
                all_users = db.getAllUsers()
                matching_users = []
                for u in all_users:
                    if query_str in u[1].lower():
                        uname = u[1]
                        avatar_url = None
                        for ext in ('.jpg', '.jpeg', '.png', '.webp', '.gif'):
                            cand = f"Static/avatars/{uname}{ext}"
                            if os.path.exists(cand):
                                avatar_url = "/" + cand
                                break
                        matching_users.append({"id": u[0], "username": uname, "avatar": avatar_url})

                # 2. Songs
                all_songs = db.getAllSongs()
                matching_songs = []
                for song in all_songs:
                    if len(song) >= 9:
                        song_id, name, artist, album, genre, duration, file_path, timestamp, uploaded_by = song[:9]
                    else:
                        song_id, name, artist, album, genre, duration, file_path, timestamp = song[:8]
                        uploaded_by = "Unknown"

                    if (query_str in name.lower()) or (query_str in artist.lower()) or (query_str in album.lower()):
                        base_name = os.path.basename(file_path).rsplit('.', 1)[0]
                        cover_url = Media.resolve_cover(base_name)
                        
                        matching_songs.append({
                            "id": song_id,
                            "name": name,
                            "artist": artist,
                            "album": album,
                            "duration": Media.format_duration(duration),
                            "cover": cover_url,
                            "uploaded_by": uploaded_by
                        })
                
                self.send_json({"users": matching_users, "songs": matching_songs})

        # --- API: Library ---
        elif self.path == "/api/library":
            with HandleDatabase.HandleDatabase() as db:
                allSongs = db.getAllSongs()
                library_list = []
                for song in allSongs:
                    if len(song) >= 9:
                        song_id, name, artist, album, genre, duration, file_path, timestamp, uploaded_by = song[:9]
                    else:
                        song_id, name, artist, album, genre, duration, file_path, timestamp = song[:8]
                        uploaded_by = "Unknown"

                    if uploaded_by == current_user:
                        base_name = os.path.basename(file_path).rsplit('.', 1)[0]
                        library_list.append({
                            "id": song_id,
                            "name": name,
                            "artist": artist,
                            "album": album,
                            "duration": Media.format_duration(duration),
                            "cover": Media.resolve_cover(base_name),
                            "uploaded_by": uploaded_by
                        })
                self.send_json(library_list)

        # --- API: Trending ---
        elif self.path == "/api/trending":
            with HandleDatabase.HandleDatabase() as db:
                allSongs = db.getAllSongs()
                trending_list = []
                for song in allSongs:
                    if len(song) >= 9:
                        song_id, name, artist, album, genre, duration, file_path, timestamp, uploaded_by = song[:9]
                    else:
                        song_id, name, artist, album, genre, duration, file_path, timestamp = song[:8]
                        uploaded_by = "Unknown"
                    
                    base_name = os.path.basename(file_path).rsplit('.', 1)[0]
                    trending_list.append({
                        "id": song_id,
                        "name": name,
                        "artist": artist,
                        "album": album,
                        "duration": Media.format_duration(duration),
                        "cover": Media.resolve_cover(base_name),
                        "uploaded_by": uploaded_by
                    })
                self.send_json(trending_list)

        # --- Logout ---
        elif self.path == "/logout":
            if "Cookie" in self.headers:
                try:
                    cookie = http.cookies.SimpleCookie(self.headers["Cookie"])
                    if "session_id" in cookie:
                        session_manager.remove_session(cookie["session_id"].value)
                except: pass
            
            self.send_response(302)
            # Clearingg
            cookie = http.cookies.SimpleCookie()
            cookie["session_id"] = ""
            cookie["session_id"]["path"] = "/"
            cookie["session_id"]["expires"] = "Thu, 01 Jan 1970 00:00:00 GMT"
            for morsel in cookie.values():
                self.send_header("Set-Cookie", morsel.OutputString())
            self.send_header("Location", "/login")
            self.end_headers()

        # --- API: Play ---
        elif self.path.startswith("/api/play"):
            try:
                song_name = urllib.parse.unquote(self.path.split("/api/play/")[1])
            except IndexError:
                self.send_error_msg("Invalid request", 400)
                return

            with HandleDatabase.HandleDatabase() as db:
                song_data = db.getSong(song_name)
                
                if song_data:
                    if len(song_data) >= 9:
                        song_id, name, artist, album, genre, duration, file_path, timestamp, uploaded_by = song_data[:9]
                    else:
                        song_id, name, artist, album, genre, duration, file_path, timestamp = song_data[:8]
                        uploaded_by = "Unknown"

                    # Security Check: file_path should be in Database/Dev/Music
                    abs_path = os.path.abspath(file_path)
                    allowed_base = os.path.abspath("Database")
                    try:
                        if os.path.commonpath([allowed_base, abs_path]) != allowed_base:
                            print(f"[SECURITY] Blocked playback of song outside DB: {abs_path}")
                            self.send_error_msg("Access Denied", 403)
                            return
                    except ValueError:
                         self.send_error_msg("Access Denied", 403)
                         return

                    # Normalize for URL
                    normalized_path = file_path.replace("\\", "/")
                    if not normalized_path.startswith('/'):
                        normalized_path = '/' + normalized_path
                    
                    base_name = os.path.basename(file_path).rsplit('.', 1)[0]
                    song = {
                        "id": song_id,
                        "name": name,
                        "artist": artist,
                        "album": album,
                        "genre": genre,
                        "duration": Media.format_duration(duration),
                        "url": normalized_path, 
                        "cover": Media.resolve_cover(base_name)
                    }
                    self.send_json(song)
                else:
                    self.send_error_msg("Song not found.", 404)

        # --- PWA Files ---
        elif self.path == "/manifest.json":
            self.serve_file_range("Static/pwa/manifest.json")
        
        elif self.path == "/sw.js":
            self.send_response(200)
            self.send_header("Content-Type", "application/javascript")
            self.end_headers()
            with open("Static/pwa/sw.js", 'rb') as f:
                self.wfile.write(f.read())

        
        else:
            # 404
            if self.path.startswith("/api"):
                 self.send_error_msg("Not Found", 404)
            else:
                self.send_response(404)
                self.send_header("Content-Type", "text/html")
                self.end_headers()
                self.wfile.write(b"<h1>404 Not Found</h1>")

    def serve_file_range(self, file_path):
        file_size = os.path.getsize(file_path)
        content_type = mimetypes.guess_type(file_path)[0] or "application/octet-stream"
        range_header = self.headers.get('Range')

        if range_header:
            try:
                units, val = range_header.split('=', 1)
                if units.strip() != 'bytes': raise ValueError()
                
                start, end = 0, file_size - 1
                if val.startswith('-'):
                    suffix = int(val[1:])
                    start = max(0, file_size - suffix)
                else:
                    parts = val.split('-')
                    start = int(parts[0]) if parts[0] else 0
                    end = int(parts[1]) if len(parts) > 1 and parts[1] else file_size - 1
                
                if start > end or start < 0: raise ValueError()
                end = min(end, file_size - 1)
                
                chunk_size = end - start + 1
                self.send_response(206)
                self.send_header('Content-Type', content_type)
                self.send_header('Accept-Ranges', 'bytes')
                self.send_header('Content-Range', f'bytes {start}-{end}/{file_size}')
                self.send_header('Content-Length', str(chunk_size))
                self.end_headers()

                with open(file_path, 'rb') as f:
                    f.seek(start)
                    self.wfile.write(f.read(chunk_size))
            except Exception:
                self.send_response(416)
                self.send_header('Content-Range', f'bytes */{file_size}')
                self.end_headers()
        else:
            self.send_response(200)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(file_size))
            self.end_headers()
            with open(file_path, 'rb') as f:
                self.wfile.write(f.read())

    def list_directory(self, path):
         self.send_error_msg("Access to directory listing is not allowed.", 403)

    def do_POST(self):
            try:
                content_length = int(self.headers['Content-Length'])
                post_data = self.rfile.read(content_length)
            except:
                self.send_error_msg("Invalid Content-Length", 400)
                return

            path_clean = self.path.split('?')[0].rstrip('/')

            if path_clean == "/loginrequest":
                self.handle_login(post_data)
            
            elif path_clean == "/upload-song":
                self.handle_upload_song(post_data)
                
            elif path_clean == "/register":
                self.handle_register(post_data)

            elif path_clean == "/api/upload-avatar":
                self.handle_upload_avatar(post_data)

            else:
                self.send_error_msg("Not Found", 404)

    def handle_login(self, post_data):
        db = HandleDatabase.HandleDatabase()
        ip = self.client_address[0]
        
        try:
            if login_limiter.is_blocked(ip):
                 self.send_response(302)
                 self.send_header("Location", "/login?blocked=true")
                 self.end_headers()
                 return
            
            # Parse data first to get token
            try:
                query = urllib.parse.parse_qs(post_data.decode('utf-8'))
            except:
                query = {}

            # Verify Turnstile
            token = query.get('cf-turnstile-response', [None])[0]
            if not token or not self.verify_turnstile(token):
                print(f"[SECURITY] Failed Turnstile check for IP {ip}")
                self.send_response(302)
                self.send_header("Location", "/login?failed=true&reason=captcha")
                self.end_headers()
                return

            # Authenticate
            if HandleSafeLogin.checkUser(post_data, db):
                # Extract username for session
                username = query.get('username', ['User'])[0]

                # Create Session
                session_id = session_manager.create_session(username)
                
                # Success Logic
                login_limiter.reset(ip)
                
                self.send_response(302)
                cookie = http.cookies.SimpleCookie()
                cookie["session_id"] = session_id
                cookie["session_id"]["path"] = "/"
                cookie["session_id"]["httponly"] = True
                
                for morsel in cookie.values():
                    self.send_header("Set-Cookie", morsel.OutputString())
                
                self.send_header("Location", "/home")
                self.end_headers()

            else:
                # Failed Login
                is_blocked = login_limiter.add_attempt(ip)
                cnt = login_limiter.get_attempts(ip)
                
                redirect = "/login?blocked=true" if is_blocked else f"/login?failed=true&count={cnt}"
                self.send_response(302)
                self.send_header("Location", redirect)
                self.end_headers()

        finally:
            db.close()

    def handle_upload_song(self, post_data):
        content_type = self.headers.get('Content-Type')
        if not content_type or not content_type.startswith('multipart/form-data'):
            self.send_error_msg("Invalid form submission.")
            return

        msg = BytesParser(policy=default).parsebytes(
            b"Content-Type: " + content_type.encode() + b"\r\n\r\n" + post_data
        )

        uploaded_file = None
        file_name = None

        for part in msg.iter_parts():
            disposition = part.get("Content-Disposition", "")
            if "form-data" in disposition and 'name="song_file"' in disposition:
                uploaded_file = part.get_payload(decode=True)
                file_name = part.get_filename()

        if not uploaded_file or not file_name:
            self.send_error_msg("No valid file uploaded.")
            return

        mp3_full_path = f"MusicLibrary/{file_name}"
        if os.path.exists(mp3_full_path):
             self.send_error_msg("Song already exists.")
             return

        with open(mp3_full_path, "wb") as f:
            f.write(uploaded_file)
        
        if not os.path.exists("Static/covers"):
            try: os.makedirs("Static/covers")
            except: pass

        current_username = self.get_current_user() or "Unknown User"

        saved_song_path = save_song(mp3_full_path, uploaded_by=current_username)
        
        try:
            if os.path.exists(mp3_full_path): os.remove(mp3_full_path)
        except: pass

        if not saved_song_path:
             self.send_error_msg("Failed to process uploaded audio file.")
             return

        # Extract Art
        try:
            final_base = os.path.basename(saved_song_path).rsplit('.', 1)[0]
            cover_output_base = f"Static/covers/{final_base}"
            Media.extract_cover_art(saved_song_path, cover_output_base)
        except Exception as e:
            print(f"Error extracting cover: {e}")

        self.send_response(302)
        self.send_header("Location", "/home")
        self.end_headers()

    def handle_register(self, post_data):
        try:
            query = urllib.parse.parse_qs(post_data.decode('utf-8'))
            username = query.get('username', [None])[0]
            email = query.get('email', [None])[0]
            password = query.get('password', [None])[0]
            confirm_password = query.get('confirm_password', [None])[0]
            token = query.get('cf-turnstile-response', [None])[0]
        except Exception:
            self.send_error_msg("Bad Request")
            return

        if not token or not self.verify_turnstile(token):
             self.redirect("/login?reg_failed=true&reason=captcha")
             return

        if not username or not email or not password:
            self.redirect("/login?reg_failed=true")
            return

        if password != confirm_password:
             self.redirect("/login?reg_failed=true")
             return

        with HandleDatabase.HandleDatabase() as db:
            if db.getUser(username):
                 self.redirect("/login?reg_failed=true")
                 return

            db.insertUser(username, password, email)
            print(f"[REGISTER] New user registered: {username}")
            self.redirect("/login?registered=true")

    def handle_upload_avatar(self, post_data):
        current_user = self.get_current_user()
        if not current_user:
            self.send_error_msg("Unauthorized", 401)
            return

        content_type = self.headers.get('Content-Type')
        if not content_type or not content_type.startswith('multipart/form-data'):
             self.send_error_msg("Invalid form.")
             return

        msg = BytesParser(policy=default).parsebytes(
            b"Content-Type: " + content_type.encode() + b"\r\n\r\n" + post_data
        )
        
        uploaded_file = None
        file_ext = ".jpg"

        for part in msg.iter_parts():
            disposition = part.get("Content-Disposition", "")
            if "form-data" in disposition and 'name="avatar_file"' in disposition:
                uploaded_file = part.get_payload(decode=True)
                fname = part.get_filename()
                if fname:
                    _, ext = os.path.splitext(fname)
                    if ext: file_ext = ext.lower()

        if not uploaded_file:
             self.send_error_msg("No file.")
             return

        if not os.path.exists("Static/avatars"):
            try: os.makedirs("Static/avatars")
            except: pass
        
        for ext in ('.jpg', '.jpeg', '.png', '.webp', '.gif'):
            try:
                p = f"Static/avatars/{current_user}{ext}"
                if os.path.exists(p): os.remove(p)
            except: pass

        save_path = f"Static/avatars/{current_user}{file_ext}"
        try:
            with open(save_path, "wb") as f:
                f.write(uploaded_file)
            self.redirect("/home")
        except Exception as e:
            print(f"Error saving avatar: {e}")
            self.send_error_msg("Internal Server Error", 500)

    def redirect(self, location):
        self.send_response(302)
        self.send_header("Location", location)
        self.end_headers()

host = "0.0.0.0"
port = 4443

class ThreadingHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True

if __name__ == "__main__":
    db = HandleDatabase.HandleDatabase()
    db.createUsersTable()
    db.createSongsTable()
    db.close()

    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(certfile="SSL/cert.pem", keyfile="SSL/key.pem")

    server_address = ('0.0.0.0', 4443)
    httpd = ThreadingHTTPServer(server_address, HTTPSServer)
    httpd.socket = context.wrap_socket(httpd.socket, server_side=True)

    print("Listening on https://0.0.0.0:4443")
    httpd.serve_forever()