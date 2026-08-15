const mm = require('music-metadata');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const { Jimp } = require('jimp');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const HandleDatabase = require('./database');
const RT = require('./runtime');

// Set ffmpeg path.
// unpackPath() rewrites app.asar -> app.asar.unpacked when running inside a
// packaged Electron build. The OS cannot exec a binary that only exists inside
// the asar archive, so without this ffmpeg silently fails to spawn.
ffmpeg.setFfmpegPath(RT.unpackPath(ffmpegPath));

async function writeProfileImage(fileBuffer, directory, username, width, height, urlType) {
    if (!/^[A-Za-z0-9_-]{3,32}$/.test(username)) {
        throw new Error('Invalid username for profile media');
    }
    if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true });

    const image = await Jimp.read(fileBuffer);
    const sourceWidth = image.bitmap?.width || image.width;
    const sourceHeight = image.bitmap?.height || image.height;
    if (!sourceWidth || !sourceHeight || sourceWidth * sourceHeight > 25_000_000) {
        throw new Error('Image dimensions are too large');
    }
    image.resize({ w: width, h: height });

    const savePath = path.join(directory, `${username}.jpg`);
    const tempPath = path.join(directory, `.${username}-${crypto.randomUUID()}.jpg`);
    const backupPath = `${savePath}.backup`;
    await image.write(tempPath);

    try {
        if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
        if (fs.existsSync(savePath)) fs.renameSync(savePath, backupPath);
        fs.renameSync(tempPath, savePath);
        if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);

        for (const ext of ['.jpeg', '.png', '.webp', '.gif']) {
            const oldPath = path.join(directory, `${username}${ext}`);
            if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
        }
    } catch (error) {
        if (!fs.existsSync(savePath) && fs.existsSync(backupPath)) fs.renameSync(backupPath, savePath);
        throw error;
    } finally {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    }

    return `/Static/${urlType}/${username}.jpg`;
}

const Media = {
    // Media.resolve_cover
    resolveCover: (songBaseName) => {
        const baseDir = RT.paths.covers;
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
        const baseDir = RT.paths.avatars;
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
        const baseDir = RT.paths.banners;
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
        try {
            return await writeProfileImage(fileBuffer, RT.paths.avatars, username, 512, 512, 'avatars');
        } catch (err) {
            console.error("Error processing avatar:", err);
            return null;
        }
    },

    processUserBannerUpload: async (fileBuffer, username) => {
        try {
            return await writeProfileImage(fileBuffer, RT.paths.banners, username, 1500, 500, 'banners');
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

        // baseDirectory is historically expressed relative to Server/ (e.g.
        // "../MusicLibrary/"). Strip the leading ../ and resolve against
        // DATA_ROOT so packaged builds write to the per-user data directory.
        const uploadDir = path.join(
            RT.DATA_ROOT,
            baseDirectory.replace(/^\.\.[\\/]/, ''),
            'uploads'
        );
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

            const dbRelativePath = path.relative(RT.DATA_ROOT, newPath).replace(/\\/g, '/');
            
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

            // Metadata will be enriched on-demand by user via Smart Metadata Review
            // (no more silent auto-enrichment that could overwrite with wrong data)
            let year = null;
            let coverPath = null;
            let aiEnriched = 0;

            await HandleDatabase.insertSong(title, artist, album, genre, duration, dbRelativePath, uploadedBy, visibility, fingerprint.youtube_id, fingerprint.file_hash, bitrate, source, year, aiEnriched, coverPath);
            
            console.log(`Success! Saved to ${dbRelativePath} (${finalBytes} bytes)`);
            return dbRelativePath;
        } catch (err) {
            console.error(err);
            return null;
        }
    }
};

module.exports = Media;
