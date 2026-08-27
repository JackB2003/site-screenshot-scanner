const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const archiver = require('archiver');
const { chromium } = require('playwright');

const PORT = process.env.PORT || 3012;
const SCREENSHOTS_ROOT = path.join(__dirname, 'screenshots');
const JOB_TTL_MS = 24 * 60 * 60 * 1000;
const SITEMAP_TIMEOUT_MS = 8000;
const NAV_TIMEOUT_MS = 30000;

const SKIP_EXT = /\.(pdf|jpe?g|png|gif|svg|webp|bmp|css|js|mjs|json|xml|zip|rar|7z|gz|mp4|mp3|avi|mov|wmv|woff2?|ttf|eot|ico|csv|docx?|xlsx?|pptx?)(\?|#|$)/i;

const jobs = new Map();
let browser;

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/scan', async (req, res) => {
  let { url, maxPages } = req.body || {};
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'URL is required' });
  }
  url = url.trim();
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  try {
    new URL(url);
  } catch {
    return res.status(400).json({ error: 'That does not look like a valid URL' });
  }
  maxPages = Math.min(Math.max(parseInt(maxPages, 10) || 50, 1), 200);

  const jobId = crypto.randomUUID();
  const dir = path.join(SCREENSHOTS_ROOT, jobId);
  fs.mkdirSync(dir, { recursive: true });

  const job = {
    id: jobId,
    url,
    maxPages,
    dir,
    events: [],
    emitter: new EventEmitter(),
    status: 'running',
    results: [],
    createdAt: Date.now(),
  };
  job.emitter.setMaxListeners(20);
  jobs.set(jobId, job);
  res.json({ jobId });

  runJob(job).catch((err) => {
    pushEvent(job, { type: 'fatal', message: String((err && err.message) || err) });
  });
});

app.get('/api/scan/:id/events', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).end();

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  for (const evt of job.events) res.write(`data: ${JSON.stringify(evt)}\n\n`);
  if (job.status !== 'running') {
    res.end();
    return;
  }

  const onEvent = (evt) => {
    res.write(`data: ${JSON.stringify(evt)}\n\n`);
    if (evt.type === 'done' || evt.type === 'fatal') {
      job.emitter.off('event', onEvent);
      res.end();
    }
  };
  job.emitter.on('event', onEvent);
  req.on('close', () => job.emitter.off('event', onEvent));
});

app.get('/api/scan/:id/shots/:file', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).end();
  const file = path.basename(req.params.file);
  const filePath = path.join(job.dir, file);
  if (!filePath.startsWith(job.dir)) return res.status(400).end();
  res.sendFile(filePath, (err) => {
    if (err && !res.headersSent) res.status(404).end();
  });
});

app.get('/api/scan/:id/zip', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).end();
  res.attachment(`screenshots-${job.id}.zip`);
  const archive = archiver('zip');
  archive.on('error', (err) => {
    if (!res.headersSent) res.status(500);
    res.end();
    console.error('zip error', err);
  });
  archive.pipe(res);
  archive.directory(job.dir, false);
  archive.finalize();
});

function pushEvent(job, evt) {
  evt.ts = Date.now();
  job.events.push(evt);
  if (evt.type === 'done') job.status = 'done';
  if (evt.type === 'fatal') job.status = 'error';
  job.emitter.emit('event', evt);
}

// ---------- sitemap discovery ----------

async function fetchWithTimeout(url, ms = SITEMAP_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { signal: ctrl.signal, redirect: 'follow' });
  } finally {
    clearTimeout(t);
  }
}

function extractLocs(xml) {
  const matches = [...xml.matchAll(/<loc>\s*([\s\S]*?)\s*<\/loc>/gi)];
  return matches.map((m) =>
    m[1]
      .trim()
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
  );
}

async function getSitemapUrls(origin) {
  const candidates = [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`];
  for (const cand of candidates) {
    try {
      const resp = await fetchWithTimeout(cand);
      if (!resp.ok) continue;
      const text = await resp.text();
      if (/<sitemapindex/i.test(text)) {
        const childLocs = extractLocs(text).slice(0, 20);
        const all = [];
        for (const c of childLocs) {
          try {
            const cr = await fetchWithTimeout(c);
            if (cr.ok) all.push(...extractLocs(await cr.text()));
          } catch {
            // skip unreachable child sitemap
          }
        }
        const uniq = [...new Set(all)];
        if (uniq.length) return uniq;
      } else if (/<urlset/i.test(text) || /<loc>/i.test(text)) {
        const uniq = [...new Set(extractLocs(text))];
        if (uniq.length) return uniq;
      }
    } catch {
      // try next candidate
    }
  }
  return null;
}

// ---------- link filtering ----------

function isCandidateLink(href, originHost) {
  try {
    const u = new URL(href);
    if (!/^https?:$/.test(u.protocol)) return false;
    if (u.host !== originHost) return false;
    if (SKIP_EXT.test(u.pathname)) return false;
    return true;
  } catch {
    return false;
  }
}

function normalizeUrl(href) {
  const u = new URL(href);
  u.hash = '';
  let s = u.toString();
  if (s.endsWith('/') && u.pathname !== '/') s = s.slice(0, -1);
  return s;
}

function slugFor(url, index) {
  let slug;
  try {
    const u = new URL(url);
    const p = u.pathname.replace(/\/+$/, '') || '/';
    slug =
      p === '/'
        ? 'home'
        : p
            .replace(/^\//, '')
            .replace(/[^a-z0-9]+/gi, '-')
            .replace(/(^-|-$)/g, '')
            .toLowerCase();
  } catch {
    slug = 'page';
  }
  if (!slug) slug = 'page';
  return `${String(index + 1).padStart(3, '0')}-${slug}.png`;
}

async function autoScroll(page) {
  await page
    .evaluate(async () => {
      await new Promise((resolve) => {
        let total = 0;
        const distance = 400;
        const timer = setInterval(() => {
          window.scrollBy(0, distance);
          total += distance;
          if (total >= document.body.scrollHeight - window.innerHeight || total > 20000) {
            clearInterval(timer);
            window.scrollTo(0, 0);
            resolve();
          }
        }, 100);
      });
    })
    .catch(() => {});
  await page.waitForTimeout(300);
}

// ---------- capture ----------

async function captureFixed(urls, job, context) {
  let idx = 0;
  let completed = 0;
  const total = urls.length;

  const worker = async () => {
    while (idx < urls.length) {
      const myIndex = idx++;
      const url = urls[myIndex];
      pushEvent(job, { type: 'visiting', url });
      const page = await context.newPage();
      try {
        await page.goto(url, { waitUntil: 'load', timeout: NAV_TIMEOUT_MS });
        await autoScroll(page);
        const file = slugFor(url, myIndex);
        await page.screenshot({ path: path.join(job.dir, file), fullPage: true });
        completed++;
        job.results.push({ url, file });
        pushEvent(job, { type: 'captured', url, file, index: completed, total });
      } catch (e) {
        completed++;
        pushEvent(job, { type: 'error', url, message: String((e && e.message) || e), index: completed, total });
      } finally {
        await page.close().catch(() => {});
      }
    }
  };

  const workerCount = Math.min(3, urls.length);
  await Promise.all(Array.from({ length: workerCount }, worker));
}

async function discoverLinks(page, originHost) {
  const found = new Set();
  const baseLinks = await page.$$eval('a[href]', (as) => as.map((a) => a.href)).catch(() => []);
  baseLinks.forEach((l) => found.add(l));

  // Many modern sites (shadcn/ui, Radix, etc.) hide real nav links inside
  // dropdown/menu buttons that only render their <a> children once clicked —
  // a plain anchor scan misses them entirely. Click visible nav/header
  // buttons to expand those menus and pick up what they reveal.
  const startUrl = page.url();
  const buttons = await page.$$('nav button, header button').catch(() => []);
  for (const btn of buttons.slice(0, 10)) {
    try {
      const box = await btn.boundingBox();
      if (!box) continue; // skip hidden/detached triggers (e.g. mobile-only toggle)
      await btn.click({ timeout: 1500 });
      await page.waitForTimeout(200);
      if (page.url() !== startUrl) {
        // click navigated the page away — capture what's there, then recover
        const links = await page.$$eval('a[href]', (as) => as.map((a) => a.href)).catch(() => []);
        links.forEach((l) => found.add(l));
        await page.goto(startUrl, { waitUntil: 'load', timeout: NAV_TIMEOUT_MS }).catch(() => {});
        continue;
      }
      const links = await page.$$eval('a[href]', (as) => as.map((a) => a.href)).catch(() => []);
      links.forEach((l) => found.add(l));
    } catch {
      // ignore click failures (covered, animating, detached, etc.)
    }
  }

  return [...found].filter((l) => isCandidateLink(l, originHost));
}

async function crawlAndCapture(startUrl, job, context, origin) {
  const originHost = new URL(origin).host;
  const visited = new Set();
  const queue = [startUrl];
  let capturedCount = 0;

  while (queue.length && capturedCount < job.maxPages) {
    const url = queue.shift();
    const norm = normalizeUrl(url);
    if (visited.has(norm)) continue;
    visited.add(norm);

    pushEvent(job, { type: 'visiting', url });
    const page = await context.newPage();
    try {
      await page.goto(url, { waitUntil: 'load', timeout: NAV_TIMEOUT_MS });
      await autoScroll(page);
      const file = slugFor(url, capturedCount);
      await page.screenshot({ path: path.join(job.dir, file), fullPage: true });
      capturedCount++;
      job.results.push({ url, file });
      pushEvent(job, { type: 'captured', url, file, index: capturedCount, total: job.maxPages });

      if (capturedCount < job.maxPages) {
        const links = await discoverLinks(page, originHost);
        let added = 0;
        for (const l of links) {
          const n = normalizeUrl(l);
          if (visited.has(n)) continue;
          if (queue.some((q) => normalizeUrl(q) === n)) continue;
          queue.push(l);
          added++;
        }
        if (added) pushEvent(job, { type: 'discovered', count: queue.length, cumulative: true });
      }
    } catch (e) {
      pushEvent(job, { type: 'error', url, message: String((e && e.message) || e) });
    } finally {
      await page.close().catch(() => {});
    }
  }
}

async function runJob(job) {
  pushEvent(job, { type: 'status', message: `Starting scan of ${job.url}` });
  const origin = new URL(job.url).origin;

  pushEvent(job, { type: 'status', message: 'Checking sitemap.xml...' });
  let sitemapUrls = null;
  try {
    sitemapUrls = await getSitemapUrls(origin);
  } catch {
    sitemapUrls = null;
  }

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    ignoreHTTPSErrors: true,
    userAgent:
      'Mozilla/5.0 (compatible; SiteScreenshotBot/1.0; +https://jackhost.shop/site-screenshots/)',
  });

  try {
    if (sitemapUrls && sitemapUrls.length) {
      const urls = sitemapUrls.slice(0, job.maxPages);
      pushEvent(job, { type: 'discovered', count: urls.length, total: sitemapUrls.length, source: 'sitemap' });
      await captureFixed(urls, job, context);
    } else {
      pushEvent(job, { type: 'status', message: 'No sitemap found — crawling links from the homepage...' });
      await crawlAndCapture(job.url, job, context, origin);
    }
    pushEvent(job, { type: 'done', captured: job.results.length });
  } finally {
    await context.close().catch(() => {});
  }
}

// ---------- cleanup ----------

setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.status === 'running') continue;
    if (now - job.createdAt > JOB_TTL_MS) {
      fs.rm(job.dir, { recursive: true, force: true }, () => {});
      jobs.delete(id);
    }
  }
}, 60 * 60 * 1000);

// ---------- startup ----------

(async () => {
  fs.mkdirSync(SCREENSHOTS_ROOT, { recursive: true });
  browser = await chromium.launch({ headless: true });
  app.listen(PORT, '127.0.0.1', () => {
    console.log(`site-screenshots listening on 127.0.0.1:${PORT}`);
  });
})();

process.on('SIGTERM', async () => {
  if (browser) await browser.close().catch(() => {});
  process.exit(0);
});
