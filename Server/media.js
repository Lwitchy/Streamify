const mm = require('music-metadata');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const { Jimp } = require('jimp');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const HandleDatabase = require('./database');

// Set ffmpeg path
ffmpeg.setFfmpegPath(ffmpegPath);

const Media = {
    // Media.resolve_cover
    resolveCover: (songBaseName) => {
        const baseDir = path.join(__dirname, '../Static/covers');
        if (!fs.existsSync(baseDir)) return null;

        const exts = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
        for (const ext of exts) {
            const filename = `${songBaseName}${ext}`;
            const fullPath = path.join(baseDir, filename);
            if (fs.existsSync(fullPath)) {
                try {
                    const stat = fs.statSync(fullPath);
                    return `/Static/covers/${filename}?v=${Math.floor(stat.mtimeMs)}`;
                } catch (e) {
                    return `/Static/covers/${filename}`;
                }
            }
        }
        return null;
    },

    resolveAvatar: (username) => {
        const baseDir = path.join(__dirname, '../Static/avatars');
        if (!fs.existsSync(baseDir)) return null;

        const exts = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
        for (const ext of exts) {
            const filename = `${username}${ext}`;
            const fullPath = path.join(baseDir, filename);
            if (fs.existsSync(fullPath)) {
                try {
                    const stat = fs.statSync(fullPath);
                    return `/Static/avatars/${filename}?v=${Math.floor(stat.mtimeMs)}`;
                } catch (e) {
                    return `/Static/avatars/${filename}`;
                }
            }
        }
        return null;
    },

    resolveUserBanner: (username) => {
        const baseDir = path.join(__dirname, '../Static/banners');
        if (!fs.existsSync(baseDir)) return null;

        const exts = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
        for (const ext of exts) {
            const filename = `${username}${ext}`;
            const fullPath = path.join(baseDir, filename);
            if (fs.existsSync(fullPath)) {
                try {
                    const stat = fs.statSync(fullPath);
                    return `/Static/banners/${filename}?v=${Math.floor(stat.mtimeMs)}`;
                } catch (e) {
                    return `/Static/banners/${filename}`;
                }
            }
        }
        return null;
    },

    formatDuration: (durationInSeconds) => {
        if (!durationInSeconds) return "0:00";
        const totalSeconds = parseFloat(durationInSeconds);
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = Math.floor(totalSeconds % 60);
        return `${minutes}:${seconds.toString().padStart(2, '0')}`;
    },

    sanitizeFilename: (name) => {
        if (!name) return "unknown";
        // Allow Unicode letters (\p{L}), marks (\p{M}), and numbers (\p{N}), plus some safe symbols
        // Sticking to common safe characters: spaces, dots, dashes, underscores
        return name.replace(/[^\p{L}\p{M}\p{N}\s.\-_]/gu, "").trim() || "unknown";
    },

    extractCoverArt: async (audioPath, outputBasePath) => {
        try {
            const metadata = await mm.parseFile(audioPath);
            const picture = metadata.common.picture && metadata.common.picture[0];
            
            if (picture) {
                let extension = ".jpg";
                if (picture.format === 'image/png') extension = ".png";
                
                const finalPath = `${outputBasePath}${extension}`;
                fs.writeFileSync(finalPath, picture.data);
                return finalPath;
            }
        } catch (err) {
            console.error("Error extracting cover art:", err);
        }
        return false;
    },

    processAvatarUpload: async (fileBuffer, username) => {
        const avatarsDir = path.join(__dirname, '../Static/avatars');
        if (!fs.existsSync(avatarsDir)) {
            fs.mkdirSync(avatarsDir, { recursive: true });
        }

        // Clean up old avatars
        const exts = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
        for (const ext of exts) {
            const p = path.join(avatarsDir, `${username}${ext}`);
            if (fs.existsSync(p)) fs.unlinkSync(p);
        }

        try {
            const image = await Jimp.read(fileBuffer);
            image.resize({ w: 512, h: 512 }); // Resize to 512x512
            const savePath = path.join(avatarsDir, `${username}.jpg`);
            
            await image.write(savePath);
            return `/Static/avatars/${username}.jpg`;
        } catch (err) {
            console.error("Error processing avatar:", err);
            return null;
        }
    },

    processUserBannerUpload: async (fileBuffer, username) => {
        const bannersDir = path.join(__dirname, '../Static/banners');
        if (!fs.existsSync(bannersDir)) {
            fs.mkdirSync(bannersDir, { recursive: true });
        }

        // Clean up old banners
        const exts = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
        for (const ext of exts) {
            const p = path.join(bannersDir, `${username}${ext}`);
            if (fs.existsSync(p)) fs.unlinkSync(p);
        }

        try {
            const image = await Jimp.read(fileBuffer);
            // Banner aspect ratio 1500x500 is common (3:1)
            image.resize({ w: 1500, h: 500 }); 
            const savePath = path.join(bannersDir, `${username}.jpg`);
            
            await image.write(savePath);
            return `/Static/banners/${username}.jpg`;
        } catch (err) {
            console.error("Error processing banner:", err);
            return null;
        }
    },

    isValidAudio: (filePath) => {
        try {
            const buffer = Buffer.alloc(12);
            const fd = fs.openSync(filePath, 'r');
            fs.readSync(fd, buffer, 0, 12, 0);
            fs.closeSync(fd);

            // Magic numbers
            const isMp3  = (buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33) || // ID3
                           (buffer[0] === 0xFF && (buffer[1] & 0xE0) === 0xE0);               // Frame sync
            const isWav  = buffer.toString('utf8', 0, 4) === 'RIFF' && buffer.toString('utf8', 8, 12) === 'WAVE';
            const isFlac = buffer.toString('utf8', 0, 4) === 'fLaC';
            const isM4a  = buffer.toString('utf8', 4, 8) === 'ftyp';
            const isWebm = buffer[0] === 0x1A && buffer[1] === 0x45 && buffer[2] === 0xDF && buffer[3] === 0xA3; // EBML/Webm
            const isOgg  = buffer.toString('utf8', 0, 4) === 'OggS';

            return isMp3 || isWav || isFlac || isM4a || isWebm || isOgg;
        } catch (err) {
            console.error("Audio validation error:", err);
            return false;
        }
    },

    saveSong: async (filePath, baseDirectory = "../MusicLibrary/", uploadedBy = "Unknown User", compress = true, visibility = "private", nameHint = null, metadataOverride = null, fingerprint = {}) => {
        console.log(`Processing file: ${filePath}`);
        
        // 1. Hard check for audio validity (Magic Numbers)
        if (!Media.isValidAudio(filePath)) {
            console.warn(`[SECURITY] Rejected invalid audio header: ${filePath}`);
            return null;
        }

        let metadata;
        if (metadataOverride) {
            // If duration wasn't provided, parse it from the actual file
            let duration = metadataOverride.duration;
            if (!duration) {
                try {
                    const fileMeta = await mm.parseFile(filePath);
                    duration = fileMeta.format.duration || 0;
                } catch (e) {
                    duration = 0;
                }
            }
            metadata = {
                common: {
                    title: metadataOverride.title,
                    artist: metadataOverride.artist,
                    album: metadataOverride.album || "Single",
                    genre: metadataOverride.genre || "Unknown Genre"
                },
                format: {
                    duration: duration
                }
            };
        } else {
            try {
                metadata = await mm.parseFile(filePath);
                // 2. Strict metadata check - if it can't even find duration, it's likely not audio
                if (!metadata || !metadata.format || isNaN(metadata.format.duration)) {
                    console.warn(`[SECURITY] Rejected file with no audio metadata: ${filePath}`);
                    return null;
                }
            } catch (err) {
                console.error("Metadata parsing error:", err);
                return null; // Abort if metadata fails
            }
        }

        let title = metadata.common.title || (nameHint ? path.parse(nameHint).name : null) || path.parse(filePath).name;
        // Strip any remaining Multer-style timestamp prefixes just in case
        title = title.replace(/^\d{10,15}-/, "");
        
        let artist = metadata.common.artist || "Unknown Artist";
        let album = metadata.common.album || "Unknown Album";
        let genre = (metadata.common.genre && metadata.common.genre.length > 0) ? metadata.common.genre[0] : "Unknown Genre";
        let duration = Math.round(metadata.format.duration || 0);

        console.log(`[DEBUG] Metadata - Title: ${title}, Artist: ${artist}, Duration: ${duration}s`);

        const uploadDir = path.join(__dirname, baseDirectory, 'uploads');
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }

        // Generate a Unique Hash for the physical file
        const uniqueHash = crypto.randomBytes(12).toString('hex');
        const ext = compress ? '.mp3' : path.extname(filePath);
        let newFilename = `${uniqueHash}${ext}`;
        let newPath = path.join(uploadDir, newFilename);

        // Rare collision check
        while (fs.existsSync(newPath)) {
            const extra = crypto.randomBytes(4).toString('hex');
            newPath = path.join(uploadDir, `${uniqueHash}-${extra}${ext}`);
        }

        const runCompression = () => {
            return new Promise((resolve, reject) => {
                if (compress) {
                    console.log(`Compressing with fluent-ffmpeg to ${newPath}...`);
                    ffmpeg(filePath)
                        .audioBitrate('128k')
                        .outputOptions(['-map_metadata 0', '-preset ultrafast'])
                        .save(newPath)
                        .on('end', () => {
                            console.log(`[DEBUG] FFmpeg conversion finished successfully: ${newPath}`);
                            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
                            resolve(newPath);
                        })
                        .on('error', (err) => {
                            console.error(`[ERROR] FFmpeg conversion failed for ${filePath}: ${err.message}`);
                            reject(err);
                        });
                } else {
                    console.log(`Moving file to ${newPath} without compression...`);
                    fs.renameSync(filePath, newPath);
                    resolve(newPath);
                }
            });
        };

        try {
            await runCompression();

            const dbRelativePath = path.relative(path.join(__dirname, '../'), newPath).replace(/\\/g, '/');
            
            // Get final file size
            let finalBytes = 0;
            if (fs.existsSync(newPath)) {
                finalBytes = fs.statSync(newPath).size;
            }

            await HandleDatabase.incrementStorageUsed(uploadedBy, finalBytes);

            // Extract bitrate and source from fingerprint if provided, otherwise detect from file
            let bitrate = fingerprint.bitrate;
            if (!bitrate && metadata.format && metadata.format.bitrate) {
                bitrate = Math.round(metadata.format.bitrate / 1000); // Convert to kbps
            }
            if (!bitrate) bitrate = 128; // fallback
            
            const source = fingerprint.source || "upload";

            await HandleDatabase.insertSong(title, artist, album, genre, duration, dbRelativePath, uploadedBy, visibility, fingerprint.youtube_id, fingerprint.file_hash, bitrate, source);
            
            console.log(`Success! Saved to ${dbRelativePath} (${finalBytes} bytes)`);
            return dbRelativePath;
        } catch (err) {
            console.error(err);
            return null;
        }
    }
};

module.exports = Media;
