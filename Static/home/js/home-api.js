/**
 * ============================================================================
 * STREAMIFY MUSIC PLAYER - JavaScript API
 * ============================================================================
 * Handles all music playback, UI interactions, search, and user management
 * ============================================================================
 */

/* ========== GLOBAL VARIABLES ========== */
/* These variables maintain the state of the music player throughout the app */

let isPlaying = false;                    // Current playback status
let currentPlaylist = [];                 // Array of all song objects in current view
let shuffledPlaylist = [];                // Shuffled order of song indices (for shuffle mode)
let currentIndex = -1;                    // Current position in the playlist
let isShuffle = false;                    // Shuffle mode toggle
let repeatMode = 0;                       // 0: Off, 1: Repeat All, 2: Repeat One

/* Get the hidden audio element that actually plays the music */
const audio = document.getElementById('audio-player');

/* ========== DOM ELEMENTS ========== */
/* Cache frequently accessed DOM elements for performance */

/* Player display elements */
const playerTitle = document.getElementById('player-title');        // Song title in player
const playerArtist = document.getElementById('player-artist');      // Artist name in player
const playerImg = document.getElementById('player-img');            // Album artwork in player

/* Player control buttons */
const btnPlay = document.getElementById('btn-play');                // Play/Pause button
const btnNext = document.getElementById('btn-next');                // Next track button
const btnPrev = document.getElementById('btn-prev');                // Previous track button
const btnShuffle = document.getElementById('btn-shuffle');          // Shuffle toggle
const btnRepeat = document.getElementById('btn-repeat');            // Repeat mode toggle

/* Progress bar and time display elements */
const progressBar = document.getElementById('progress-bar');        // Progress bar fill indicator
const progressContainer = document.querySelector('.progress-bar-wrapper'); // Progress bar background/wrapper
const currTimeEl = document.getElementById('current-time');         // Current time display
const durTimeEl = document.getElementById('duration');              // Total duration display

/* Volume control elements */
const volSlider = document.getElementById('volume-slider');         // Volume slider input
const volIcon = document.getElementById('vol-icon');                // Volume icon (shows mute state)

/* ========== INITIALIZATION & EVENT LISTENERS ========== */
/* All setup happens here once the DOM is fully loaded */
document.addEventListener('DOMContentLoaded', () => {
    /* ========== USER MENU DROPDOWN ========== */
    /* Handle the user profile pill and dropdown menu */
    const userPill = document.querySelector('.user-pill');
    const userMenu = document.getElementById('user-menu');

    // Toggle dropdown menu when user clicks their profile
    if (userPill && userMenu) {
        userPill.addEventListener('click', (e) => {
            e.stopPropagation(); // prevent immediate close
            userMenu.classList.toggle('show');
        });
    }

    /* ========== CUSTOM FILE UPLOAD ========== */
    /* Create a custom styled file upload button that triggers the hidden input */
    const realInput = document.getElementById('avatar-upload');
    const customBtn = document.getElementById('trigger-upload-btn');
    const fileNameSpan = document.getElementById('avatar-file-name');

    // 1. When we click the custom button, click the hidden real input
    if (customBtn && realInput) {
        customBtn.addEventListener('click', () => {
            realInput.click();
        });
    }

    // 2. When a file is chosen, update the text
    if (realInput) {
        realInput.addEventListener('change', () => {
            if (realInput.files.length > 0) {
                fileNameSpan.textContent = realInput.files[0].name;
                fileNameSpan.style.color = "#fff"; // Make text brighter when selected
            } else {
                fileNameSpan.textContent = "No file chosen";
                fileNameSpan.style.color = ""; // Revert to gray
            }
        });
    }

    /* ========== SETTINGS MODAL ========== */
    /* Handle opening, closing, and submitting the settings/profile modal */
    const settingsBtn = document.getElementById('open-settings-btn');
    const modal = document.getElementById('settings-modal');
    const closeModalBtn = document.getElementById('close-modal-btn');
    const cancelBtn = document.getElementById('cancel-btn');

    // 1. Open Modal
    if (settingsBtn) {
        settingsBtn.addEventListener('click', (e) => {
            e.preventDefault(); // Stop navigation
            // Close the dropdown menu first so it's not in the way
            document.getElementById('user-menu').classList.remove('show');
            // Show modal
            modal.classList.remove('hidden');
        });
    }

    // 2. Close Modal Functions
    const closeModal = () => {
        modal.classList.add('hidden');
    };

    if (closeModalBtn) closeModalBtn.addEventListener('click', closeModal);
    if (cancelBtn) cancelBtn.addEventListener('click', closeModal);

    // 3. Close when clicking outside the box
    if (modal) {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                closeModal();
            }
        });
    }

    // Close dropdown when clicking outside
    document.addEventListener('click', (e) => {
        if (userMenu && userMenu.classList.contains('show')) {
            if (!userMenu.contains(e.target) && !userPill.contains(e.target)) {
                userMenu.classList.remove('show');
            }
        }
    });

    // Initial Fetches
    fetchTrending(); // Home defaults to Trending
    fetchCurrentUser();

    // [NEW] Avatar Upload Logic
    const avatarForm = document.querySelector('.modal-form');
    if (avatarForm) {
        avatarForm.addEventListener('submit', (e) => {
            e.preventDefault();
            const fileInput = document.getElementById('avatar-upload');
            
            /* Submit avatar to server and handle response */
            if (fileInput.files.length === 0) {
                alert("Please choose a file first.");
                return;
            }

            const formData = new FormData();
            formData.append("avatar_file", fileInput.files[0]);

            const btn = avatarForm.querySelector('button[type="submit"]');
            const originalText = btn.textContent;
            btn.textContent = "Uploading...";
            btn.disabled = true;

            fetch('/api/upload-avatar', {
                method: 'POST',
                body: formData
            })
                .then(response => {
                    if (response.redirected) {
                        window.location.href = response.url;
                    } else if (response.ok) {
                        window.location.reload();
                    } else {
                        alert("Upload failed.");
                    }
                })
                .catch(err => {
                    console.error(err);
                    alert("Error uploading avatar.");
                })
                .finally(() => {
                    btn.textContent = originalText;
                    btn.disabled = false;
                });
        });
    }

    // [NEW] Search Logic
    const searchInput = document.getElementById('gsearch');
    let searchTimeout = null;

    if (searchInput) {
        /* Debounced search - wait 500ms after user stops typing */
        searchInput.addEventListener('input', (e) => {
            const query = e.target.value.trim();
            if (searchTimeout) clearTimeout(searchTimeout);

            if (query.length > 0) {
                searchTimeout = setTimeout(() => {
                    performSearch(query);
                }, 500); // 500ms debounce
            } else {
                // Query cleared -> Go back to Home
                if (homeLink) homeLink.click();
            }
        });

        // Also trigger on 'Enter' immediately
        searchInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                if (searchTimeout) clearTimeout(searchTimeout);
                performSearch(searchInput.value.trim());
            }
        });
    }

    // [NEW] Mobile Menu Logic
    const menuBtn = document.getElementById('menu-btn');
    const sidebar = document.querySelector('.sidebar');

    /* Toggle sidebar visibility when menu button is clicked on mobile */
    if (menuBtn && sidebar) {
        menuBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            sidebar.classList.toggle('mobile-active');
        });

        // Close when clicking outside
        document.addEventListener('click', (e) => {
            if (sidebar.classList.contains('mobile-active')) {
                if (!sidebar.contains(e.target) && !menuBtn.contains(e.target)) {
                    sidebar.classList.remove('mobile-active');
                }
            }
        });

        // Close when a link inside is clicked
        const navLinks = sidebar.querySelectorAll('a');
        navLinks.forEach(link => {
            link.addEventListener('click', () => {
                sidebar.classList.remove('mobile-active');
            });
        });
    }

    // [NEW CODE] Sidebar Navigation
    const libraryLink = document.getElementById('library-link');
    const homeLink = document.getElementById('home-link');
    const peopleLink = document.getElementById('people-link');
    const uploadLink = document.getElementById('upload-link');
    const thanksLink = document.getElementById('thanks-link');

    /* Get section containers that will be shown/hidden */
    const trendingSection = document.getElementById('trending-section');
    const peopleSection = document.getElementById('people-section');
    const uploadSection = document.getElementById('upload-section');
    const searchSection = document.getElementById('search-section');

    /* Thanks/Like button - show glow effect when clicked */
    if (thanksLink) {
        thanksLink.addEventListener('click', (e) => {
            e.preventDefault();

            // Restart glow if already active
            thanksLink.classList.remove('glow-active');
            void thanksLink.offsetWidth; // Force reflow
            thanksLink.classList.add('glow-active');

            //triggerHeartConfetti(thanksLink);

            // Remove after 1.5s
            setTimeout(() => {
                thanksLink.classList.remove('glow-active');
            }, 2000);
        });
    }

    // Helper to switch sections with animation reset
    function showSection(section) {
        if (!section) return;
        section.classList.remove('hidden');
        section.classList.remove('fade-in-animate');
        // Force reflow to restart animation
        void section.offsetWidth;
        section.classList.add('fade-in-animate');
    }

    /* Hide all sections and clear active nav states */
    function hideAllSections() {
        [trendingSection, peopleSection, uploadSection, searchSection].forEach(sec => {
            if (sec) {
                sec.classList.add('hidden');
                sec.classList.remove('fade-in-animate');
            }
        });

        // Reset active states
        if (homeLink) homeLink.classList.remove('active');
        if (libraryLink) libraryLink.classList.remove('active');
        if (peopleLink) peopleLink.classList.remove('active');
        if (uploadLink) uploadLink.classList.remove('active');
        // Search link doesn't hold 'active' state usually, but clearing others is good.
    }

    if (homeLink) {
        homeLink.addEventListener('click', (e) => {
            e.preventDefault();
            hideAllSections();
            homeLink.classList.add('active');
            // update title
            const title = trendingSection.querySelector('h2');
            if (title) title.textContent = "Trending";
            showSection(trendingSection);
            fetchTrending();
        });
    }

    if (libraryLink) {
        libraryLink.addEventListener('click', (e) => {
            e.preventDefault();
            hideAllSections();
            libraryLink.classList.add('active');
            const title = trendingSection.querySelector('h2');
            if (title) title.textContent = "Your Library";
            showSection(trendingSection);
            fetchLibrary();
        });
    }

    if (peopleLink) {
        peopleLink.addEventListener('click', (e) => {
            e.preventDefault();
            hideAllSections();
            peopleLink.classList.add('active');
            showSection(peopleSection);
            fetchPeople();
        });
    }

    if (uploadLink) {
        uploadLink.addEventListener('click', (e) => {
            e.preventDefault();
            hideAllSections();
            uploadLink.classList.add('active');
            showSection(uploadSection);
        });
    }

    // [NEW] Perform Search
    function performSearch(query) {
        if (!query) return;

        /* Show search results section and hide others */
        hideAllSections();
        showSection(searchSection);

        const usersGrid = document.getElementById('search-users-grid');
        const songsList = document.getElementById('search-songs-list');

        // Clear previous
        usersGrid.innerHTML = '<p style="color:#b3b3b3;">Searching...</p>';
        songsList.innerHTML = '<p style="color:#b3b3b3;">Searching...</p>';

        fetch(`/api/search?q=${encodeURIComponent(query)}`)
            .then(res => res.json())
            .then(data => {
                // 1. Users
                usersGrid.innerHTML = '';
                if (data.users && data.users.length > 0) {
                    data.users.forEach(u => {
                        const card = document.createElement('div');
                        card.className = 'card'; // Reuse people card style
                        // Avatar check
                        let avatarHtml = '';
                        if (u.avatar) {
                            avatarHtml = `<div style="width: 100px; height: 100px; border-radius: 50%; background: url('${u.avatar}') center/cover; margin: 0 auto 10px;"></div>`;
                        } else {
                            const initial = u.username.charAt(0).toUpperCase();
                            avatarHtml = `<div style="width: 100px; height: 100px; background: linear-gradient(45deg, #555, #333); border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 36px; margin: 0 auto 10px;">${initial}</div>`;
                        }

                        card.innerHTML = `
                            ${avatarHtml}
                            <div style="text-align:center; font-weight:bold;">${u.username}</div>
                        `;
                        usersGrid.appendChild(card);
                    });
                } else {
                    usersGrid.innerHTML = '<p style="color:#b3b3b3;">No users match your search.</p>';
                }

                // 2. Songs
                // Keep header
                songsList.innerHTML = `
                    <div class="song-row header-row" style="cursor: default; background: transparent; color: #b3b3b3; border-bottom: 1px solid #333; margin-bottom: 10px;">
                        <span>#</span>
                        <span>Title</span>
                        <span>Album</span>
                        <span>Uploaded By</span>
                        <span><i class='bx bx-time'></i></span>
                    </div>
                `;

                if (data.songs && data.songs.length > 0) {
                    // Update global playlist so clicks work
                    currentPlaylist = data.songs.map(s => ({
                        title: s.name || s.title || s,
                        artist: s.artist || "Unknown Artist",
                        album: s.album || "Single",
                        cover: s.cover,
                        uploaded_by: s.uploaded_by || "Unknown",
                        duration: s.duration,
                        url: `/api/play/${encodeURIComponent(s.name || s.title || s)}`
                    }));

                    shuffledPlaylist = [...Array(currentPlaylist.length).keys()];

                    currentPlaylist.forEach((song, index) => {
                        const cover = song.cover || "https://via.placeholder.com/60";
                        const row = document.createElement('div');
                        row.className = 'song-row';
                        row.innerHTML = `
                            <span>${index + 1}</span>
                            <div class="song-info">
                                <img src="${cover}" alt="cover">
                                <div>
                                    <div class="song-title-row">${song.title}</div>
                                    <div style="font-size: 12px;">${song.artist}</div>
                                </div>
                            </div>
                            <span>${song.album}</span>
                            <span>${song.uploaded_by}</span>
                            <span>${song.duration}</span>
                        `;
                        row.onclick = () => playSongAtIndex(index);
                        songsList.appendChild(row);
                    });

                } else {
                    songsList.insertAdjacentHTML('beforeend', '<p style="padding:10px; color:#b3b3b3;">No songs match your search.</p>');
                }

            })
            .catch(err => {
                console.error(err);
                usersGrid.innerHTML = '<p style="color:red;">Error searching.</p>';
            });
    }

});

// [NEW] Fetch Library (My Uploads)
function fetchLibrary() {
    const list = document.getElementById('trending-list');
    const header = list.querySelector('.header-row');

    list.innerHTML = '';
    list.appendChild(header);

    /* Show loading message while fetching */
    list.insertAdjacentHTML('beforeend', '<div style="padding:20px; color:#b3b3b3;">Loading your songs...</div>');

    fetch('/api/library')
        .then(response => response.json())
        .then(songs => {
            list.innerHTML = '';
            list.appendChild(header);

            if (!songs || songs.length === 0) {
                list.insertAdjacentHTML('beforeend', '<div style="padding:20px; color:#b3b3b3;">You haven\'t uploaded any songs yet.</div>');
                return;
            }

            // Store playlist globally
            currentPlaylist = songs.map(s => ({
                title: s.name || s.title || s,
                artist: s.artist || "Unknown Artist",
                album: s.album || "Single",
                cover: s.cover,
                uploaded_by: s.uploaded_by || "You",
                duration: s.duration,
                url: `/api/play/${encodeURIComponent(s.name || s.title || s)}`
            }));

            shuffledPlaylist = [...Array(currentPlaylist.length).keys()];

            currentPlaylist.forEach((song, index) => {
                const duration = song.duration || "--:--";
                const cover = song.cover || "https://via.placeholder.com/60";

                const row = document.createElement('div');
                row.className = 'song-row';
                row.innerHTML = `
                    <span>${index + 1}</span>
                    <div class="song-info">
                        <img src="${cover}" alt="cover">
                        <div>
                            <div class="song-title-row">${song.title}</div>
                            <div style="font-size: 12px;">${song.artist}</div>
                        </div>
                    </div>
                    <span>${song.album}</span>
                    <span>${song.uploaded_by || "You"}</span>
                    <span>${duration}</span>
                `;

                row.onclick = () => playSongAtIndex(index);
                list.appendChild(row);
            });
        })
        .catch(error => {
            console.error('Error fetching library:', error);
            list.innerHTML = '';
            list.appendChild(header);
            list.insertAdjacentHTML('beforeend', '<div style="padding:20px; color:red;">Failed to load library.</div>');
        });
}

// 3. Fetch Current User
function fetchCurrentUser() {
    /* Get current logged-in user data from server */
    fetch('/api/me')
        .then(response => response.json())
        .then(data => {
            const username = data.username || "User";
            const userPillName = document.querySelector('.user-pill span');
            if (userPillName) userPillName.textContent = username;

            const userAvatar = document.querySelector('.user-avatar');
            if (userAvatar) {
                if (data.avatar) {
                    // It's a div, so set background image
                    userAvatar.textContent = "";
                    userAvatar.style.backgroundImage = `url('${data.avatar}')`;
                    userAvatar.style.backgroundSize = "cover";
                    userAvatar.style.backgroundPosition = "center";
                } else {
                    userAvatar.textContent = username.charAt(0).toUpperCase();
                    userAvatar.style.backgroundImage = "none";
                }
            }
        })
        .catch(error => console.error('Error fetching user:', error));
}



// 2. Fetch Trending Songs
function fetchTrending() {
    const list = document.getElementById('trending-list');

    /* Fetch trending songs from the backend API */
    fetch('/api/trending')
        .then(response => response.json())
        .then(songs => {
            // Keep the header, remove old items
            const header = list.querySelector('.header-row');
            list.innerHTML = '';
            list.appendChild(header);

            // [NEW CODE] Store playlist globally
            currentPlaylist = songs.map(s => ({
                title: s.name || s.title || s,
                artist: s.artist || "Unknown Artist",
                album: s.album || "Single",
                cover: s.cover, // might be null
                uploaded_by: s.uploaded_by || "Unknown",
                duration: s.duration,
                url: `/api/play/${encodeURIComponent(s.name || s.title || s)}` // Construct URL upfront
            }));

            // Generate valid indices for shuffle
            shuffledPlaylist = [...Array(currentPlaylist.length).keys()];

            currentPlaylist.forEach((song, index) => {
                const duration = song.duration || "--:--";
                // Default to placeholder if backend cover is missing
                const hasBackendCover = !!song.cover;
                const cover = song.cover || "https://via.placeholder.com/60";

                const row = document.createElement('div');
                row.className = 'song-row';
                row.innerHTML = `
                            <span>${index + 1}</span>
                            <div class="song-info">
                                <img src="${cover}" alt="cover" id="trend-img-${index}">
                                <div>
                                    <div class="song-title-row">${song.title}</div>
                                    <div style="font-size: 12px;">${song.artist}</div>
                                </div>
                            </div>
                            <span>${song.album}</span>
                            <span>${song.uploaded_by || "Unknown"}</span>
                            <span>${duration}</span>
                        `;

                /* Distinguish between scrolling and clicking on touch devices */
                let isScrolling = false;
                let startX = 0;
                let startY = 0;

                row.addEventListener('touchstart', (e) => {
                    isScrolling = false;
                    startX = e.touches[0].clientX;
                    startY = e.touches[0].clientY;
                }, { passive: true });

                row.addEventListener('touchmove', (e) => {
                    const moveX = Math.abs(e.touches[0].clientX - startX);
                    const moveY = Math.abs(e.touches[0].clientY - startY);
                    if (moveY > 10 || moveX > 10) {
                        isScrolling = true;
                    }
                }, { passive: true });

                row.addEventListener('touchend', (e) => {
                    if (!isScrolling) {
                        if (e.cancelable) e.preventDefault();
                        playSongAtIndex(index);
                    }
                });

                row.addEventListener('click', (e) => {
                    // Touchend prevents default, so this only runs if touch didn't happen (Desktop/Mouse)
                    playSongAtIndex(index);
                });


                // [NEW CODE] Hover effect to scroll long titles
                row.addEventListener('mouseenter', () => {
                    const titleEl = row.querySelector('.song-title-row');
                    /* Check if title overflows and needs scrolling animation */
                    if (titleEl.scrollWidth > titleEl.clientWidth) {
                        // Calculate how much to scroll (difference + some padding)
                        const difference = titleEl.scrollWidth - titleEl.clientWidth;
                        titleEl.style.setProperty('--scroll-amount', `-${difference + 10}px`);
                        titleEl.classList.add('scrolling');
                    }
                });
                row.addEventListener('mouseleave', () => {
                    const titleEl = row.querySelector('.song-title-row');
                    titleEl.classList.remove('scrolling');
                    titleEl.style.removeProperty('--scroll-amount');
                });

                list.appendChild(row);

                // [NEW CODE] If no backend cover, try to fetch from web
                if (!hasBackendCover) {
                    /* Try to fetch album artwork from iTunes API */
                    fetchWebCover(song.artist, song.title).then(newUrl => {
                        if (newUrl) {
                            const img = document.getElementById(`trend-img-${index}`);
                            if (img) img.src = newUrl;
                            // Update playlist data too so player uses it
                            currentPlaylist[index].cover = newUrl;
                        }
                    });
                }
            });
        })
        .catch(error => console.error('Error fetching trending songs:', error));
}

/* --- PLAYER CONTROLLER --- */

// [NEW] Fetch People Directory
function fetchPeople() {
    const grid = document.getElementById('people-grid');
    /* Show loading state while fetching users */
    grid.innerHTML = '<p style="color:#b3b3b3; padding: 20px;">Loading...</p>';

    fetch('/api/users')
        .then(response => response.json())
        .then(users => {
            grid.innerHTML = '';
            if (!users || users.length === 0) {
                grid.innerHTML = '<p style="color:#b3b3b3; padding: 20px;">No users found.</p>';
                return;
            }

            users.forEach(user => {
                const card = document.createElement('div');
                card.className = 'card';
                // Avatar handling
                let avatarHtml = '';
                if (user.avatar) {
                    avatarHtml = `
                        <div style="width: 120px; height: 120px; border-radius: 50%; background: url('${user.avatar}') center/cover; margin: 0 auto 16px; box-shadow: 0 4px 10px rgba(0,0,0,0.5);"></div>
                    `;
                } else {
                    const initial = user.username ? user.username.charAt(0).toUpperCase() : '?';
                    avatarHtml = `
                        <div style="width: 120px; height: 120px; background: linear-gradient(45deg, #1db954, #191414); border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 48px; font-weight: bold; margin: 0 auto 16px; box-shadow: 0 4px 10px rgba(0,0,0,0.5);">
                            ${initial}
                        </div>
                     `;
                }

                if (user.username === "lwitchy") {
                    card.innerHTML = `
                        ${avatarHtml}
                        <div class="card-title" style="text-align: center; font-size: 1.1em;">${user.username}</div>
                        <div class="card-desc" style="text-align: center;">Streamify Admin</div>
                    `;
                } else {
                    card.innerHTML = `
                        ${avatarHtml}
                        <div class="card-title" style="text-align: center; font-size: 1.1em;">${user.username}</div>
                        <div class="card-desc" style="text-align: center;">Streamify User</div>
                    `;
                }
                grid.appendChild(card);
            });
        })
        .catch(error => {
            console.error('Error fetching people:', error);
            grid.innerHTML = '<p style="color:red; padding: 20px;">Error loading people.</p>';
        });
}

function playSongAtIndex(index) {
    if (index < 0 || index >= currentPlaylist.length) return;

    /* Convert UI index to real playlist index (handles shuffle mapping) */
    let realIndex = index;
    if (isShuffle) {
        /* Find which position in shuffledPlaylist holds 'realIndex' */
        const shufflePos = shuffledPlaylist.indexOf(realIndex);
        if (shufflePos !== -1) {
            currentIndex = shufflePos;
        } else {
            // Should not happen if shuffledPlaylist is complete
            currentIndex = 0;
            console.error("Song not found in shuffle queue");
        }
    } else {
        currentIndex = realIndex;
    }

    const song = currentPlaylist[realIndex];

    /* Fetch the actual playable URL from the backend API */
    // The backend returns signed URLs and updated cover art if available
    fetch(song.url)
        .then(response => response.json())
        .then(songData => {
            // Update URL with signed/temporary URL from backend if needed
            // The backend returns {url: ..., cover: ...}

            // If backend provides a better cover, use it
            if (songData.cover) song.cover = songData.cover;

            loadSong({
                title: song.title,
                artist: song.artist,
                album: song.album,
                url: songData.url,
                cover: song.cover || "https://via.placeholder.com/200"
            });
            playSong();
        })
        .catch(err => console.error("Failed to play song", err));
}

function nextSong() {
    if (currentPlaylist.length === 0) return;

    /* Handle next song logic with shuffle and repeat modes */
    if (isShuffle) {
        if (currentIndex >= shuffledPlaylist.length - 1) {
            // End of shuffle queue
            if (repeatMode === 1) { // Loop All
                currentIndex = 0;
            } else {
                return; // Stop
            }
        } else {
            currentIndex++;
        }
    } else {
        if (currentIndex >= currentPlaylist.length - 1) {
            if (repeatMode === 1) { // Loop All
                currentIndex = 0;
            } else {
                return; // Stop
            }
        } else {
            currentIndex++;
        }
    }

    playSongAtIndex(getCurrentRealIndex());
}

function prevSong() {
    if (currentPlaylist.length === 0) return;

    /* If song played > 3 seconds, restart instead of going to previous */
    if (audio.currentTime > 3) {
        audio.currentTime = 0;
        return;
    }

    if (currentIndex > 0) {
        currentIndex--;
    } else {
        // Wrap around if repeat all? Or just stop/go to start
        if (repeatMode === 1) { // Loop All
            currentIndex = isShuffle ? shuffledPlaylist.length - 1 : currentPlaylist.length - 1;
        } else {
            currentIndex = 0;
        }
    }
    playSongAtIndex(getCurrentRealIndex());
}

function getCurrentRealIndex() {
    if (isShuffle) {
        return shuffledPlaylist[currentIndex];
    }
    return currentIndex;
}

function toggleShuffle() {
    isShuffle = !isShuffle;
    /* Update button color to show active state */
    btnShuffle.style.color = isShuffle ? 'var(--accent)' : '#b3b3b3';

    if (isShuffle) {
        // Fisher-Yates Shuffle
        shuffledPlaylist = [...Array(currentPlaylist.length).keys()];
        for (let i = shuffledPlaylist.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [shuffledPlaylist[i], shuffledPlaylist[j]] = [shuffledPlaylist[j], shuffledPlaylist[i]];
        }
        // Ideally we keep the current song playing and set currentIndex to its new position
        if (currentIndex !== -1 && !isPlaying) {
            // If nothing playing, just reset
            currentIndex = 0;
        } else if (currentIndex !== -1) {
            // A song is playing, find it in new shuffle logic
            // NOTE: This simple logic resets queue order relative to now. 
            // For true seamless shuffle toggle, it's complex. 
            // Simplified: Just shuffle and reset index to 0 for next song.
            // Better: Find current Real Index in the new shuffled array
            let currentReal = isShuffle ? getCurrentRealIndex() : currentIndex;
            // Wait, getCurrentRealIndex relies on isShuffle state which we just flipped.
            // Let's assume we were in Normal mode (index = real), switched to Shuffle.
            // We want shuffledPlaylist to contain 'currentReal' at 'newIndex' ??
            // Too complex for now. Let's just shuffle. 

            // Re-find current song in shuffled list to continue seamlessly
            // Actually getCurrentRealIndex() might be broken if we just flipped isShuffle.
            // We'll trust the flow: Next song will be random.
            currentIndex = shuffledPlaylist.indexOf(currentPlaylist.length > 0 ? 0 : 0); // Reset or improve later
        }
    } else {
        // Back to normal
        // Map current shuffle song back to normal index
        if (currentIndex !== -1 && currentPlaylist.length > 0) {
            let real = shuffledPlaylist[currentIndex];
            currentIndex = real;
        }
    }
}

function toggleRepeat() {
    // 0: Off -> 1: All -> 2: One -> 0
    repeatMode = (repeatMode + 1) % 3;

    /* Update repeat button appearance based on current mode */
    if (repeatMode === 0) {
        btnRepeat.style.color = '#b3b3b3';
        btnRepeat.innerHTML = "<i class='bx bx-repeat'></i>";
    } else if (repeatMode === 1) {
        btnRepeat.style.color = 'var(--accent)';
        btnRepeat.innerHTML = "<i class='bx bx-repeat'></i>";
    } else {
        btnRepeat.style.color = 'var(--accent)';
        btnRepeat.innerHTML = "<i class='bx bx-analyse'></i>"; // Icon for 'One' usually has a 1 inside, using analyse as placeholder or re-use repeat with badge
        // Actually bx-repeat has no 1 variant in standard free set sometimes.
        // Let's use a dot or title to indicate.
        btnRepeat.title = "Repeat One";
    }
}

/* --- PLAYER LOGIC --- */
let canSeek = false; // enable seeking only after metadata loads
function loadSong(song) {
    // 1. Existing DOM updates (Keep these!)
    playerTitle.textContent = song.title;
    playerArtist.textContent = song.artist;
    playerImg.src = song.cover;
    audio.src = song.url;

    try { audio.load(); } catch (e) { /* ignore */ }
    canSeek = false;

    progressBar.style.width = '0%';
    currTimeEl.textContent = '0:00';

    /* Highlight currently playing song in the list */
    const rows = document.querySelectorAll('.song-row');
    rows.forEach(r => r.classList.remove('playing'));

    // 2. NEW CODE: Update Phone Lock Screen / Media Center
    if ('mediaSession' in navigator) {
        navigator.mediaSession.metadata = new MediaMetadata({
            title: song.title,
            artist: song.artist,
            album: song.album || "Streamify",
            artwork: [
                // We provide the same image for all sizes; the OS will scale it.
                { src: song.cover, sizes: '96x96', type: 'image/jpeg' },
                { src: song.cover, sizes: '128x128', type: 'image/jpeg' },
                { src: song.cover, sizes: '192x192', type: 'image/jpeg' },
                { src: song.cover, sizes: '256x256', type: 'image/jpeg' },
                { src: song.cover, sizes: '384x384', type: 'image/jpeg' },
                { src: song.cover, sizes: '512x512', type: 'image/jpeg' },
            ]
        });

        // 3. Enable Lock Screen Controls (Play/Pause/Next/Prev)
        navigator.mediaSession.setActionHandler('play', function () { togglePlay(); });
        navigator.mediaSession.setActionHandler('pause', function () { togglePlay(); });

        // Optional: If you implement Next/Prev logic later, add these:
        navigator.mediaSession.setActionHandler('previoustrack', function () {
            /* Allow lock screen previous track button to work */
            document.getElementById('btn-prev').click();
        });
        navigator.mediaSession.setActionHandler('nexttrack', function () {
            document.getElementById('btn-next').click();
        });
    }
}

function playSong() {
    isPlaying = true;
    /* Start audio playback (may fail if autoplay is blocked) */
    audio.play().catch(e => console.log("Autoplay blocked or invalid source"));
    btnPlay.innerHTML = "<i class='bx bx-pause' style='margin-left:0;'></i>";

}

function pauseSong() {
    isPlaying = false;
    /* Pause audio playback */
    audio.pause();
    btnPlay.innerHTML = "<i class='bx bx-play' style='margin-left:2px;'></i>";

}

function togglePlay() {
    if (isPlaying) pauseSong();
    else playSong();
}

/* --- CONTROLS --- */
btnPlay.addEventListener('click', togglePlay);
btnNext.addEventListener('click', nextSong);
btnPrev.addEventListener('click', prevSong);
btnShuffle.addEventListener('click', toggleShuffle);
btnRepeat.addEventListener('click', toggleRepeat);

/* ========== AUDIO EVENT LISTENERS ========== */
/* When song finishes, auto-play next song (or repeat current) */
audio.addEventListener('ended', () => {
    if (repeatMode === 2) { // Repeat One
        audio.currentTime = 0;
        audio.play();
    } else {
        nextSong();
    }
});

audio.addEventListener('timeupdate', (e) => {
    const { duration, currentTime } = e.srcElement;
    if (!duration) return;
    const progressPercent = (currentTime / duration) * 100;
    progressBar.style.width = `${progressPercent}%`;

    /* Helper to format time in MM:SS format */
    const formatTime = (time) => {
        const min = Math.floor(time / 60);
        const sec = Math.floor(time % 60);
        return `${min}:${sec < 10 ? '0' + sec : sec}`;
    };

    currTimeEl.textContent = formatTime(currentTime);
    durTimeEl.textContent = formatTime(duration);
});

// Enable seeking once metadata (duration) is available
audio.addEventListener('loadedmetadata', () => {
    canSeek = true;
    // update duration display immediately when metadata is loaded
    const duration = audio.duration;
    const formatTime = (time) => {
        const min = Math.floor(time / 60);
        const sec = Math.floor(time % 60);
        return `${min}:${sec < 10 ? '0' + sec : sec}`;
    };
    if (duration && !isNaN(duration) && isFinite(duration)) {
        durTimeEl.textContent = formatTime(duration);
    }
});

/* --- DRAG & SCROLL INTERACTION --- */
let isDraggingProgress = false;
let lastVolume = 0.7;

// 1. Progress Bar Logic (Drag + Click + Scroll)
function updateProgressFromEvent(e) {
    if (!canSeek || !audio.duration) return;
    const rect = progressContainer.getBoundingClientRect();
    let clientX = e.clientX;
    // Clamp within bounds for dragging
    if (clientX < rect.left) clientX = rect.left;
    if (clientX > rect.right) clientX = rect.right;

    const clickX = clientX - rect.left;
    const width = rect.width;
    const newTime = (clickX / width) * audio.duration;

    /* Update playback position based on click/drag location */
    audio.currentTime = Math.max(0, Math.min(newTime, audio.duration));
}

progressContainer.addEventListener('mousedown', (e) => {
    isDraggingProgress = true;
    updateProgressFromEvent(e);
});

document.addEventListener('mousemove', (e) => {
    if (isDraggingProgress) {
        e.preventDefault(); // Prevent text selection
        updateProgressFromEvent(e);
    }
});

document.addEventListener('mouseup', () => {
    if (isDraggingProgress) {
        isDraggingProgress = false;
    }
});

progressContainer.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (!canSeek || !audio.duration) return;
    // Scroll Up (neg) = +5s, Down (pos) = -5s
    const step = 5;
    if (e.deltaY < 0) {
        /* Scroll up = skip forward 5 seconds */
        audio.currentTime = Math.min(audio.currentTime + step, audio.duration);
    } else {
        /* Scroll down = skip backward 5 seconds */
        audio.currentTime = Math.max(audio.currentTime - step, 0);
    }
});

// 2. Volume Logic (Scroll + Click Mute)
function handleVolumeScroll(e) {
    e.preventDefault();
    const step = 5;
    let current = parseInt(volSlider.value);

    if (e.deltaY < 0) { // Scroll Up -> Increase
        current = Math.min(current + step, 100);
    } else { // Scroll Down -> Decrease
        current = Math.max(current - step, 0);
    }

    volSlider.value = current;
    // Trigger input listener to update audio.volume and icon
    volSlider.dispatchEvent(new Event('input'));
}

volSlider.addEventListener('wheel', handleVolumeScroll);
volIcon.addEventListener('wheel', handleVolumeScroll);
const volWrapper = document.querySelector('.volume-wrapper');
if (volWrapper) volWrapper.addEventListener('wheel', handleVolumeScroll);

/* Mute/Unmute when user clicks the volume icon */
volIcon.addEventListener('click', () => {
    if (audio.volume > 0) {
        lastVolume = audio.volume;
        audio.volume = 0;
        volSlider.value = 0;
    } else {
        /* Restore previous volume level */
        audio.volume = lastVolume > 0.1 ? lastVolume : 0.5;
        volSlider.value = audio.volume * 100;
    }
    volSlider.dispatchEvent(new Event('input'));
});

/* Update volume and icon when slider is moved */
volSlider.addEventListener('input', (e) => {
    const val = e.target.value;
    audio.volume = val / 100;
    /* Change icon based on volume level */
    if (val == 0) volIcon.className = 'bx bx-volume-mute';
    else if (val < 50) volIcon.className = 'bx bx-volume-low';
    else volIcon.className = 'bx bx-volume-full';
});

/* --- UPLOAD UI HELPER --- */
function handleFileUpload(input) {
    /* Display the selected filename to the user */
    if (input.files.length > 0) {
        document.getElementById('file-name').textContent = input.files[0].name;
    }
}

/* --- HELPER: Fetch Art from Web (Smart Search) --- */
async function fetchWebCover(artist, title) {
    // 1. Clean the title of common YouTube "junk"
    // Removes: (Official Video), [Lyrics], .mp3, Visualizer, etc.
    let cleanTitle = title
        .replace(/\(.*\)/g, "")           // Remove anything in parentheses
        .replace(/\[.*\]/g, "")           // Remove anything in brackets
        .replace(/\.mp3$/i, "")           // Remove file extension
        .replace(/official\s+video/gi, "")
        .replace(/visuali[sz]er/gi, "")
        .replace(/lyrics/gi, "")
        .trim();

    // 2. Heuristic: If artist is unknown, try to extract it from the title
    // Example: "Campbell - Would You" -> Artist: Campbell, Title: Would You
    if ((!artist || artist === "Unknown Artist") && cleanTitle.includes('-')) {
        const parts = cleanTitle.split('-');
        if (parts.length >= 2) {
            artist = parts[0].trim();
            cleanTitle = parts.slice(1).join(' ').trim();
        }
    }

    // 3. Build Query
    // If we extracted a real artist, use it. Otherwise search just the title.
    let queryTerm = cleanTitle;
    if (artist && artist !== "Unknown Artist") {
        queryTerm = `${artist} ${cleanTitle}`;
    }

    try {
        const query = encodeURIComponent(queryTerm);
        // Fetch from iTunes
        const response = await fetch(`https://itunes.apple.com/search?term=${query}&media=music&limit=1`);
        const data = await response.json();

        if (data.resultCount > 0) {
            // Return high-res image (600x600)
            return data.results[0].artworkUrl100.replace('100x100bb', '600x600bb');
        }
    } catch (error) {
        // Fail silently
    }
    return null;
}

function triggerHeartConfetti(element) {
    const rect = element.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;

    /* Create 30 floating heart particles */
    for (let i = 0; i < 30; i++) {
        const heart = document.createElement('div');
        heart.className = 'particle';
        heart.innerHTML = "<i class='bx bxs-heart'></i>";
        heart.style.color = `hsl(${330 + Math.random() * 20}, 100%, 70%)`; // Pink variations

        document.body.appendChild(heart);

        /* Random spread values for particle animation */
        const tx = (Math.random() - 0.5) * 200 + 'px';
        const rot = (Math.random() - 0.5) * 360 + 'deg';

        heart.style.setProperty('--tx', tx);
        heart.style.setProperty('--rot', rot);

        heart.style.left = `${centerX}px`;
        heart.style.top = `${centerY}px`;

        /* Remove particle after animation completes */
        setTimeout(() => {
            heart.remove();
        }, 1500);
    }
}