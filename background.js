/**
 * StreamSniffer Pro — Quantum Background Coordinator & Lifecycle Nexus
 */

const tabWriteQueues = new Map();
const activeAssemblies = new Map();
const streamTabRegistry = new Map();
const pendingBlobDownloads = new Map();

let offscreenPort = null;
let creatingOffscreen = null;

function normalizeUrlKey(rawUrl) {
  try {
    const u = new URL(rawUrl);
    u.searchParams.delete('range');
    u.searchParams.delete('sq');
    u.searchParams.delete('rn');
    u.searchParams.delete('_');
    u.searchParams.delete('t');
    u.searchParams.delete('ts');
    return u.toString();
  } catch (e) {
    return String(rawUrl).split('?')[0];
  }
}

function isSegmentOrChunk(url) {
  if (!url || typeof url !== 'string') return false;
  return /\.(ts|m4s|aac|key)(\?.*)?$/i.test(url) ||
         url.includes('/frag/') ||
         url.includes('/segment') ||
         url.includes('seg-') ||
         url.includes('/chunk-') ||
         /bytes=[0-9]+-[0-9]+/i.test(url);
}

function parseResolution(url) {
  const match = url.match(/(2160p|4k|1440p|2k|1080p|720p|480p|360p|240p|_1080|_720|_480)/i);
  return match ? match[0].replace(/[_p]/g, '') + 'p' : 'Adaptive';
}

function queueTabWrite(tabId, task) {
  const prev = tabWriteQueues.get(tabId) || Promise.resolve();
  const next = prev.then(task).catch(err => {
    console.error(`[StreamSniffer] Storage error tab ${tabId}:`, err);
  });
  tabWriteQueues.set(tabId, next);
  return next;
}

async function registerMedia(tabId, media) {
  if (!tabId || tabId < 0 || !media || !media.url) return;
  if (isSegmentOrChunk(media.url)) return;

  await queueTabWrite(tabId, async () => {
    const key = `media_${tabId}`;
    const store = await chrome.storage.session.get(key);
    const mediaMap = store[key] || {};
    const dedupeKey = normalizeUrlKey(media.url);

    const keys = Object.keys(mediaMap);
    if (keys.length > 50) delete mediaMap[keys[0]];

    if (!mediaMap[dedupeKey]) {
      const ext = media.extension || (media.type === 'AUDIO' ? 'mp3' : 'mp4');
      mediaMap[dedupeKey] = {
        id: `media_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        url: media.url,
        type: media.type || 'VIDEO',
        extension: ext,
        sizeBytes: media.sizeBytes || 0,
        quality: media.quality || parseResolution(media.url),
        title: media.title || 'Web Media Stream',
        origin: media.origin || '',
        tabId: tabId,
        timestamp: Date.now()
      };
      await chrome.storage.session.set({ [key]: mediaMap });
      const count = Object.keys(mediaMap).length;
      chrome.action.setBadgeText({ tabId, text: String(count) });
      chrome.action.setBadgeBackgroundColor({ tabId, color: '#0ea5e9' });
    }
  });
}

chrome.webRequest.onResponseStarted.addListener(
  async (details) => {
    if (details.tabId <= 0) return;
    const url = details.url;
    if (isSegmentOrChunk(url)) return;

    const headers = details.responseHeaders || [];
    let contentLength = 0;
    let contentType = '';

    headers.forEach(h => {
      const name = h.name.toLowerCase();
      if (name === 'content-length') contentLength = parseInt(h.value, 10);
      if (name === 'content-type') contentType = h.value.toLowerCase();
    });

    const isHls = contentType.includes('mpegurl') || url.includes('.m3u8');
    const isDash = contentType.includes('dash+xml') || url.includes('.mpd');
    const isVideo = contentType.includes('video/') || /\.(mp4|webm|mkv|mov|m4v)(\?.*)?$/i.test(url);
    const isAudio = contentType.includes('audio/') || /\.(mp3|m4a|aac|ogg|wav|opus|flac)(\?.*)?$/i.test(url);

    if (isHls || isDash || isVideo || isAudio) {
      let type = 'VIDEO';
      let ext = 'mp4';
      if (isHls) { type = 'M3U8'; ext = 'm3u8'; }
      else if (isDash) { type = 'MPD'; ext = 'mpd'; }
      else if (isAudio) { type = 'AUDIO'; ext = contentType.includes('mp3') ? 'mp3' : 'm4a'; }

      await registerMedia(details.tabId, {
        url,
        type,
        extension: ext,
        sizeBytes: contentLength,
        quality: parseResolution(url),
        origin: details.initiator || '',
        title: 'Detected Stream'
      });
    }
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(`media_${tabId}`);
  tabWriteQueues.delete(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading' && changeInfo.url) {
    chrome.storage.session.remove(`media_${tabId}`);
    chrome.action.setBadgeText({ tabId, text: '' });
  }
});

async function ensureOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL('offscreen.html');
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [offscreenUrl]
  });

  if (existingContexts.length > 0) return;
  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }

  creatingOffscreen = chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['WORKERS', 'BLOBS'],
    justification: 'High-throughput in-order OPFS assembly and AES-128 decryption.'
  });

  await creatingOffscreen;
  creatingOffscreen = null;
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'qbit_keepalive') {
    offscreenPort = port;
    port.onDisconnect.addListener(() => {
      offscreenPort = null;
    });
    port.onMessage.addListener((msg) => {
      if (msg.action === 'PONG') {}
    });
  }
});

function keepAliveHeartbeat() {
  if (activeAssemblies.size > 0) {
    chrome.alarms.create('sw_keepalive_alarm', { periodInMinutes: 0.5 });
    if (offscreenPort) {
      try { offscreenPort.postMessage({ action: 'PING' }); } catch (e) {}
    }
  } else {
    chrome.alarms.clear('sw_keepalive_alarm');
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'sw_keepalive_alarm') {
    keepAliveHeartbeat();
  }
});

chrome.downloads.onChanged.addListener((delta) => {
  if (delta.state && (delta.state.current === 'complete' || delta.state.current === 'interrupted')) {
    const meta = pendingBlobDownloads.get(delta.id);
    if (meta) {
      URL.revokeObjectURL(meta.blobUrl);
      if (meta.tempId) {
        chrome.runtime.sendMessage({
          action: 'cleanupTempFile',
          tempId: meta.tempId
        }).catch(() => {});
      }
      pendingBlobDownloads.delete(delta.id);
    }
  }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'hookDetected') {
    const tabId = sender.tab ? sender.tab.id : null;
    if (tabId && request.media) {
      registerMedia(tabId, request.media);
    }
    return;
  }

  if (request.action === 'REFRESH_TOKEN') {
    const tabId = streamTabRegistry.get(request.streamId);
    if (tabId) {
      chrome.tabs.sendMessage(tabId, {
        action: 'GET_NEW_TOKEN',
        streamUrl: request.streamUrl,
        callbackId: request.callbackId
      }).catch(() => {});
    }
    return;
  }

  if (request.action === 'NEW_TOKEN_EXTRACTED') {
    chrome.runtime.sendMessage({
      action: 'TOKEN_REFRESHED',
      callbackId: request.callbackId,
      authData: request.authData
    }).catch(() => {});
    return;
  }

  if (request.action === 'getMedia') {
    chrome.storage.session.get(`media_${request.tabId}`).then(store => {
      const mediaList = Object.values(store[`media_${request.tabId}`] || {});
      const ongoingProgress = activeAssemblies.get(request.tabId) || null;
      sendResponse({ media: mediaList, activeAssembly: ongoingProgress });
    });
    return true;
  }

  if (request.action === 'startAssembly') {
    const streamId = `stream_${Date.now()}`;
    if (request.tabId) streamTabRegistry.set(streamId, request.tabId);

    activeAssemblies.set(request.tabId, {
      streamId,
      url: request.url,
      filename: request.filename,
      status: 'START',
      progress: 0
    });
    keepAliveHeartbeat();

    ensureOffscreenDocument().then(() => {
      chrome.runtime.sendMessage({
        action: 'executeOffscreenTask',
        streamId: streamId,
        url: request.url,
        filename: request.filename,
        origin: request.origin,
        tabId: request.tabId
      });
    });
    sendResponse({ status: 'DELEGATED', streamId });
    return true;
  }

  if (request.action === 'assemblyProgress') {
    if (request.tabId && activeAssemblies.has(request.tabId)) {
      const record = activeAssemblies.get(request.tabId);
      record.status = request.status;
      if (request.percent !== undefined) record.progress = request.percent;
      record.speed = request.speed;
      record.mb = request.mb;
      record.done = request.done;
      record.total = request.total;
    }
    return;
  }

  if (request.action === 'assemblyEnded') {
    if (request.tabId) {
      activeAssemblies.delete(request.tabId);
    }
    keepAliveHeartbeat();
    return;
  }

  if (request.action === 'inspectVariants') {
    ensureOffscreenDocument().then(() => {
      chrome.runtime.sendMessage({
        action: 'probeManifestVariants',
        url: request.url,
        id: request.id,
        origin: request.origin
      });
    });
    sendResponse({ status: 'PROBING' });
    return true;
  }

  if (request.action === 'triggerDownload') {
    chrome.downloads.download({
      url: request.blobUrl,
      filename: request.filename
    }, (downloadId) => {
      if (chrome.runtime.lastError || downloadId === undefined) {
        URL.revokeObjectURL(request.blobUrl);
        if (request.tempId) {
          chrome.runtime.sendMessage({ action: 'cleanupTempFile', tempId: request.tempId }).catch(() => {});
        }
        return;
      }
      pendingBlobDownloads.set(downloadId, {
        blobUrl: request.blobUrl,
        tempId: request.tempId
      });
    });
    return;
  }

  if (request.action === 'clearMedia') {
    if (request.tabId) {
      chrome.storage.session.remove(`media_${request.tabId}`);
      chrome.action.setBadgeText({ tabId: request.tabId, text: '' });
      sendResponse({ status: 'CLEARED' });
    }
    return true;
  }
});