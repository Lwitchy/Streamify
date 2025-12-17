# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] Polishing Update
### Added
- Profiles feature (You can get details of specific profile)
- Notifications feature (Not fully done yet)
- Fixed various bugs & Cleaned up codebase
- Compressions for Avatars & Songs
- Private/Public songs (User can save songs privately other people won't see it)
- Added caching system to Music Lists which fixes the bug where when you switch between (Home/Library), The songs on Library shows up on Home page for a second 
- Added caching system to Profile and People page, which reduces load on backend
- Added ratelimit for API calls, 60 API requests per Minute 


### Known Issues
- Even with caching, if caching timeout is ended and when you click Home/Library pages too fastly for a second songs get mixed up 


### Changed
- Completly rewrote the codes for uploading songs



## Removed
- PWA (for now because it was unstable)

## [0.1.0] Initial Release

### Added
- Initial project setup
- User authentication and registration
- User profile with avatar support
- Search Feature
- PWA support with offline capability
- Session management

### Known Issues
- No File Size, Extension Validation on Uploads


## How to Update

### From Command Line
```bash
git pull origin main
```

### Manual Update
1. Download the latest release
2. Backup your `Database/` directory
3. Replace the code files (keeping your Database folder intact)
4. Update Python dependencies: `pip install -r requirements.txt`
5. Restart the application

## Version History

| Version | Release Date | Status | Notes |
|---------|-------------|--------|-------|
| 0.1.0 | 2025-12-07 | Beta | Initial release |
| 0.1.1 | 2025-12-17 | Beta | Polishing update |

## Future Roadmap

### Planned Features
- [X] Multi-factor authentication (2FA)
- [ ] Music playlists
- [ ] Social features (follow, share, chatting)
- [ ] Personal Music recommendations
- [-] User statistics and analytics
- [ ] Custom themes
- [ ] Equalizer

### Performance Improvements
- [ ] Database query optimization
- [ ] Optimizing server for weak CPUs


### Security Enhancements
- [ ] Enchanced logging