# Site Screenshot Scanner

Full-page screenshots of an entire website, from a single URL. No page list to maintain, no manual capturing. Point it at a domain and it finds every page itself.

![Landing screen](docs/screenshots/landing.png)

## Quick start

Requirements: Node.js 18+ and about 500MB free for the bundled Chromium download.

```bash
git clone https://github.com/JackB2003/site-screenshot-scanner.git
cd site-screenshot-scanner
npm install
npx playwright install --with-deps chromium
npm start
```

Open `http://localhost:3012`, enter a domain, and watch it go. That's the whole setup.

Want a different port?

```bash
PORT=8080 npm start
```

## Using it

1. Open the app in your browser.
2. Enter a domain (e.g. `example.com`) and, optionally, a max page count.
3. Watch pages get discovered and captured live.
4. Click any thumbnail for a full-size view, or download everything as a ZIP.

## Features

- **Zero-config discovery.** Reads `sitemap.xml` / `sitemap_index.xml` first, including nested sitemap indexes. No sitemap? It falls back to crawling links from the homepage, so it works on SPAs and JS-rendered sites too, not just static HTML.
- **True full-page capture.** Auto-scrolls each page before shooting so lazy-loaded content, images, and long layouts are captured in full, not just the first viewport.
- **Live progress.** A Server-Sent Events stream drives a terminal-style log and running counters (found / captured / errors) as the scan happens.
- **Gallery + ZIP export.** Thumbnails populate as each page finishes. Download everything as a single ZIP when the scan completes.
- **Same-domain safe.** Only follows links on the target's own domain, and automatically skips non-page assets (images, PDFs, stylesheets, scripts, fonts, media).
- **Configurable scope.** Cap a scan anywhere from 1 to 200 pages per run.

## Screenshots

| Discovering & capturing | Results gallery |
|---|---|
| ![Scan in progress](docs/screenshots/scanning.png) | ![Results gallery](docs/screenshots/results.png) |

## How it works

1. **Discovery.** Checks `/sitemap.xml` and `/sitemap_index.xml` first, following nested sitemap indexes up to 20 child sitemaps. If neither exists, it falls back to a breadth-first crawl from the homepage, using the rendered DOM (via Playwright) rather than raw HTML, so links revealed by client-side JavaScript are still found. It also opens common nav/menu buttons to surface links hidden behind dropdowns.
2. **Capture.** Every discovered URL is opened in a real Chromium browser, scrolled to the bottom to trigger lazy-loaded content, then captured with `fullPage: true`.
3. **Streaming feedback.** Every step (page found, page captured, error) is pushed to the browser in real time over SSE, so long scans aren't a silent wait.
4. **Export.** Screenshots are served individually or bundled into a ZIP on demand.

## Tech stack

- **Backend:** Node.js + Express, [Playwright](https://playwright.dev/) (Chromium) for rendering and capture
- **Frontend:** Plain HTML/CSS/JS, no framework, no build step
- **Streaming:** Server-Sent Events for scan progress
- **Packaging:** `archiver` for on-demand ZIP export

## API

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/scan` | Start a scan. Body: `{ "url": string, "maxPages"?: number }`. Returns `{ jobId }`. |
| `GET` | `/api/scan/:id/events` | SSE stream of scan progress for a job. |
| `GET` | `/api/scan/:id/shots/:file` | Fetch a single captured screenshot. |
| `GET` | `/api/scan/:id/zip` | Download all screenshots for a job as a ZIP. |

Scan jobs are held in memory and expire automatically 24 hours after completion.

## Deployment note

This tool fetches and renders whatever URL a user submits. That's the entire point when you're scanning your own sites. If you deploy it somewhere publicly reachable, put it behind authentication (or an IP allowlist) rather than exposing it to anonymous traffic on the open internet. An unauthenticated instance would let anyone make your server issue outbound requests.

## License

[MIT](LICENSE)
