/**
 * StreamSniffer Pro — Quantum Popup Controller & Telemetry UI
 */

async function copyToClipboard(text, targetElement, successText = "✓ Copied") {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      throw new Error("Clipboard API fallback required");
    }
  } catch (err) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
  }
  if (targetElement) {
    const original = targetElement.innerText;
    targetElement.innerText = successText;
    setTimeout(() => { targetElement.innerText = original; }, 1600);
  }
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return "Dynamic Size";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

function formatBitrate(bps) {
  if (!bps || bps <= 0) return "Adaptive Bitrate";
  if (bps >= 1000000) return `${(bps / 1000000).toFixed(1)} Mbps`;
  return `${Math.round(bps / 1000)} Kbps`;
}

// Calculate predicted disk footprint & network consumption
function estimateProjectedSize(bandwidthBps, durationSec = 0) {
  if (!bandwidthBps || bandwidthBps <= 0) return "Adaptive Footprint";
  // Default to 10 minutes average if stream manifest does not specify duration
  const effectiveDuration = durationSec > 0 ? durationSec : 600;
  const totalBits = bandwidthBps * effectiveDuration;
  const totalBytes = totalBits / 8;
  const formatted = formatBytes(totalBytes);
  return durationSec > 0 ? `Est. Size: ${formatted}` : `Est. Size: ~${formatted} (10m)`;
}

function sanitizeFilename(title, ext) {
  const safe = (title || "Stream_Media")
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, "_")
    .substring(0, 80);
  return `${safe}.${ext || "mp4"}`;
}

function generateCurlCommand(url, origin) {
  const userAgent = navigator.userAgent;
  const ref = origin ? `-H "Referer: ${origin}" ` : "";
  return `curl -L -k ${ref}-H "User-Agent: ${userAgent}" "${url}" -o "downloaded_stream.mp4"`;
}

function generateYtDlpCommand(url, origin) {
  const ref = origin ? `--referer "${origin}" ` : "";
  return `yt-dlp -f "bestvideo+bestaudio/best" ${ref}"${url}"`;
}

chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
  const currentTab = tabs[0];
  if (!currentTab || !currentTab.id) return;

  const url = currentTab.url || "";
  const tabOrigin = (function() {
    try { return new URL(url).origin; } catch (e) { return ""; }
  })();

  const mediaContainer = document.getElementById("media-container");
  const ytContainer = document.getElementById("yt-container");
  const countBadge = document.getElementById("media-count");
  const engineStatus = document.getElementById("engine-status");
  const engineSpeed = document.getElementById("engine-speed");
  const engineTransferred = document.getElementById("engine-transferred");
  const engineOpfs = document.getElementById("engine-opfs");
  const globalProgress = document.getElementById("global-progress");
  const searchInput = document.getElementById("search-input");
  const batchBtn = document.getElementById("btn-batch-dl");
  const clearBtn = document.getElementById("btn-clear");

  const probeModal = document.getElementById("probe-modal");
  const modalVideo = document.getElementById("modal-video");
  const modalMetaText = document.getElementById("modal-meta-text");
  const modalClose = document.getElementById("modal-close-btn");

  let allMediaItems = [];
  let currentFilter = "all";
  let searchQuery = "";

  modalClose.addEventListener("click", () => {
    probeModal.style.display = "none";
    modalVideo.pause();
    modalVideo.src = "";
  });

  // YouTube Inspector Card
  const ytMatch = url.match(/(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/);
  if (ytMatch && ytMatch[1]) {
    const videoId = ytMatch[1];
    const safeTitle = sanitizeFilename(currentTab.title || "YouTube_Video", "jpg").replace(".jpg", "");

    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `
      <div class="card-head">
        <div class="card-badges">
          <span class="badge badge-yt">YOUTUBE ENGINE</span>
          <span class="badge badge-video">4K / HDR Ready</span>
        </div>
      </div>
      <div class="stream-title">${currentTab.title || "YouTube Stream"}</div>
      <div class="url-row">
        <span class="url-text">${url}</span>
        <button class="copy-btn" id="yt-copy">Copy</button>
      </div>
      <div class="btn-row">
        <button class="btn btn-secondary" id="btn-yt-thumb">Cover Art</button>
        <button class="btn btn-secondary" id="btn-yt-curl">cURL</button>
        <button class="btn btn-secondary" id="btn-yt-cli">yt-dlp</button>
        <button class="btn btn-primary" id="btn-yt-info">Inspect</button>
      </div>
    `;
    ytContainer.appendChild(card);

    document.getElementById("yt-copy").addEventListener("click", (e) => copyToClipboard(url, e.target));
    document.getElementById("btn-yt-thumb").addEventListener("click", () => {
      chrome.downloads.download({
        url: `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
        filename: `${safeTitle}_cover.jpg`
      });
    });
    document.getElementById("btn-yt-curl").addEventListener("click", (e) => {
      copyToClipboard(generateCurlCommand(url, tabOrigin), e.target, "✓ cURL Copied");
    });
    document.getElementById("btn-yt-cli").addEventListener("click", (e) => {
      copyToClipboard(generateYtDlpCommand(url, tabOrigin), e.target, "✓ CLI Copied");
    });
    document.getElementById("btn-yt-info").addEventListener("click", () => {
      modalMetaText.innerHTML = `<b>YouTube ID:</b> ${videoId} | <b>Title:</b> ${currentTab.title}`;
      modalVideo.src = `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`;
      probeModal.style.display = "flex";
    });
  }

  function getFiltered() {
    return allMediaItems.filter(item => {
      const matchesFilter = (currentFilter === "all") ||
        (currentFilter === "AUDIO" && (item.type === "AUDIO" || item.extension === "mp3" || item.extension === "m4a")) ||
        (item.type === currentFilter);

      if (!matchesFilter) return false;
      if (!searchQuery) return true;

      const q = searchQuery.toLowerCase();
      return (item.title && item.title.toLowerCase().includes(q)) ||
             (item.url && item.url.toLowerCase().includes(q)) ||
             (item.type && item.type.toLowerCase().includes(q)) ||
             (item.quality && item.quality.toLowerCase().includes(q));
    });
  }

  function renderList() {
    mediaContainer.innerHTML = "";
    const filtered = getFiltered();

    if (!filtered.length && !ytMatch) {
      mediaContainer.innerHTML = `
        <div class="empty-state">
          <div class="radar"></div>
          <div style="font-size: 12px; font-weight: 700; color: #cbd5e1; margin-bottom: 4px;">Scanning for Media Streams...</div>
          <div style="font-size: 10px; color: #64748b;">Play a video or audio stream on the page to intercept multi-quality HLS, DASH, or MP4 streams.</div>
        </div>
      `;
      return;
    }

    filtered.forEach((item, idx) => {
      const isHls = item.type === "M3U8";
      const isDash = item.type === "MPD";
      const isAudio = item.type === "AUDIO";
      const badgeClass = isHls ? "badge-m3u8" : (isDash ? "badge-mpd" : (isAudio ? "badge-audio" : "badge-video"));

      const sizeLabel = formatBytes(item.sizeBytes);
      const card = document.createElement("div");
      card.className = "card";
      card.innerHTML = `
        <div class="card-head">
          <div class="card-badges">
            <span class="badge ${badgeClass}">${item.type}</span>
            <span class="badge badge-video" id="quality-badge-${idx}">${item.quality}</span>
          </div>
          <span style="font-size: 10px; font-weight: 600; color: var(--text-sub);" id="header-size-${idx}">${sizeLabel}</span>
        </div>

        <div class="stream-title" title="${item.title || item.url}">${item.title || "Detected Stream"}</div>

        <div class="url-row">
          <span class="url-text" title="${item.url}">${item.url}</span>
          <button class="copy-btn" id="copy-${idx}">Copy</button>
        </div>

        <div class="quality-wrapper" id="quality-wrapper-${idx}">
          <div class="quality-label">
            <span>Select Quality Ladder:</span>
            <span id="est-size-${idx}" style="color: var(--accent);">Calculating Size...</span>
          </div>
          <select class="variant-selector" id="variants-${idx}"></select>
        </div>

        <div class="btn-row">
          <button class="btn btn-secondary" id="btn-probe-${idx}">Inspect</button>
          <button class="btn btn-secondary" id="btn-curl-${idx}">cURL</button>
          <button class="btn btn-secondary" id="btn-cli-${idx}">yt-dlp</button>
          <button class="btn ${isHls || isDash ? 'btn-hls' : 'btn-primary'}" id="dl-${idx}">
            ${isHls || isDash ? 'Assemble' : 'Download'}
          </button>
        </div>
      `;
      mediaContainer.appendChild(card);

      document.getElementById(`copy-${idx}`).addEventListener("click", (e) => {
        copyToClipboard(item.url, e.target);
      });

      document.getElementById(`btn-curl-${idx}`).addEventListener("click", (e) => {
        copyToClipboard(generateCurlCommand(item.url, item.origin || tabOrigin), e.target, "✓ Copied");
      });

      document.getElementById(`btn-cli-${idx}`).addEventListener("click", (e) => {
        copyToClipboard(generateYtDlpCommand(item.url, item.origin || tabOrigin), e.target, "✓ Copied");
      });

      if (isHls || isDash) {
        chrome.runtime.sendMessage({
          action: "inspectVariants",
          url: item.url,
          id: idx,
          origin: item.origin || tabOrigin
        });
      }

      document.getElementById(`btn-probe-${idx}`).addEventListener("click", () => {
        modalMetaText.innerHTML = `
          <b>Format:</b> ${item.type} | <b>Quality:</b> ${item.quality} | <b>Size:</b> ${sizeLabel}<br>
          <span style="font-family: monospace; font-size: 9px; color: #94a3b8;">${item.url}</span>
        `;
        if (isHls || isDash) {
          modalVideo.src = "";
          probeModal.style.display = "flex";
        } else {
          modalVideo.src = item.url;
          probeModal.style.display = "flex";
        }
      });

      document.getElementById(`dl-${idx}`).addEventListener("click", () => {
        const selectElem = document.getElementById(`variants-${idx}`);
        const chosenOpt = selectElem && selectElem.options ? selectElem.options[selectElem.selectedIndex] : null;
        const targetUrl = chosenOpt?.value || item.url;
        const qualitySuffix = chosenOpt?.dataset?.quality ? `_${chosenOpt.dataset.quality}` : '';

        const titleSafe = sanitizeFilename(`${item.title || "Stream"}${qualitySuffix}`, item.extension);

        if (isHls || isDash) {
          engineStatus.innerText = "STREAMING TO OPFS DISK...";
          engineStatus.style.color = "var(--accent)";

          chrome.runtime.sendMessage({
            action: "startAssembly",
            url: targetUrl,
            filename: titleSafe,
            origin: item.origin || tabOrigin,
            tabId: currentTab.id
          });
        } else {
          chrome.downloads.download({
            url: item.url,
            filename: titleSafe
          });
        }
      });
    });
  }

  // Handle Quality Ladder Populator
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === "variantsFound") {
      const selectElem = document.getElementById(`variants-${msg.id}`);
      const wrapperElem = document.getElementById(`quality-wrapper-${msg.id}`);
      const estSizeElem = document.getElementById(`est-size-${msg.id}`);
      const qualityBadge = document.getElementById(`quality-badge-${msg.id}`);

      if (selectElem && msg.variants && msg.variants.length > 1) {
        selectElem.innerHTML = "";
        msg.variants.forEach((v) => {
          const opt = document.createElement("option");
          opt.value = v.url;
          opt.dataset.bandwidth = v.bandwidth || 0;
          opt.dataset.duration = v.duration || 0;
          opt.dataset.quality = v.quality || 'Auto';

          const bitrateStr = v.bandwidth ? ` • ${formatBitrate(v.bandwidth)}` : "";
          const codecStr = v.codecs ? ` [${v.codecs}]` : "";
          opt.innerText = `${v.quality}${bitrateStr}${codecStr}`;
          selectElem.appendChild(opt);
        });

        wrapperElem.style.display = "block";
        if (qualityBadge && msg.variants[0]) {
          qualityBadge.innerText = `${msg.variants.length} Qualities Available`;
        }

        const updateEstimatedMetrics = () => {
          const selOpt = selectElem.options[selectElem.selectedIndex];
          const bw = parseInt(selOpt?.dataset?.bandwidth || 0, 10);
          const dur = parseFloat(selOpt?.dataset?.duration || 0);
          if (estSizeElem) estSizeElem.innerText = estimateProjectedSize(bw, dur);
        };

        selectElem.addEventListener("change", updateEstimatedMetrics);
        updateEstimatedMetrics();
      }
    }

    if (msg.action === "assemblyProgress") {
      if (msg.status === "START") {
        engineStatus.innerText = msg.encrypted
          ? `DECRYPTING ${msg.total} CHUNKS (OPFS)...`
          : `STREAMING ${msg.total} CHUNKS (OPFS)...`;
        engineStatus.style.color = "var(--purple)";
      }
      if (msg.status === "PROGRESS") {
        engineStatus.innerText = `ASSEMBLING: ${msg.done}/${msg.total}`;
        engineStatus.style.color = "var(--accent)";
        engineSpeed.innerText = `${msg.speed} MB/s`;
        engineTransferred.innerText = `${msg.mb} MB`;
        engineOpfs.innerText = `Active (${msg.percent || 0}%)`;
        globalProgress.style.width = `${msg.percent || 0}%`;
      }
      if (msg.status === "BUILDING") {
        engineStatus.innerText = "FINALIZING CONTAINER DISK WRITE...";
        engineStatus.style.color = "var(--orange)";
      }
      if (msg.status === "COMPLETE") {
        engineStatus.innerText = "DOWNLOAD DISPATCH COMPLETE";
        engineStatus.style.color = "var(--success)";
        engineOpfs.innerText = "Flushed to Disk";
        setTimeout(() => { globalProgress.style.width = "0%"; }, 2500);
      }
      if (msg.status === "ERROR") {
        engineStatus.innerText = `ERROR: ${msg.error}`;
        engineStatus.style.color = "var(--danger)";
        engineOpfs.innerText = "Halted";
      }
    }
  });

  searchInput.addEventListener("input", (e) => {
    searchQuery = e.target.value.trim();
    renderList();
  });

  document.querySelectorAll(".filter-btn").forEach(btn => {
    btn.addEventListener("click", (e) => {
      document.querySelectorAll(".filter-btn").forEach(b => b.classList.remove("active"));
      e.target.classList.add("active");
      currentFilter = e.target.dataset.filter;
      renderList();
    });
  });

  batchBtn.addEventListener("click", () => {
    const list = getFiltered().filter(i => i.type !== "M3U8" && i.type !== "MPD");
    if (!list.length) {
      alert("Batch download targets direct MP4/Audio files. Segmented HLS/DASH streams should be assembled individually.");
      return;
    }
    list.forEach((item, index) => {
      setTimeout(() => {
        const titleSafe = sanitizeFilename(`Batch_${index + 1}_${item.title || "Stream"}`, item.extension);
        chrome.downloads.download({ url: item.url, filename: titleSafe });
      }, index * 250);
    });
  });

  clearBtn.addEventListener("click", () => {
    chrome.runtime.sendMessage({ action: "clearMedia", tabId: currentTab.id }, () => {
      allMediaItems = [];
      countBadge.innerText = "0 STREAMS";
      renderList();
    });
  });

  chrome.runtime.sendMessage({ action: "getMedia", tabId: currentTab.id }, (response) => {
    if (chrome.runtime.lastError || !response) {
      allMediaItems = [];
    } else {
      allMediaItems = response.media || [];
      if (response.activeAssembly) {
        const act = response.activeAssembly;
        engineStatus.innerText = `ASSEMBLING: ${act.done || 0}/${act.total || 0}`;
        engineStatus.style.color = "var(--accent)";
        engineSpeed.innerText = `${act.speed || 0} MB/s`;
        engineTransferred.innerText = `${act.mb || 0} MB`;
        globalProgress.style.width = `${act.progress || 0}%`;
      }
    }
    countBadge.innerText = `${allMediaItems.length} STREAMS`;
    renderList();
  });
});