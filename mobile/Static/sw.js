// Bump this whenever cached app-shell assets change. Old shell caches are
// removed during activation so clients cannot retain stale CSS or JavaScript.
const CACHE_NAME = 'streamify-app-shell-v93';
const MEDIA_CACHE_PREFIX = 'streamify-media-cache-';
const OFFLINE_STATE_CACHE_NAME = 'streamify-offline-state-v1';
const ACTIVE_USER_STATE_URL = '/__streamify_offline_state__/active-user';

const APP_SHELL = [
  '/home',
  '/manifest.json',
  '/favicon.ico',
  '/Static/icon-192.png',
  '/Static/icon-512.png',
  '/Static/home/css/base.css?v=4.22',
  '/Static/home/css/layout.css?v=4.45',
  '/Static/home/css/components.css?v=4.10',
  '/Static/home/css/upload.css?v=4.10',
  '/Static/home/css/player.css?v=4.42',
  '/Static/home/css/modals.css?v=4.52',
  '/Static/home/css/library.css?v=4.38',
  '/Static/home/css/downloads.css?v=4.34',
  '/Static/home/css/profile.css?v=4.10',
  '/Static/home/css/toasts.css?v=4.8',
'/Static/home/css/home_mobile.css?v=4.26',
  '/Static/vendor/boxicons/boxicons.min.css?v=4.8',
  '/Static/vendor/boxicons/fonts/boxicons.eot',
  '/Static/vendor/boxicons/fonts/boxicons.woff2',
  '/Static/vendor/boxicons/fonts/boxicons.woff',
  '/Static/vendor/boxicons/fonts/boxicons.ttf',
  '/Static/vendor/boxicons/fonts/boxicons.svg',
  '/Static/vendor/fonts/outfit.css?v=4.8',
  '/Static/vendor/fonts/outfit-latin.woff2',
  '/Static/vendor/fonts/outfit-latin-ext.woff2',
  '/Static/vendor/fonts/plus-jakarta-sans.css?v=4.44',
  '/Static/vendor/fonts/PlusJakartaSans-VariableFont_wght.ttf',
  '/Static/home/js/experiments.js?v=4.35',
'/Static/home/js/theme.js?v=4.36',
  '/Static/vendor/cropperjs/cropper.min.css?v=4.8',
  '/Static/home/js/config.js?v=4.22',
  '/Static/vendor/cropperjs/cropper.min.js?v=4.8',
  '/Static/home/js/offline.js?v=4.38',
  '/Static/home/js/discord.js?v=4.33',
  '/Static/home/js/updates.js?v=4.46',
  '/Static/home/js/player.js?v=4.43',
  '/Static/home/js/api_v2.js?v=4.42',
  '/Static/home/js/downloads.js?v=4.44',
  '/Static/home/js/ui.js?v=4.51'
];

let activeUserKey;
let activeUserLoadPromise = null;

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(APP_SHELL);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map(key => {
      const keep = key === CACHE_NAME ||
        key === OFFLINE_STATE_CACHE_NAME ||
        key.startsWith(MEDIA_CACHE_PREFIX);
      return keep ? Promise.resolve(false) : caches.delete(key);
    }));
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if (!event.data || typeof event.data.type !== 'string') return;

  if (event.data.type === 'SET_CURRENT_USER') {
    event.waitUntil(setActiveUser(event.data.username));
  } else if (event.data.type === 'CLEAR_ACTIVE_USER') {
    event.waitUntil(setActiveUser(null));
  }
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  const isSameOrigin = url.origin === self.location.origin;

  // Downloaded streams are API URLs, so this must run before generic API
  // passthrough. Only GETs are eligible for CacheStorage matching.
  if (isSameOrigin && request.method === 'GET' && /^\/api\/stream\/[^/]+\/?$/.test(url.pathname)) {
    event.respondWith(handleMediaRequest(request));
    return;
  }

  // API and socket traffic remains network-owned. Metadata intended for
  // offline use is stored explicitly in IndexedDB by offline.js.
  if (isSameOrigin && (url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io/'))) {
    return;
  }

  const isUserMedia =
    url.pathname.startsWith('/MusicLibrary/') ||
    url.pathname.startsWith('/Static/covers/') ||
    url.pathname.startsWith('/Static/avatars/') ||
    url.pathname.startsWith('/Static/banners/');
  const isMediaDestination =
    request.destination === 'audio' ||
    request.destination === 'video' ||
    request.destination === 'image';

  if (isSameOrigin && request.method === 'GET' && (isUserMedia || isMediaDestination)) {
    event.respondWith(handleMediaRequest(request));
    return;
  }

  const isAppNavigation = request.mode === 'navigate' && isSameOrigin && (
    url.pathname === '/' ||
    url.pathname === '/home' ||
    url.pathname.startsWith('/profile/')
  );

  if (isAppNavigation) {
    const networkPromise = fetch(request);
    const cacheUpdate = networkPromise.then(response => {
      if (url.pathname !== '/home' || !response.ok) return;
      return caches.open(CACHE_NAME).then(cache => cache.put('/home', response.clone()));
    }).catch(() => undefined);

    event.waitUntil(cacheUpdate);
    event.respondWith(networkPromise.catch(async () => {
      const cache = await caches.open(CACHE_NAME);
      return await cache.match('/home') || offlineResponse('App shell is not available offline');
    }));
    return;
  }

  // Network-first for app-shell assets. Exact query matching preserves the
  // versioning contract used by home.html instead of serving an older asset.
  if (isSameOrigin && request.method === 'GET' && url.protocol.startsWith('http')) {
    const networkPromise = fetch(request);
    const shouldCache = url.pathname.startsWith('/Static/') ||
      url.pathname === '/manifest.json' ||
      url.pathname === '/favicon.ico';
    const cacheUpdate = networkPromise.then(response => {
      if (!shouldCache || !response.ok) return;
      return caches.open(CACHE_NAME).then(cache => cache.put(request, response.clone()));
    }).catch(() => undefined);

    event.waitUntil(cacheUpdate);
    event.respondWith(networkPromise.catch(async () => {
      const cache = await caches.open(CACHE_NAME);
      const cachedResponse = await cache.match(request);
      if (cachedResponse) return cachedResponse;

      if (request.destination === 'image') {
        return new Response('<svg width="1" height="1" xmlns="http://www.w3.org/2000/svg"></svg>', {
          headers: { 'Content-Type': 'image/svg+xml' }
        });
      }

      return offlineResponse('Network resource is not available offline');
    }));
  }
});

function normalizeUsername(username) {
  if (typeof username !== 'string') return null;
  const normalized = username.trim().toLowerCase();
  return normalized || null;
}

function getMediaCacheName(username) {
  return `${MEDIA_CACHE_PREFIX}${encodeURIComponent(username)}`;
}

async function getActiveUser() {
  if (activeUserKey !== undefined) return activeUserKey;
  if (activeUserLoadPromise) return activeUserLoadPromise;

  activeUserLoadPromise = (async () => {
    try {
      const cache = await caches.open(OFFLINE_STATE_CACHE_NAME);
      const response = await cache.match(ACTIVE_USER_STATE_URL);
      if (!response) {
        activeUserKey = null;
        return null;
      }
      const state = await response.json();
      activeUserKey = normalizeUsername(state.username);
      return activeUserKey;
    } catch (error) {
      console.warn('[SW] Could not restore the active offline user:', error);
      activeUserKey = null;
      return null;
    } finally {
      activeUserLoadPromise = null;
    }
  })();

  return activeUserLoadPromise;
}

async function setActiveUser(username) {
  const normalized = normalizeUsername(username);
  activeUserKey = normalized;
  activeUserLoadPromise = null;

  const cache = await caches.open(OFFLINE_STATE_CACHE_NAME);
  if (!normalized) {
    await cache.delete(ACTIVE_USER_STATE_URL);
    return;
  }

  await cache.put(ACTIVE_USER_STATE_URL, new Response(JSON.stringify({ username: normalized }), {
    headers: { 'Content-Type': 'application/json' }
  }));
}

async function handleMediaRequest(request) {
  const userKey = await getActiveUser();
  let cachedResponse = null;

  if (userKey) {
    const userCache = await caches.open(getMediaCacheName(userKey));
    cachedResponse = await userCache.match(request, { ignoreVary: true });

  }

  if (!cachedResponse) {
    const shellCache = await caches.open(CACHE_NAME);
    cachedResponse = await shellCache.match(request, { ignoreVary: true });
  }

  if (!cachedResponse) return fetchMediaFromNetwork(request);

  const rangeHeader = request.headers.get('Range');
  if (!rangeHeader) return cachedResponse;

  if (cachedResponse.status !== 200 || !cachedResponse.body) {
    return fetchMediaFromNetwork(request);
  }

  const contentLengthHeader = cachedResponse.headers.get('Content-Length');
  const totalLength = Number(contentLengthHeader);
  if (!contentLengthHeader || !Number.isSafeInteger(totalLength) || totalLength <= 0) {
    return fetchMediaFromNetwork(request);
  }

  const range = parseSingleRange(rangeHeader, totalLength);
  if (!range) return rangeNotSatisfiable(totalLength);

  const headers = new Headers(cachedResponse.headers);
  headers.delete('Content-Encoding');
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Content-Range', `bytes ${range.start}-${range.end}/${totalLength}`);
  headers.set('Content-Length', String(range.end - range.start + 1));

  return new Response(createRangeStream(cachedResponse.body, range.start, range.end), {
    status: 206,
    statusText: 'Partial Content',
    headers
  });
}

function parseSingleRange(header, totalLength) {
  if (totalLength <= 0 || typeof header !== 'string' || header.includes(',')) return null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return null;

  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null;
    return {
      start: Math.max(totalLength - suffixLength, 0),
      end: totalLength - 1
    };
  }

  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : totalLength - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) ||
      start >= totalLength || requestedEnd < start) {
    return null;
  }

  return { start, end: Math.min(requestedEnd, totalLength - 1) };
}

function createRangeStream(body, start, end) {
  const reader = body.getReader();
  let sourceOffset = 0;
  let finished = false;

  return new ReadableStream({
    async pull(controller) {
      if (finished) return;

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          finished = true;
          controller.close();
          return;
        }

        const chunkStart = sourceOffset;
        const chunkEnd = sourceOffset + value.byteLength - 1;
        sourceOffset += value.byteLength;

        if (chunkEnd < start) continue;
        if (chunkStart > end) {
          finished = true;
          reader.cancel().catch(() => undefined);
          controller.close();
          return;
        }

        const from = Math.max(start - chunkStart, 0);
        const to = Math.min(end - chunkStart + 1, value.byteLength);
        controller.enqueue(value.subarray(from, to));

        if (chunkEnd >= end) {
          finished = true;
          reader.cancel().catch(() => undefined);
          controller.close();
        }
        return;
      }
    },
    cancel(reason) {
      finished = true;
      return reader.cancel(reason);
    }
  });
}

async function fetchMediaFromNetwork(request) {
  try {
    const networkRequest = request.headers.has('Range')
      ? new Request(request, { cache: 'no-store' })
      : request;
    return await fetch(networkRequest);
  } catch (error) {
    return offlineResponse('Media is not available offline');
  }
}

function rangeNotSatisfiable(totalLength) {
  return new Response(null, {
    status: 416,
    statusText: 'Range Not Satisfiable',
    headers: {
      'Accept-Ranges': 'bytes',
      'Content-Range': `bytes */${totalLength}`
    }
  });
}

function offlineResponse(message) {
  return new Response(message, {
    status: 503,
    statusText: 'Service Unavailable',
    headers: { 'Content-Type': 'text/plain' }
  });
}

self.addEventListener('backgroundfetchsuccess', event => {
  event.waitUntil((async () => {
    const userKey = await getActiveUser();
    if (!userKey) throw new Error('Cannot commit a background download without an active user');

    const cache = await caches.open(getMediaCacheName(userKey));
    const records = await event.registration.matchAll();
    for (const record of records) {
      const response = await record.responseReady;
      await cache.put(record.request, response);
    }

    const clients = await self.clients.matchAll({ includeUncontrolled: true });
    for (const client of clients) {
      client.postMessage({
        type: 'DOWNLOAD_COMPLETE',
        id: event.registration.id
      });
    }
  })());
});
