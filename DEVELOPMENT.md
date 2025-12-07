# Development Guide

## Project Setup

### Prerequisites
- Python 3.8 or higher
- Git
- OpenSSL (for certificate generation)

### Initial Setup

```bash
# 1. Clone the repository
git clone https://github.com/yourusername/Streamify.git
cd Streamify

# 2. Create and activate virtual environment
python -m venv venv

# On Windows:
venv\Scripts\activate

# On macOS/Linux:
source venv/bin/activate

# 3. Install dependencies
pip install -r requirements.txt

# 4. Generate SSL certificates
mkdir -p SSL
openssl req -x509 -newkey rsa:4096 -nodes -out SSL/cert.pem -keyout SSL/key.pem -days 365

# 5. Create required directories
mkdir -p Database/Dev/Music Database/Users MusicLibrary Static/covers Static/avatars

# 6. Run the development server
python main.py
```

The server will start at `https://localhost:4443`

## Project Architecture

### Directory Structure

```
Streamify/
├── main.py                    # Entry point, main server
├── save_song.py              # Song metadata extraction
├── adduser.py                # User management CLI
├── debug_db.py               # Database debugging
├── test_backend.py           # Test suite
│
├── Security/                 # Authentication & security
│   ├── HandleSafeLogin.py       # Login logic
│   ├── SessionManager.py        # Session handling
│   └── RateLimiter.py           # Rate limiting
│
├── Logic/                    # Business logic
│   ├── HandleDatabase.py        # Database operations
│   ├── HandleUploadedMusic.py   # Music file handling
│   ├── Media.py                 # Media utilities
│   └── API_EndPoints.py         # API definitions
│
├── Database/                 # Data storage
│   ├── Dev/                     # Development database
│   └── Users/                   # User data
│
├── MusicLibrary/             # Uploaded music files
├── Static/                   # Frontend assets
│   ├── home/                    # Main interface
│   ├── loginpage/               # Auth interface
│   ├── pwa/                     # Progressive Web App
│   ├── avatars/                 # User profiles
│   └── covers/                  # Album artwork
│
└── SSL/                      # SSL certificates
```

## Core Components

### 1. HTTPSServer (main.py)
Main request handler class that extends `SimpleHTTPRequestHandler`.

**Key Methods:**
- `do_GET()` - Handle GET requests
- `do_POST()` - Handle POST requests
- `get_current_user()` - Extract authenticated user from session
- `send_json()` - Send JSON responses
- `send_error_msg()` - Send error responses

### 2. Security Module
Handles authentication and security concerns.

**Components:**
- `HandleSafeLogin.py` - Password hashing, user verification
- `SessionManager.py` - Session creation and validation
- `RateLimiter.py` - Brute force protection

### 3. Logic Module
Business logic and data operations.

**Components:**
- `HandleDatabase.py` - SQLite operations (users, songs)
- `HandleUploadedMusic.py` - File processing and metadata
- `Media.py` - Utility functions (duration formatting, etc.)
- `API_EndPoints.py` - API route definitions

## API Endpoints Reference

### Authentication
```
GET  /login              # Login form
POST /loginrequest       # Process login
GET  /register           # Registration form
POST /register           # Process registration
GET  /logout             # Logout user
```

### User API
```
GET  /api/me             # Current user info
GET  /api/users          # All users (public info)
POST /api/upload-avatar  # Upload user avatar
```

### Music API
```
GET  /api/search         # Search music (query param: q)
GET  /api/library        # User's music library
GET  /api/trending       # Trending music
GET  /api/play           # Stream music (query param: song)
POST /upload-song        # Upload music file
```

### Web
```
GET  /manifest.json      # PWA manifest
GET  /sw.js              # Service worker
GET  /Static/*           # Static files
```

## Database Schema

### Users Table
```sql
CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    avatar TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)
```

### Songs Table
```sql
CREATE TABLE songs (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    artist TEXT,
    album TEXT,
    username TEXT NOT NULL,
    file_path TEXT UNIQUE NOT NULL,
    duration INTEGER,
    cover_art TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(username) REFERENCES users(username)
)
```

## Development Workflow

### Running the Server

```bash
# Development mode
python main.py

# With specific port
# Edit main.py: port = 5443
python main.py

# Background execution (Linux/macOS)
nohup python main.py > streamify.log 2>&1 &
```

### Testing

```bash
# Run all tests
python test_backend.py

# Run with verbose output
python -m pytest test_backend.py -v

# Run specific test
python -m pytest test_backend.py::TestClassName::test_method_name
```

### Database Management

```bash
# Add user
python adduser.py username email password

# Debug database
python debug_db.py

# Reset database (WARNING: Deletes all data)
rm -rf Database/Dev Database/Users
python main.py  # Recreates empty databases
```

## Adding New Features

### 1. New API Endpoint

**Example: Add song rating**

1. Update database schema in `HandleDatabase.py`:
```python
def createRatingsTable(self):
    self.cursor.execute('''
        CREATE TABLE IF NOT EXISTS ratings (
            id INTEGER PRIMARY KEY,
            username TEXT NOT NULL,
            song_id INTEGER NOT NULL,
            rating INTEGER NOT NULL,
            FOREIGN KEY(username) REFERENCES users(username),
            FOREIGN KEY(song_id) REFERENCES songs(id)
        )
    ''')
```

2. Add endpoint in `main.py`:
```python
elif self.path.startswith("/api/rate"):
    self.handle_rate_song(post_data)

def handle_rate_song(self, post_data):
    current_user = self.get_current_user()
    if not current_user:
        self.send_error_msg("Not authenticated.", 401)
        return
    
    # Implementation...
    db = self.get_database()
    # Add rating logic...
```

3. Test with:
```bash
curl -X POST https://localhost:4443/api/rate \
  -H "Content-Type: application/json" \
  -d '{"song_id": 1, "rating": 5}' \
  -k  # Skip SSL verification for self-signed cert
```

### 2. New Frontend Component

1. Create HTML file in `Static/`
2. Add CSS styling in corresponding folder
3. Add JavaScript in `js/` subdirectory
4. Include in main layout
5. Link endpoints from `home-api.js`

## Debugging

### Enable Verbose Logging

In `main.py`:
```python
logging.basicConfig(
    level=logging.DEBUG,
    format="%(asctime)s - %(levelname)s - %(message)s"
)
```

### Debug Session Issues

```python
# In main.py do_GET():
current_user = self.get_current_user()
logging.debug(f"Authenticated user: {current_user}")
```

### Test Database Queries

```bash
python -c "
from Logic import HandleDatabase
db = HandleDatabase.HandleDatabase()
users = db.getAllUsers()
print(users)
db.close()
"
```

### Check SSL Certificates

```bash
# View certificate info
openssl x509 -in SSL/cert.pem -text -noout

# Verify certificate and key match
openssl x509 -noout -modulus -in SSL/cert.pem | openssl md5
openssl rsa -noout -modulus -in SSL/key.pem | openssl md5
```

## Performance Considerations

### Current Bottlenecks
1. **Database** - SQLite isn't ideal for production; consider PostgreSQL
2. **File Serving** - SimpleHTTPRequestHandler is slow; use nginx in production
3. **Memory** - Large file uploads; implement streaming
4. **Concurrency** - ThreadingHTTPServer has limits; use async framework (FastAPI)

### Optimizations

```python
# 1. Connection pooling for database
# 2. Caching frequently accessed data
# 3. Compress responses with gzip
# 4. Use CDN for static files
# 5. Implement pagination for large result sets
```

## Security Development Checklist

When developing new features:
- [ ] Validate all inputs
- [ ] Use parameterized queries for database
- [ ] Check authentication/authorization
- [ ] Sanitize file paths
- [ ] Validate file types and sizes
- [ ] Add rate limiting if needed
- [ ] Log security events
- [ ] Test with security tools
- [ ] Update SECURITY.md if needed
- [ ] Add unit tests for security

## Common Issues & Solutions

### SSL Certificate Error
```bash
# Regenerate certificates
rm SSL/cert.pem SSL/key.pem
openssl req -x509 -newkey rsa:4096 -nodes -out SSL/cert.pem -keyout SSL/key.pem -days 365
```

### Port Already in Use
```bash
# Find process using port 4443
lsof -i :4443  # macOS/Linux
netstat -ano | findstr :4443  # Windows

# Kill process or change port in main.py
```

### Database Lock Error
```bash
# SQLite database is locked, try:
# 1. Stop the server
# 2. Delete lock file if exists
# 3. Restart server
```

### Session Not Working
```bash
# Check cookies in browser DevTools
# Verify SessionManager is working:
python -c "from Security.SessionManager import session_manager; print(session_manager)"
```

## Resources

- [Python http.server docs](https://docs.python.org/3/library/http.server.html)
- [SQLite docs](https://www.sqlite.org/docs.html)
- [SSL/TLS guide](https://www.ssl.com/article/ssl-tls-https-process/)
- [OWASP Security Guidelines](https://owasp.org/)
- [Python Security Best Practices](https://python.readthedocs.io/en/latest/library/security_warnings.html)

## Contributing

See [CONTRIBUTING.md](.github/CONTRIBUTING.md) for contribution guidelines.

---

Questions? Create an issue or check existing discussions!
