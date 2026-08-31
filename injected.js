/**
 * StreamSniffer Pro — Quantum Main-World Network & DOM Interceptor
 */
(function () {
  'use strict';

  if (window.__STREAM_SNIFFER_INJECTED__) return;
  window.__STREAM_SNIFFER_INJECTED__ = true;

  const authVault = new Map();

  function normalizeStreamKey(rawUrl) {
    try {
      const u = new URL(rawUrl, window.location.href);
      return u.origin + u.pathname;
    } catch (e) {
      return String(rawUrl).split('?')[0];
    }
  }

  function isPlaylistOrManifest(url) {
    if (!url || typeof url !== 'string') return false;
    return /\.(m3u8|mpd)(\?.*)?$/i.test(url) ||
           url.includes('manifest.mpd') ||
           url.includes('playlist.m3u8') ||
           url.includes('/hls/') ||
           url.includes('/dash/');
  }

  function isMediaResource(url) {
    if (!url || typeof url !== 'string') return false;
    return /\.(m3u8|mpd|mp4|webm|m4v|mov|m4s|ts|aac|mp3|m4a|ogg|opus|flac|wav)(\?.*)?$/i.test(url);
  }

  function extractHeaders(headersObj) {
    const headers = {};
    if (!headersObj) return headers;
    try {
      if (headersObj instanceof Headers) {
        headersObj.forEach((val, key) => { headers[key.toLowerCase()] = val; });
      } else if (Array.isArray(headersObj)) {
        headersObj.forEach(([k, v]) => { if (k) headers[k.toLowerCase()] = v; });
      } else if (typeof headersObj === 'object') {
        Object.entries(headersObj).forEach(([k, v]) => { if (k) headers[k.toLowerCase()] = String(v); });
      }
    } catch (e) {}
    return headers;
  }

  function saveAuth(url, headers) {
    if (!url) return;
    const key = normalizeStreamKey(url);
    const domainKey = (function () {
      try { return new URL(url, window.location.href).hostname; } catch (e) { return 'global'; }
    })();

    const payload = { url, headers: headers || {}, timestamp: Date.now() };
    authVault.set(key, payload);
    authVault.set(domainKey, payload);
    authVault.set('latest', payload);
  }

  function notifyMediaDetected(url, type, quality, size) {
    try {
      if (!url || typeof url !== 'string' || url.startsWith('blob:') || url.startsWith('data:')) return;
      const fullUrl = new URL(url, window.location.href).href;
      window.postMessage({
        type: 'QBIT_MEDIA_DETECTED',
        url: fullUrl,
        mediaType: type || 'STREAM',
        quality: quality || 'Auto',
        sizeBytes: size || 0,
        pageTitle: document.title || 'Media Stream',
        origin: window.location.origin
      }, '*');
    } catch (e) {}
  }

  // 1. Hook window.fetch
  try {
    const originalFetch = window.fetch;
    window.fetch = async function (...args) {
      let requestUrl = '';
      let requestHeaders = {};

      try {
        const input = args[0];
        const init = args[1] || {};

        if (typeof input === 'string') {
          requestUrl = input;
        } else if (input instanceof URL) {
          requestUrl = input.href;
        } else if (input && typeof input === 'object' && 'url' in input) {
          requestUrl = input.url;
          if (input.headers) {
            Object.assign(requestHeaders, extractHeaders(input.headers));
          }
        }

        if (init.headers) {
          Object.assign(requestHeaders, extractHeaders(init.headers));
        }

        if (isMediaResource(requestUrl)) {
          saveAuth(requestUrl, requestHeaders);
          if (isPlaylistOrManifest(requestUrl)) {
            notifyMediaDetected(requestUrl, requestUrl.includes('.mpd') ? 'MPD' : 'M3U8');
          }
        }
      } catch (e) {}

      const response = await originalFetch.apply(this, args);

      try {
        if (response && response.ok) {
          const respUrl = response.url || requestUrl;
          const contentType = response.headers ? response.headers.get('content-type') || '' : '';
          
          if (isMediaResource(respUrl) || contentType.includes('mpegurl') || contentType.includes('dash+xml')) {
            saveAuth(respUrl, requestHeaders);
            if (isPlaylistOrManifest(respUrl) || contentType.includes('mpegurl') || contentType.includes('dash+xml')) {
              notifyMediaDetected(respUrl, (respUrl.includes('.mpd') || contentType.includes('dash+xml')) ? 'MPD' : 'M3U8');
            }
          }
        }
      } catch (e) {}

      return response;
    };
  } catch (e) {}

  // 2. Hook XMLHttpRequest
  try {
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
    const originalSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      this.__sniffUrl = url;
      this.__sniffHeaders = {};
      return originalOpen.apply(this, [method, url, ...rest]);
    };

    XMLHttpRequest.prototype.setRequestHeader = function (header, value) {
      if (this.__sniffHeaders && header) {
        this.__sniffHeaders[header.toLowerCase()] = value;
      }
      return originalSetRequestHeader.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function (...args) {
      try {
        const url = this.__sniffUrl;
        if (url && isMediaResource(url)) {
          saveAuth(url, this.__sniffHeaders);
          if (isPlaylistOrManifest(url)) {
            notifyMediaDetected(url, url.includes('.mpd') ? 'MPD' : 'M3U8');
          }
        }
      } catch (e) {}
      return originalSend.apply(this, args);
    };
  } catch (e) {}

  // 3. Hook HTMLMediaElement
  try {
    const originalPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      try {
        const src = this.currentSrc || this.src;
        if (src && typeof src === 'string' && src.startsWith('http')) {
          notifyMediaDetected(src, isPlaylistOrManifest(src) ? 'M3U8' : 'VIDEO');
        }
      } catch (e) {}
      return originalPlay.apply(this, arguments);
    };

    const srcDescriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
    if (srcDescriptor && srcDescriptor.set) {
      const originalSrcSet = srcDescriptor.set;
      Object.defineProperty(HTMLMediaElement.prototype, 'src', {
        set: function (val) {
          try {
            if (val && typeof val === 'string' && val.startsWith('http')) {
              notifyMediaDetected(val, isPlaylistOrManifest(val) ? 'M3U8' : 'VIDEO');
            }
          } catch (e) {}
          return originalSrcSet.call(this, val);
        },
        get: srcDescriptor.get,
        configurable: true,
        enumerable: true
      });
    }
  } catch (e) {}

  // 4. Token & Header Handshake Relay
  window.addEventListener('message', (event) => {
    try {
      if (event.source !== window || !event.data) return;

      if (event.data.type === 'REQUEST_NEW_TOKEN') {
        const targetUrl = event.data.streamUrl || '';
        const key = normalizeStreamKey(targetUrl);
        let domainKey = '';
        try { domainKey = new URL(targetUrl).hostname; } catch (e) {}

        const auth = authVault.get(key) ||
                     (domainKey ? authVault.get(domainKey) : null) ||
                     authVault.get('latest') ||
                     { url: targetUrl, headers: {} };

        window.postMessage({
          type: 'NEW_TOKEN_EXTRACTED',
          callbackId: event.data.callbackId,
          authData: auth
        }, '*');
      }
    } catch (e) {}
  });
})();