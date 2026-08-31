/**
 * StreamSniffer Pro — Quantum Isolated-World Bridge & DOM Harvester
 */
(function () {
  'use strict';

  function safeSendMessage(message) {
    if (!chrome.runtime?.id) return;
    try {
      chrome.runtime.sendMessage(message, () => {
        if (chrome.runtime.lastError) {}
      });
    } catch (e) {}
  }

  function extractPageMetadata() {
    let title = document.title || '';
    const ogTitle = document.querySelector('meta[property="og:title"]')?.getAttribute('content');
    if (ogTitle) title = ogTitle;
    const h1 = document.querySelector('h1')?.innerText?.trim();
    if (!title && h1) title = h1;
    return {
      title: title || 'Web Stream',
      url: window.location.href,
      origin: window.location.origin
    };
  }

  function scanDomMedia() {
    const meta = extractPageMetadata();
    const mediaElements = document.querySelectorAll('video, audio, source');
    mediaElements.forEach(el => {
      const src = el.src || el.getAttribute('src');
      if (src && typeof src === 'string' && src.startsWith('http') && !src.startsWith('blob:')) {
        const isHls = src.includes('.m3u8');
        const isDash = src.includes('.mpd');
        const isAudio = el.tagName.toLowerCase() === 'audio' || /\.(mp3|m4a|aac|ogg|wav)$/i.test(src);
        
        let type = 'VIDEO';
        if (isHls) type = 'M3U8';
        else if (isDash) type = 'MPD';
        else if (isAudio) type = 'AUDIO';

        safeSendMessage({
          action: 'hookDetected',
          media: {
            url: src,
            type: type,
            title: meta.title,
            origin: meta.origin
          }
        });
      }
    });
  }

  window.addEventListener('message', (event) => {
    try {
      if (event.source !== window || !event.data) return;

      if (event.data.type === 'QBIT_MEDIA_DETECTED' && event.data.url) {
        const meta = extractPageMetadata();
        safeSendMessage({
          action: 'hookDetected',
          media: {
            url: event.data.url,
            type: event.data.mediaType || 'VIDEO',
            quality: event.data.quality || 'Auto',
            sizeBytes: event.data.sizeBytes || 0,
            title: event.data.pageTitle || meta.title,
            origin: event.data.origin || meta.origin
          }
        });
      }

      if (event.data.type === 'NEW_TOKEN_EXTRACTED') {
        safeSendMessage({
          action: 'NEW_TOKEN_EXTRACTED',
          callbackId: event.data.callbackId,
          authData: event.data.authData
        });
      }
    } catch (e) {}
  });

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'GET_NEW_TOKEN') {
      window.postMessage({
        type: 'REQUEST_NEW_TOKEN',
        callbackId: request.callbackId,
        streamUrl: request.streamUrl
      }, '*');
      sendResponse({ status: 'TOKEN_REQUESTED' });
    }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scanDomMedia);
  } else {
    scanDomMedia();
  }

  const observer = new MutationObserver(() => {
    scanDomMedia();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();