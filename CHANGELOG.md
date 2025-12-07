# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

## Future Roadmap

### Planned Features
- [ ] Multi-factor authentication (2FA)
- [ ] Music playlists
- [ ] Social features (follow, share, chatting)
- [ ] Personal Music recommendations
- [ ] User statistics and analytics
- [ ] Custom themes
- [ ] Equalizer

### Performance Improvements
- [ ] Database query optimization
- [ ] Optimizing server for weak CPUs
- [ ] Cachinging

### Security Enhancements
- [ ] Enchanced logging