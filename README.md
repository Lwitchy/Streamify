# Streamify

A modern, secure music streaming application built with Python. Streamify provides users with a self-hosted music streaming experience with features like user authentication, music library management, avatar uploads, and trending music discovery.

##  Features

- **User Authentication**: Secure login and registration with session management
- **Music Library**: Upload and organize your music collection
- **Search & Discovery**: Search for music and discover trending tracks
- **User Profiles**: Custom avatars and user information
- **Streaming**: HTTP Range request support for smooth music playback
- **PWA Support**: Progressive Web App manifest and service worker for offline access
- **HTTPS**: Secure SSL/TLS encrypted connections
- **Rate Limiting**: Protection against brute force login attacks
- **Responsive Design**: Mobile-friendly user interface

##  Requirements

- Python 3.8+
- SSL certificates (cert.pem and key.pem)

##  Installation

### 1. Clone the Repository
```bash
git clone https://github.com/yourusername/Streamify.git
cd Streamify
```

### 2. Set Up Python Environment
```bash
# Create virtual environment
python -m venv venv

# Activate virtual environment
# On Windows:
venv\Scripts\activate
# On macOS/Linux:
source venv/bin/activate
```

### 3. Install Dependencies
```bash
pip install -r requirements.txt
```

### 4. Generate SSL Certificates (Development)
```bash
# Create SSL directory if it doesn't exist
mkdir SSL

# Generate self-signed certificate (valid for 365 days)
openssl req -x509 -newkey rsa:4096 -nodes -out SSL/cert.pem -keyout SSL/key.pem -days 365
```

For production, use proper certificates from a Certificate Authority (Let's Encrypt, etc.).

### 5. Create Required Directories
```bash
mkdir Database/Dev/Music
mkdir Database/Users
mkdir MusicLibrary
mkdir Static/covers
mkdir Static/avatars
```

### 6. Run the Server
```bash
python main.py
```

The server will start on `https://0.0.0.0:4443`

Access the application at: `https://localhost:4443`

## Project Structure

```
Streamify/
├── main.py                 # Main HTTPS server
├── save_song.py           # Song processing and metadata extraction
├── adduser.py             # User management utility
├── debug_db.py            # Database debugging utilities
├── test_backend.py        # Backend tests
│
├── Security/              # Authentication & Security
│   ├── HandleSafeLogin.py    # Secure login logic
│   ├── SessionManager.py     # Session management
│   └── RateLimiter.py        # Rate limiting
│
├── Logic/                 # Business Logic
│   ├── HandleDatabase.py     # Database operations
│   ├── HandleUploadedMusic.py # Music file processing
│   ├── Media.py              # Media utilities
│   └── API_EndPoints.py      # API endpoint definitions
│
├── Static/                # Frontend Assets
│   ├── loginpage/         # Login interface
│   ├── home/              # Main application UI
│   ├── pwa/               # Progressive Web App files
│   ├── avatars/           # User avatars
│   └── covers/            # Album covers
│
├── Database/              # Database Files
│   ├── Dev/               # Development database
│   └── Users/             # User database
│
├── MusicLibrary/          # Uploaded music files
├── SSL/                   # SSL certificates
└── Firewall/              # Firewall rules (optional)
```

## 🔌 API Endpoints

### Authentication
- `GET /login` - Login page
- `POST /loginrequest` - Submit login credentials
- `GET /register` - Registration page
- `POST /register` - Submit registration
- `GET /logout` - Logout user

### User API
- `GET /api/me` - Get current user info
- `GET /api/users` - Get all users (limited info)

### Music API
- `GET /api/search?q=<query>` - Search for music
- `GET /api/library` - Get user's music library
- `GET /api/trending` - Get trending music
- `POST /upload-song` - Upload new song
- `GET /api/play?song=<filename>` - Stream music with range support

### User Profile
- `POST /api/upload-avatar` - Upload user avatar

### Web
- `GET /manifest.json` - PWA manifest
- `GET /sw.js` - Service worker


## ⚠️ Security Considerations
### Important Security Notes

This application includes several security features but is designed for self-hosted, trusted environments. Before deploying to production:

1. **SSL Certificates**: Use valid certificates from a trusted Certificate Authority
2. **Password Policy**: Implement strong password requirements
3. **Database Security**: Ensure database files are protected and backed up
4. **File Uploads**: Validate and scan uploaded files for malware
5. **CORS Configuration**: Restrict origins to trusted domains
6. **Rate Limiting**: Adjust rate limits based on your needs
7. **Logging & Monitoring**: Enable comprehensive logging for security events
8. **Regular Updates**: Keep Python and dependencies updated

See `SECURITY.md` for detailed security recommendations.

##  Testing

Run the test suite:
```bash
python -m pytest test_backend.py -v
```

Or test the backend directly:
```bash
python test_backend.py
```


##  Configuration

Edit these variables in `main.py`:
```python
host = "0.0.0.0"    # Bind address
port = 4443         # HTTPS port
```

##  Contributing

Contributions are welcome!

##  License

This project is licensed under the MIT License - see the LICENSE file for details.

##  Troubleshooting

### SSL Certificate Issues
If you get SSL errors, ensure `SSL/cert.pem` and `SSL/key.pem` exist:
```bash
ls SSL/
```

### Port Already in Use
If port 4443 is in use, change the `port` variable in `main.py`

### Database Errors
Reset the database by deleting `Database/Dev/` and `Database/Users/` folders

### Upload Issues
Ensure directories exist:
```bash
mkdir -p Database/Dev/Music MusicLibrary Static/covers Static/avatars
```

##  Contact

For questions or issues

You can open a Github issue

Telegram: @lwitchy

Discord: @lwitchy

##  Acknowledgments

- Built with Python's built-in HTTP server
- Uses MIME multipart parsing for file uploads
- PWA support for offline functionality
- Frontend made with the help of Gemini!
---

**Note**: This is a self-hosted music streaming application. Not Suggested For production use!!!
