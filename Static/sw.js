const CACHE_NAME = 'streamify-app-shell-v30';
const MEDIA_CACHE_NAME = 'streamify-media-cache';

// Assets to cache immediately
const APP_SHELL = [
  '/home',
  '/manifest.json',
  '/favicon.ico',
  '/Static/icon-192.png',
  '/Static/icon-512.png',
  'https://unpkg.com/boxicons@2.1.4/css/boxicons.min.css',
  'https://fonts.googleapis.com/css2?family=Outfit:wght@100..900&display=swap'
];

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(APP_SHELL).catch(err => {
        console.warn('[SW] App Shell partial cache:', err);
      });
    })
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
  // Clean up old caches
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.map(key => {
        if (key !== CACHE_NAME && key !== MEDIA_CACHE_NAME) {
          return caches.delete(key);
        }
      })
    ))
  );
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // 1. Handle API requests
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io/')) {
    if (event.request.method === 'GET' && url.pathname.startsWith('/api/playlists')) {
      // Cache playlists metadata so it works offline
      event.respondWith(
        fetch(event.request).then(async networkResponse => {
          if (networkResponse.ok) {
            const cacheCopy = networkResponse.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, cacheCopy));
            return networkResponse;
          } else if (networkResponse.status === 304) {
            const cached = await caches.match(event.request);
            return cached || networkResponse;
          }
          return networkResponse;
        }).catch(() => {
          return caches.match(event.request);
        })
      );
      return;
    }
    // Other API requests pass through
    return;
  }

  // 2. Handle Media Files & Range Requests
  if (event.request.method === 'GET' && (url.pathname.startsWith('/MusicLibrary/') || url.pathname.startsWith('/Static/'))) {
    // For seek operations (Range header present): bypass ALL caches — both the SW
    // media cache and the browser HTTP cache. If the HTTP cache returns a full 200
    // response to a Range request, the audio element stalls waiting for partial data.
    if (event.request.headers.get('Range')) {
      event.respondWith(fetch(new Request(event.request, { cache: 'no-store' })));
      return;
    }
    event.respondWith(handleMediaRequest(event.request));
    return;
  }

  // 3. Network-First for App Shell & other static assets
  if (event.request.method === 'GET' && url.protocol.startsWith('http')) {
    event.respondWith(
      fetch(event.request).then(networkResponse => {
        // If we got a valid response, update the cache
        if (networkResponse && networkResponse.status === 200) {
          const cacheCopy = networkResponse.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, cacheCopy));
        }
        return networkResponse;
      }).catch(async () => {
        const cachedResponse = await caches.match(event.request, { ignoreSearch: true });
        if (cachedResponse) return cachedResponse;

        // Offline fallback
        if (url.pathname === '/' || url.pathname === '/home') {
          return caches.match('/home', { ignoreSearch: true });
        }

        // Return an empty SVG for images so it doesn't break image tags
        if (event.request.destination === 'image') {
          return new Response('<svg width="1" height="1" xmlns="http://www.w3.org/2000/svg"></svg>', {
            headers: { 'Content-Type': 'image/svg+xml' }
          });
        }

        // Return a generic error response instead of undefined
        return new Response('Network error happened', { status: 408, headers: { 'Content-Type': 'text/plain' } });
      })
    );
  }
});

// Range request handling function
async function handleMediaRequest(request) {
  const cache = await caches.open(MEDIA_CACHE_NAME);

  // Try matching directly first
  let cachedResponse = await cache.match(request, { ignoreSearch: true, ignoreVary: true });

  if (!cachedResponse) {
    // If not found, try matching by checking all keys in the cache manually.
    // This is the most reliable fallback if the browser alters the Request object.
    const url = new URL(request.url);
    const keys = await cache.keys();
    for (const key of keys) {
      const keyUrl = new URL(key.url);
      if (keyUrl.pathname === url.pathname || decodeURIComponent(keyUrl.pathname) === decodeURIComponent(url.pathname)) {
        cachedResponse = await cache.match(key, { ignoreSearch: true, ignoreVary: true });
        break;
      }
    }
  }

  if (!cachedResponse) {
    // If not in media cache, check the app shell cache just in case (e.g. for CSS/JS)
    const shellCache = await caches.open(CACHE_NAME);
    const shellMatch = await shellCache.match(request, { ignoreSearch: true, ignoreVary: true });
    if (shellMatch) return shellMatch;

    // Fallback to network
    return fetch(request);
  }

  // If there's no Range header, return the full cached response
  const rangeHeader = request.headers.get('Range');
  if (!rangeHeader) {
    return cachedResponse;
  }

  // For large files (FLAC, WAV, etc.) loading the whole ArrayBuffer just to slice it
  // can freeze the SW and cause seeking to hang. Fall back to network so the server's
  // native Range/206 support handles it efficiently.
  const contentLength = parseInt(cachedResponse.headers.get('Content-Length') || '0', 10);
  if (contentLength > 10 * 1024 * 1024) { // 10 MB threshold
    return fetch(request);
  }

  // Parse Range header (e.g., "bytes=0-1024")
  const buffer = await cachedResponse.arrayBuffer();
  const bytes = rangeHeader.match(/bytes=(\d+)-(\d+)?/);
  const start = Number(bytes[1]);
  const end = bytes[2] ? Number(bytes[2]) : buffer.byteLength - 1;

  // Sliced buffer for 206 response
  const chunk = buffer.slice(start, end + 1);

  return new Response(chunk, {
    status: 206,
    statusText: 'Partial Content',
    headers: new Headers({
      'Content-Type': cachedResponse.headers.get('Content-Type') || 'audio/mpeg',
      'Content-Range': `bytes ${start}-${end}/${buffer.byteLength}`,
      'Content-Length': chunk.byteLength,
      'Accept-Ranges': 'bytes'
    })
  });
}

// Background Fetch success handler
self.addEventListener('backgroundfetchsuccess', event => {
  const bgFetch = event.registration;

  event.waitUntil(async function () {
    const cache = await caches.open(MEDIA_CACHE_NAME);
    const records = await bgFetch.matchAll();

    const promises = records.map(async record => {
      const response = await record.responseReady;
      await cache.put(record.request, response);
    });

    await Promise.all(promises);

    // Notify clients that download finished
    const clients = await self.clients.matchAll();
    clients.forEach(client => {
      client.postMessage({
        type: 'DOWNLOAD_COMPLETE',
        id: bgFetch.id // We can use the song ID as the fetch ID
      });
    });
  }());
});
