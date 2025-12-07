
const CACHE_NAME = 'streamify-v3';
const ASSETS_TO_CACHE = [
    '/home',
    '/Static/home/css/home.css',
    '/Static/home/css/home_mobile.css',
    '/Static/home/js/home-api.js',
    '/Static/masc_logo.png',
    'https://unpkg.com/boxicons@2.1.4/css/boxicons.min.css'
];

// Install Event
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return cache.addAll(ASSETS_TO_CACHE);
        })
    );
});

// Activate Event
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames.map((cache) => {
                    if (cache !== CACHE_NAME) {
                        return caches.delete(cache);
                    }
                })
            );
        })
    );
});

// Fetch Event
self.addEventListener('fetch', (event) => {
    // API requests: Network First, fallback to nothing/offline handling
    if (event.request.url.includes('/api/')) {
        event.respondWith(
            fetch(event.request)
                .catch(() => {
                    // Start of offline handling for API
                    // Return empty json or similar if needed
                    return new Response(JSON.stringify({ error: "offline" }), {
                        headers: { 'Content-Type': 'application/json' }
                    });
                })
        );
        return;
    }

    // Navigation (HTML): Network First, fallback to cached /home ? 
    // Actually for SPA feel, we might want Cache First but it's dynamic.
    // Let's go Stale-While-Revalidate for static assets, Network First for HTML.

    if (event.request.mode === 'navigate') {
        event.respondWith(
            fetch(event.request).catch(() => {
                return caches.match('/home');
            })
        );
        return;
    }

    // Static Assets: Cache First
    event.respondWith(
        caches.match(event.request).then((response) => {
            return response || fetch(event.request);
        })
    );
});
