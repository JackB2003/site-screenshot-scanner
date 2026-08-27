const form = document.getElementById('scanForm');
const scanBtn = document.getElementById('scanBtn');
const formPanel = document.getElementById('scan-form');
const progressPanel = document.getElementById('scan-progress');
const resultsPanel = document.getElementById('scan-results');
const terminal = document.getElementById('terminal');
const progressBar = document.getElementById('progressBar');
const statFound = document.getElementById('statFound');
const statCaptured = document.getElementById('statCaptured');
const statErrors = document.getElementById('statErrors');
const gallery = document.getElementById('gallery');
const viewportTabs = document.getElementById('viewportTabs');
const resultsTitle = document.getElementById('resultsTitle');
const downloadZipBtn = document.getElementById('downloadZip');
const newScanBtn = document.getElementById('newScan');
const lightbox = document.getElementById('lightbox');
const lightboxImg = document.getElementById('lightboxImg');
const lightboxClose = document.getElementById('lightboxClose');

const VIEWPORT_LABELS = { desktop: 'Desktop', tablet: 'Tablet', mobile: 'Mobile' };

let currentJobId = null;
let foundCount = 0;
let capturedCount = 0;
let errorCount = 0;
let maxPagesTarget = 50;
let activeViewportFilter = 'all';

function logLine(text, cls = '') {
  const div = document.createElement('div');
  div.className = `line ${cls}`;
  const tag = document.createElement('span');
  tag.className = 'tag';
  tag.textContent = new Date().toLocaleTimeString([], { hour12: false });
  div.appendChild(tag);
  div.appendChild(document.createTextNode(text));
  terminal.appendChild(div);
  terminal.scrollTop = terminal.scrollHeight;
}

function updateStats() {
  statFound.textContent = foundCount;
  statCaptured.textContent = capturedCount;
  statErrors.textContent = errorCount;
  const pct = maxPagesTarget ? Math.min(100, Math.round((capturedCount / maxPagesTarget) * 100)) : 0;
  progressBar.style.width = pct + '%';
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = document.getElementById('url').value.trim();
  const maxPages = parseInt(document.getElementById('maxPages').value, 10) || 50;
  if (!url) return;

  let viewports = [...form.querySelectorAll('input[name="viewport"]:checked')].map((el) => el.value);
  if (!viewports.length) viewports = ['desktop'];

  maxPagesTarget = maxPages * viewports.length;
  foundCount = 0;
  capturedCount = 0;
  errorCount = 0;
  terminal.innerHTML = '';
  gallery.innerHTML = '';
  viewportTabs.innerHTML = '';
  viewportTabs.classList.add('hidden');
  activeViewportFilter = 'all';
  updateStats();
  scanBtn.disabled = true;

  try {
    const res = await fetch('api/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, maxPages, viewports }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to start scan');
    currentJobId = data.jobId;
    formPanel.classList.add('hidden');
    progressPanel.classList.remove('hidden');
    resultsPanel.classList.add('hidden');
    logLine(`Target: ${url}`, 'status');
    startStream(currentJobId);
  } catch (err) {
    alert(err.message);
    scanBtn.disabled = false;
  }
});

function startStream(jobId) {
  const es = new EventSource(`api/scan/${jobId}/events`);
  es.onmessage = (msg) => {
    const evt = JSON.parse(msg.data);
    handleEvent(evt);
    if (evt.type === 'done' || evt.type === 'fatal') {
      es.close();
      finishScan();
    }
  };
  es.onerror = () => {
    // stream closes naturally on done/fatal; ignore transient errors
  };
}

function handleEvent(evt) {
  switch (evt.type) {
    case 'status':
      logLine(evt.message, 'status');
      break;
    case 'discovered':
      foundCount = evt.cumulative ? evt.count : Math.max(foundCount, evt.count);
      logLine(
        evt.source === 'sitemap' ? `Sitemap found — ${evt.count} page(s) queued` : `${evt.count} link(s) queued`,
        'found'
      );
      updateStats();
      break;
    case 'plan':
      maxPagesTarget = evt.totalCaptures;
      foundCount = evt.totalCaptures;
      setupViewportTabs(evt.viewports);
      updateStats();
      break;
    case 'visiting':
      logLine(`Scanning ${evt.url}${evt.viewport ? ` (${VIEWPORT_LABELS[evt.viewport] || evt.viewport})` : ''}`);
      break;
    case 'captured':
      capturedCount = evt.index;
      if (evt.total) maxPagesTarget = evt.total;
      logLine(`Captured ${evt.url}${evt.viewport ? ` (${VIEWPORT_LABELS[evt.viewport] || evt.viewport})` : ''}`, 'ok');
      updateStats();
      addThumb(evt);
      break;
    case 'error':
      errorCount++;
      logLine(`Failed: ${evt.url} — ${evt.message}`, 'err');
      updateStats();
      break;
    case 'done':
      logLine(
        `Scan complete — ${evt.captured} screenshot(s)${evt.pages ? ` across ${evt.pages} page(s)` : ''}${
          evt.viewports && evt.viewports.length > 1 ? ` × ${evt.viewports.length} viewport(s)` : ''
        }`,
        'status'
      );
      break;
    case 'fatal':
      logLine(`Fatal error: ${evt.message}`, 'err');
      break;
    default:
      break;
  }
}

function setupViewportTabs(viewports) {
  if (!viewports || viewports.length < 2) return;
  viewportTabs.innerHTML = '';
  viewportTabs.classList.remove('hidden');

  const makeTab = (value, label) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'vtab' + (value === 'all' ? ' active' : '');
    btn.dataset.viewport = value;
    btn.textContent = label;
    btn.addEventListener('click', () => {
      activeViewportFilter = value;
      viewportTabs.querySelectorAll('.vtab').forEach((t) => t.classList.toggle('active', t === btn));
      applyViewportFilter();
    });
    viewportTabs.appendChild(btn);
  };

  makeTab('all', 'All');
  viewports.forEach((v) => makeTab(v, VIEWPORT_LABELS[v] || v));
}

function applyViewportFilter() {
  gallery.querySelectorAll('.thumb').forEach((el) => {
    const show = activeViewportFilter === 'all' || el.dataset.viewport === activeViewportFilter;
    el.classList.toggle('hidden', !show);
  });
}

function addThumb(evt) {
  const div = document.createElement('div');
  div.className = 'thumb';
  if (evt.viewport) div.dataset.viewport = evt.viewport;
  if (evt.viewport && !(activeViewportFilter === 'all' || activeViewportFilter === evt.viewport)) {
    div.classList.add('hidden');
  }

  const img = document.createElement('img');
  img.src = `api/scan/${currentJobId}/shots/${evt.file}`;
  img.loading = 'lazy';
  img.alt = evt.url;
  div.appendChild(img);

  if (evt.viewport) {
    const badge = document.createElement('span');
    badge.className = 'thumb-badge';
    badge.textContent = VIEWPORT_LABELS[evt.viewport] || evt.viewport;
    div.appendChild(badge);
  }

  const info = document.createElement('div');
  info.className = 'thumb-info';
  let label = evt.url;
  try {
    label = new URL(evt.url).pathname || '/';
  } catch {
    // keep full url as fallback
  }
  info.textContent = label;
  div.appendChild(info);

  div.addEventListener('click', () => openLightbox(img.src));
  gallery.appendChild(div);
}

function openLightbox(src) {
  lightboxImg.src = src;
  lightbox.classList.remove('hidden');
}

lightboxClose.addEventListener('click', () => lightbox.classList.add('hidden'));
lightbox.addEventListener('click', (e) => {
  if (e.target === lightbox) lightbox.classList.add('hidden');
});

function finishScan() {
  progressPanel.classList.add('hidden');
  resultsPanel.classList.remove('hidden');
  resultsTitle.textContent = `Results — ${capturedCount} screenshot(s)${errorCount ? `, ${errorCount} error(s)` : ''}`;
  scanBtn.disabled = false;
}

downloadZipBtn.addEventListener('click', () => {
  if (!currentJobId) return;
  window.location.href = `api/scan/${currentJobId}/zip`;
});

newScanBtn.addEventListener('click', () => {
  resultsPanel.classList.add('hidden');
  formPanel.classList.remove('hidden');
  document.getElementById('url').value = '';
});
