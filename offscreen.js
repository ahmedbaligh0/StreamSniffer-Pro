/**
 * StreamSniffer Pro — Quantum Offscreen Assembly Nexus & Stream Demuxer
 */

let keepAlivePort = null;
try {
  keepAlivePort = chrome.runtime.connect({ name: 'qbit_keepalive' });
  keepAlivePort.onMessage.addListener((msg) => {
    if (msg.action === 'PING') {
      keepAlivePort.postMessage({ action: 'PONG' });
    }
  });
} catch (e) {}

const pendingRefreshes = new Map();
const activeTempHandles = new Map();
const keyCryptoCache = new Map();

class OPFSWriteQueue {
  constructor(fileHandle) {
    this.fileHandle = fileHandle;
    this.stream = null;
    this.queue = Promise.resolve();
    this.currentOffset = 0;
  }

  async init() {
    this.stream = await this.fileHandle.createWritable({ keepExistingData: true });
  }

  write(buffer) {
    const task = async () => {
      if (!this.stream) return;
      await this.stream.write(buffer);
      this.currentOffset += buffer.byteLength;
    };
    this.queue = this.queue.then(task).catch(err => {
      console.error('[StreamSniffer] OPFS Write Sync Error:', err);
    });
    return this.queue;
  }

  async flushAndClose() {
    await this.queue;
    if (this.stream) {
      await this.stream.close();
      this.stream = null;
    }
  }
}

function requestTokenRefresh(streamId, streamUrl) {
  return new Promise((resolve) => {
    const callbackId = crypto.randomUUID();
    pendingRefreshes.set(callbackId, resolve);
    chrome.runtime.sendMessage({
      action: 'REFRESH_TOKEN',
      streamId: streamId,
      streamUrl: streamUrl,
      callbackId: callbackId
    }).catch(() => resolve(null));
  });
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === 'TOKEN_REFRESHED' && pendingRefreshes.has(msg.callbackId)) {
    pendingRefreshes.get(msg.callbackId)(msg.authData);
    pendingRefreshes.delete(msg.callbackId);
  }
});

async function fetchWithResilience(url, rangeHeader = null, origin = null, streamId = null, retries = 4, delay = 400) {
  let activeUrl = url;
  let activeHeaders = {};
  if (rangeHeader) activeHeaders['Range'] = rangeHeader;
  if (origin) {
    activeHeaders['Referer'] = origin;
    activeHeaders['Origin'] = origin;
  }

  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(activeUrl, { headers: activeHeaders });
      if (res.status === 401 || res.status === 403) {
        if (streamId) {
          const freshAuth = await requestTokenRefresh(streamId, activeUrl);
          if (freshAuth?.url) activeUrl = freshAuth.url;
          if (freshAuth?.headers) Object.assign(activeHeaders, freshAuth.headers);
          continue;
        }
      }
      if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status}`);
      return await res.arrayBuffer();
    } catch (err) {
      if (i === retries - 1) throw err;
      const jitter = Math.random() * 200;
      await new Promise(r => setTimeout(r, delay * Math.pow(2, i) + jitter));
    }
  }
}

function sequenceToIV(seq) {
  const iv = new Uint8Array(16);
  let n = BigInt(seq);
  for (let i = 15; i >= 0; i--) {
    iv[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return iv;
}

async function decryptFullChunk(buffer, keyBuffer, ivBuffer) {
  if (!buffer || buffer.byteLength === 0) return buffer;
  try {
    let cryptoKey = keyCryptoCache.get(keyBuffer);
    if (!cryptoKey) {
      cryptoKey = await crypto.subtle.importKey('raw', keyBuffer, { name: 'AES-CBC' }, false, ['decrypt']);
      keyCryptoCache.set(keyBuffer, cryptoKey);
    }
    return await crypto.subtle.decrypt({ name: 'AES-CBC', iv: ivBuffer }, cryptoKey, buffer);
  } catch (err) {
    console.warn('[StreamSniffer] Hardware AES Decrypt failed, returning raw segment:', err);
    return buffer;
  }
}

function parseAttributes(line) {
  const attrString = line.substring(line.indexOf(':') + 1);
  const attrs = {};
  const regex = /([A-Z0-9-]+)=(?:"([^"]*)"|([^,]*))/g;
  let m;
  while ((m = regex.exec(attrString)) !== null) {
    attrs[m[1]] = m[2] !== undefined ? m[2] : m[3];
  }
  return attrs;
}

// Calculate total duration from media segments
function extractPlaylistDuration(lines) {
  let duration = 0;
  for (const line of lines) {
    if (line.startsWith('#EXTINF:')) {
      const val = parseFloat(line.substring(8).split(',')[0]);
      if (!isNaN(val)) duration += val;
    }
  }
  return duration;
}

async function parseHlsManifest(url, origin = null) {
  const res = await fetch(url, { headers: origin ? { 'Referer': origin } : {} });
  const text = await res.text();
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  const isMaster = lines.some(l => l.startsWith('#EXT-X-STREAM-INF'));
  if (isMaster) {
    const variants = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
        const attrs = parseAttributes(lines[i]);
        const resAttr = attrs.RESOLUTION || '';
        const bw = parseInt(attrs.BANDWIDTH || attrs['AVERAGE-BANDWIDTH'] || '0', 10);
        const codecs = attrs.CODECS || '';
        const fps = attrs['FRAME-RATE'] || '';

        let qualityLabel = 'Auto';
        if (resAttr) {
          qualityLabel = resAttr.split('x')[1] ? `${resAttr.split('x')[1]}p` : resAttr;
        } else if (bw > 5000000) qualityLabel = '1080p HD';
        else if (bw > 2500000) qualityLabel = '720p HD';
        else if (bw > 1000000) qualityLabel = '480p';
        else if (bw > 0) qualityLabel = '360p';

        if (lines[i + 1] && !lines[i + 1].startsWith('#')) {
          variants.push({
            quality: qualityLabel,
            resolution: resAttr,
            bandwidth: bw,
            codecs: codecs,
            fps: fps,
            url: new URL(lines[i + 1], url).href
          });
        }
      }
    }
    variants.sort((a, b) => b.bandwidth - a.bandwidth);
    return { isMaster: true, variants, segments: [], initMapUrl: null, duration: 0 };
  }

  let mediaSequence = 0;
  const seqLine = lines.find(l => l.startsWith('#EXT-X-MEDIA-SEQUENCE'));
  if (seqLine) {
    const parts = seqLine.split(':');
    const n = parseInt(parts[1], 10);
    if (!isNaN(n)) mediaSequence = n;
  }

  let initMapUrl = null;
  let currentKeyUrl = null;
  let currentExplicitIV = null;
  let currentByteRange = null;
  let lastByteRangeOffset = 0;

  let seq = mediaSequence;
  const segments = [];
  const duration = extractPlaylistDuration(lines);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('#EXT-X-KEY')) {
      const attrs = parseAttributes(line);
      if (!attrs.METHOD || attrs.METHOD === 'NONE') {
        currentKeyUrl = null;
        currentExplicitIV = null;
      } else {
        currentKeyUrl = attrs.URI ? new URL(attrs.URI, url).href : null;
        if (attrs.IV) {
          const raw = attrs.IV.replace(/^0x/i, '');
          currentExplicitIV = new Uint8Array(raw.match(/.{1,2}/g).map(b => parseInt(b, 16)));
        } else {
          currentExplicitIV = null;
        }
      }
      continue;
    }

    if (line.startsWith('#EXT-X-MAP')) {
      const attrs = parseAttributes(line);
      if (attrs.URI) initMapUrl = new URL(attrs.URI, url).href;
      continue;
    }

    if (line.startsWith('#EXT-X-BYTERANGE')) {
      const rangeVal = line.substring(line.indexOf(':') + 1);
      const [lengthStr, offsetStr] = rangeVal.split('@');
      const length = parseInt(lengthStr, 10);
      const offset = offsetStr !== undefined ? parseInt(offsetStr, 10) : lastByteRangeOffset;
      currentByteRange = `bytes=${offset}-${offset + length - 1}`;
      lastByteRangeOffset = offset + length;
      continue;
    }

    if (line.startsWith('#')) continue;

    segments.push({
      url: new URL(line, url).href,
      keyUrl: currentKeyUrl,
      iv: currentKeyUrl ? (currentExplicitIV || sequenceToIV(seq)) : null,
      byteRange: currentByteRange
    });

    currentByteRange = null;
    seq++;
  }

  return { isMaster: false, segments, initMapUrl, duration };
}

function formatDashTemplate(template, repId, number, time, bandwidth) {
  let res = template.replace(/\$RepresentationID\$/g, repId || '');
  res = res.replace(/\$Bandwidth\$/g, String(bandwidth || ''));
  res = res.replace(/\$Time\$/g, String(time || '0'));
  res = res.replace(/\$Number(?:%0?([0-9]+)d)?\$/g, (match, pad) => {
    if (pad) return String(number).padStart(parseInt(pad, 10), '0');
    return String(number);
  });
  return res;
}

async function parseDashManifest(url, origin = null) {
  const res = await fetch(url, { headers: origin ? { 'Referer': origin } : {} });
  const text = await res.text();
  const parser = new DOMParser();
  const xml = parser.parseFromString(text, 'application/xml');

  const stripNs = (elem) => elem.localName || elem.tagName;
  const periods = Array.from(xml.querySelectorAll('Period')).length ? Array.from(xml.querySelectorAll('Period')) : [xml.documentElement];
  
  const representations = [];

  for (const period of periods) {
    const adaptations = Array.from(period.children).filter(c => stripNs(c) === 'AdaptationSet');
    for (const adapt of adaptations) {
      const contentType = adapt.getAttribute('contentType') || (adapt.getAttribute('mimeType')?.includes('video') ? 'video' : 'audio');
      const adaptTemplate = Array.from(adapt.children).find(c => stripNs(c) === 'SegmentTemplate');

      const repElems = Array.from(adapt.children).filter(c => stripNs(c) === 'Representation');
      for (const rep of repElems) {
        const repId = rep.getAttribute('id') || '1';
        const bandwidth = parseInt(rep.getAttribute('bandwidth') || '0', 10);
        const width = rep.getAttribute('width') || '';
        const height = rep.getAttribute('height') || '';
        const codecs = rep.getAttribute('codecs') || '';
        const mime = rep.getAttribute('mimeType') || adapt.getAttribute('mimeType') || 'video/mp4';

        const repTemplate = Array.from(rep.children).find(c => stripNs(c) === 'SegmentTemplate');
        const tmpl = repTemplate || adaptTemplate;

        const segments = [];
        let initUrl = null;
        let totalDuration = 0;

        if (tmpl) {
          const initPattern = tmpl.getAttribute('initialization') || '';
          const mediaPattern = tmpl.getAttribute('media') || '';
          const startNumber = parseInt(tmpl.getAttribute('startNumber') || '1', 10);
          const timescale = parseInt(tmpl.getAttribute('timescale') || '1', 10);

          if (initPattern) {
            initUrl = new URL(formatDashTemplate(initPattern, repId, 0, 0, bandwidth), url).href;
          }

          const timeline = Array.from(tmpl.children).find(c => stripNs(c) === 'SegmentTimeline');
          if (timeline) {
            let currTime = 0;
            let segNum = startNumber;
            const sNodes = Array.from(timeline.children).filter(c => stripNs(c) === 'S');
            for (const s of sNodes) {
              const t = s.getAttribute('t');
              if (t !== null && t !== undefined) currTime = parseInt(t, 10);
              const d = parseInt(s.getAttribute('d') || '0', 10);
              const r = parseInt(s.getAttribute('r') || '0', 10);
              for (let i = 0; i <= r; i++) {
                const segRel = formatDashTemplate(mediaPattern, repId, segNum, currTime, bandwidth);
                segments.push({
                  url: new URL(segRel, url).href,
                  keyUrl: null,
                  iv: null,
                  byteRange: null
                });
                totalDuration += (d / timescale);
                currTime += d;
                segNum++;
              }
            }
          }
        }

        let qualityStr = height ? `${height}p` : (width ? `${width}w` : 'Adaptive');
        if (contentType === 'audio') qualityStr = 'Audio Track (AAC)';

        representations.push({
          id: repId,
          contentType,
          bandwidth,
          quality: qualityStr,
          resolution: width && height ? `${width}x${height}` : '',
          codecs,
          duration: totalDuration,
          mimeType: mime,
          initMapUrl: initUrl,
          segments,
          url: url
        });
      }
    }
  }

  return representations.sort((a, b) => b.bandwidth - a.bandwidth);
}

// Prober that resolves full sub-playlists to calculate exact duration and projected size
async function probeVariants(url, origin = null) {
  try {
    if (url.includes('.mpd') || url.includes('manifest.mpd')) {
      const reps = await parseDashManifest(url, origin);
      return reps.map(r => ({
        quality: r.quality,
        resolution: r.resolution,
        bandwidth: r.bandwidth,
        codecs: r.codecs,
        duration: r.duration,
        url: r.url
      }));
    } else {
      const hls = await parseHlsManifest(url, origin);
      if (hls.isMaster) {
        // Probe first sub-variant to grab total stream duration
        let masterDuration = 0;
        if (hls.variants[0]) {
          try {
            const subHls = await parseHlsManifest(hls.variants[0].url, origin);
            masterDuration = subHls.duration;
          } catch (e) {}
        }
        return hls.variants.map(v => ({
          ...v,
          duration: masterDuration
        }));
      }
      return [{
        quality: 'Original Stream',
        resolution: '',
        bandwidth: 0,
        codecs: '',
        duration: hls.duration,
        url: url
      }];
    }
  } catch (e) {
    return [{ quality: 'Direct Stream', resolution: '', bandwidth: 0, codecs: '', duration: 0, url }];
  }
}

async function processManifestNexus(streamUrl, filename, origin, streamId, tabId) {
  const tempId = `qbit_opfs_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  let tempFileHandle = null;

  try {
    const startTime = Date.now();
    let segments = [];
    let initMapUrl = null;
    let isFragmentedMP4 = false;

    if (streamUrl.includes('.mpd') || streamUrl.includes('manifest.mpd')) {
      const reps = await parseDashManifest(streamUrl, origin);
      if (!reps.length) throw new Error('DASH parser found no playable representations.');
      const primaryRep = reps[0];
      segments = primaryRep.segments;
      initMapUrl = primaryRep.initMapUrl;
      isFragmentedMP4 = true;
    } else {
      let hls = await parseHlsManifest(streamUrl, origin);
      if (hls.isMaster) {
        if (!hls.variants.length) throw new Error('Master playlist contains no active variants.');
        const topVariantUrl = hls.variants[0].url;
        hls = await parseHlsManifest(topVariantUrl, origin);
      }
      segments = hls.segments;
      initMapUrl = hls.initMapUrl;
      isFragmentedMP4 = !!initMapUrl;
    }

    if (!segments.length) throw new Error('Stream manifest resolution yielded 0 segments.');

    const encrypted = segments.some(s => s.keyUrl);
    chrome.runtime.sendMessage({
      action: 'assemblyProgress',
      status: 'START',
      total: segments.length,
      encrypted,
      tabId
    }).catch(() => {});

    const root = await navigator.storage.getDirectory();
    tempFileHandle = await root.getFileHandle(`${tempId}.bin`, { create: true });
    activeTempHandles.set(tempId, tempFileHandle);

    const writeQueue = new OPFSWriteQueue(tempFileHandle);
    await writeQueue.init();

    if (initMapUrl) {
      const initBuffer = await fetchWithResilience(initMapUrl, null, origin, streamId);
      if (initBuffer) await writeQueue.write(new Uint8Array(initBuffer));
    }

    const keyCache = new Map();
    const downloadedMap = new Map();
    let nextWriteIndex = 0;
    let completedCount = 0;
    let downloadedBytes = 0;
    let cursor = 0;
    const concurrency = 6;
    const MAX_AHEAD = 20;

    let isFlushing = false;
    let drainResolver = null;

    async function flushInOrder() {
      if (isFlushing) return;
      isFlushing = true;
      try {
        while (downloadedMap.has(nextWriteIndex)) {
          const chunkData = downloadedMap.get(nextWriteIndex);
          downloadedMap.delete(nextWriteIndex);
          await writeQueue.write(chunkData);
          downloadedBytes += chunkData.byteLength;
          nextWriteIndex++;
          completedCount++;

          const elapsedSec = (Date.now() - startTime) / 1000;
          const speedMBps = elapsedSec > 0 ? (downloadedBytes / (1024 * 1024 * elapsedSec)).toFixed(1) : '0.0';
          const percent = Math.round((completedCount / segments.length) * 100);

          chrome.runtime.sendMessage({
            action: 'assemblyProgress',
            status: 'PROGRESS',
            done: completedCount,
            total: segments.length,
            percent: percent,
            speed: speedMBps,
            mb: (downloadedBytes / (1024 * 1024)).toFixed(1),
            tabId
          }).catch(() => {});

          if (drainResolver && (cursor - nextWriteIndex < MAX_AHEAD)) {
            drainResolver();
            drainResolver = null;
          }
        }
      } finally {
        isFlushing = false;
      }
    }

    async function worker() {
      while (cursor < segments.length) {
        if (cursor - nextWriteIndex >= MAX_AHEAD) {
          await new Promise(r => { drainResolver = r; });
        }
        if (cursor >= segments.length) break;

        const idx = cursor++;
        const seg = segments[idx];

        let buffer = await fetchWithResilience(seg.url, seg.byteRange, origin, streamId);
        if (seg.keyUrl) {
          let keyBuf = keyCache.get(seg.keyUrl);
          if (!keyBuf) {
            keyBuf = await fetchWithResilience(seg.keyUrl, null, origin, streamId);
            keyCache.set(seg.keyUrl, keyBuf);
          }
          buffer = await decryptFullChunk(buffer, keyBuf, seg.iv);
        }

        if (buffer && buffer.byteLength > 0) {
          downloadedMap.set(idx, new Uint8Array(buffer));
          await flushInOrder();
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, segments.length) }, () => worker()));
    await flushInOrder();
    await writeQueue.flushAndClose();

    chrome.runtime.sendMessage({ action: 'assemblyProgress', status: 'BUILDING', tabId }).catch(() => {});

    const file = await tempFileHandle.getFile();
    const ext = isFragmentedMP4 ? '.mp4' : '.ts';
    const finalFilename = filename.endsWith(ext) ? filename : `${filename}${ext}`;
    const blobUrl = URL.createObjectURL(file);

    chrome.runtime.sendMessage({
      action: 'triggerDownload',
      blobUrl,
      filename: finalFilename,
      tempId,
      tabId
    }).catch(() => {});

    chrome.runtime.sendMessage({ action: 'assemblyProgress', status: 'COMPLETE', tabId }).catch(() => {});
    chrome.runtime.sendMessage({ action: 'assemblyEnded', tabId, filename: finalFilename }).catch(() => {});

  } catch (err) {
    console.error('[StreamSniffer] Assembly failed:', err);
    chrome.runtime.sendMessage({
      action: 'assemblyProgress',
      status: 'ERROR',
      error: err.message || 'Stream Assembly Aborted',
      tabId
    }).catch(() => {});
    chrome.runtime.sendMessage({ action: 'assemblyEnded', tabId, filename }).catch(() => {});

    if (tempFileHandle) {
      try { await tempFileHandle.remove(); } catch (e) {}
    }
  }
}

chrome.runtime.onMessage.addListener((request) => {
  if (request.action === 'executeOffscreenTask') {
    processManifestNexus(request.url, request.filename, request.origin, request.streamId, request.tabId);
  }
  if (request.action === 'probeManifestVariants') {
    probeVariants(request.url, request.origin).then(variants => {
      chrome.runtime.sendMessage({ action: 'variantsFound', id: request.id, variants }).catch(() => {});
    });
  }
  if (request.action === 'cleanupTempFile') {
    const handle = activeTempHandles.get(request.tempId);
    if (handle) {
      handle.remove().catch(() => {});
      activeTempHandles.delete(request.tempId);
    }
  }
});