# YouTube Video Crawler

A Node.js crawler that scans a list of URLs and detects whether a specific YouTube video is embedded on each page. Uses a two-tier fetch strategy — fast HTTP requests first, full stealth headless browser as fallback for bot-protected pages.

---

## Requirements

- **Node.js** >= 18.0.0
- **npm**

---

## Installation

```bash
npm install
npx playwright install chromium
```

---

## Project Structure

```
MktOps/
├── Crawler-Sites.js          # Main crawler script
├── package.json
├── urls/
│   ├── urls-list.txt         # Input: list of URLs to crawl (one per line)
│   └── urls-blog.txt         # Additional URL list (alternate input)
└── resultados/
    └── resultados.jsonl      # Output: results in JSON Lines format
```

---

## Configuration

All settings are constants at the top of [`Crawler-Sites.js`](Crawler-Sites.js):

| Constant | Default | Description |
|---|---|---|
| `INPUT_FILE` | `./urls/urls-list.txt` | Path to the input URL list |
| `OUTPUT_FILE` | `./resultados/resultados.jsonl` | Path to the output results file |
| `VIDEO_ID` | `eiKEhwPUGY0` | YouTube video ID to search for |
| `CONCURRENCY` | `10` | Max parallel axios workers |
| `TIMEOUT` | `15000` | Request timeout in milliseconds |
| `RETRIES` | `2` | Number of retries on network errors |
| `PLAYWRIGHT_CONCURRENCY` | `3` | Max simultaneous headless browser sessions |

To search for a different video, change `VIDEO_ID` to the 11-character ID from the YouTube URL.  
For example, for `https://youtube.com/watch?v=eiKEhwPUGY0`, the ID is `eiKEhwPUGY0`.

---

## Usage

### Run the crawler

```bash
npm start
# or
node Crawler-Sites.js
```

### Input file format (`urls/urls-list.txt`)

One URL per line. Blank lines and lines starting with `#` are ignored.

```
# This is a comment — ignored
https://www.example.com/page-one
https://www.example.com/page-two
https://www.anothersite.com/article
```

Duplicate URLs are automatically deduplicated.

---

## How It Works

### Two-tier fetch strategy

Every URL goes through two layers, in order:

```
1. Axios (fast HTTP)
       │
       ├─ HTTP 200 → parse HTML → done
       │
       └─ HTTP 403 / 429 → hand off to Playwright
                               │
                               ├─ HTTP 200 → parse HTML → done
                               │
                               └─ HTTP 403 → record error
```

**Tier 1 — Axios**  
Fast, lightweight HTTP request. Sends a full set of stealth headers that mimic a real Chrome browser on Windows (User-Agent, `Sec-Fetch-*`, `sec-ch-ua` client hints, etc.). Handles redirects and decompression automatically. Covers the majority of pages.

**Tier 2 — Playwright + Stealth Plugin**  
Triggered automatically when Axios receives HTTP 403 or 429. Launches a real headless Chromium browser with [`puppeteer-extra-plugin-stealth`](https://github.com/berstend/puppeteer-extra/tree/master/packages/puppeteer-extra-plugin-stealth) applied, which patches 10+ browser fingerprinting vectors:
- Removes `navigator.webdriver = true`
- Fakes the `chrome` runtime object
- Normalises canvas, WebGL, and audio fingerprints
- Spoofs permission APIs

Up to `PLAYWRIGHT_CONCURRENCY` (3) browser contexts run in parallel. A single shared browser instance is reused across all fallback calls and closed cleanly when the crawl finishes.

### Video detection

The crawler searches the full HTML source of each page for the target video ID using five regex patterns:

| Pattern type | Example match |
|---|---|
| `youtube-watch` | `youtube.com/watch?v=VIDEO_ID` |
| `youtube-embed` | `youtube.com/embed/VIDEO_ID` |
| `youtube-nocookie` | `youtube-nocookie.com/embed/VIDEO_ID` |
| `youtu-be` | `youtu.be/VIDEO_ID` |
| `id` | bare `VIDEO_ID` anywhere in the HTML |

Duplicate matches are deduplicated before recording.

---

## Output Format

Results are written to `resultados/resultados.jsonl` in **JSON Lines** format — one JSON object per line.

### Successful match found
```json
{
  "url": "https://www.example.com/page",
  "finalUrl": "https://www.example.com/page",
  "status": 200,
  "found": true,
  "matches": [
    { "type": "youtube-embed", "value": "youtube.com/embed/eiKEhwPUGY0" }
  ]
}
```

### Page loaded, video not found
```json
{
  "url": "https://www.example.com/page",
  "finalUrl": "https://www.example.com/page",
  "status": 200,
  "found": false,
  "matches": []
}
```

### Page blocked or errored
```json
{
  "url": "https://www.example.com/protected",
  "found": false,
  "status": 403,
  "matches": [],
  "error": "HTTP 403"
}
```

### Field reference

| Field | Type | Description |
|---|---|---|
| `url` | string | Original URL from the input file |
| `finalUrl` | string | URL after redirects (may differ from `url`) |
| `status` | number | Final HTTP status code |
| `found` | boolean | `true` if the video ID was detected |
| `matches` | array | All occurrences found, with type and raw value |
| `error` | string | Present only when the request failed |

---

## Console Output

```
======================================
 YouTube Video Crawler
======================================
Vídeo: eiKEhwPUGY0
Concorrência: 10 (Playwright: 3)
Timeout: 15000ms
Retries: 2

URLs encontradas: 745

[1/745] 0.1% [----] https://www.example.com/page-one
[2/745] 0.3% [FOUND] https://www.example.com/page-two
  → [403] Switching to Playwright for https://www.example.com/protected
[3/745] 0.4% [ERROR] https://www.example.com/protected
```

Status tags in the log:

| Tag | Meaning |
|---|---|
| `[FOUND]` | Video ID detected on this page |
| `[----]` | Page loaded, video not present |
| `[ERROR]` | Request failed (timeout, 403, etc.) |

---

## Extracting errors for re-processing

To isolate URLs that errored and write them back to the input file for another run:

```bash
node -e "
import { readFileSync, writeFileSync } from 'fs';
const lines = readFileSync('resultados/resultados.jsonl', 'utf8').trim().split('\n');
const errors = lines.map(l => JSON.parse(l)).filter(r => r.error).map(r => r.url);
writeFileSync('urls/urls-list.txt', errors.join('\n') + '\n');
console.log(errors.length + ' URLs written');
" --input-type=module
```

Or with Python:

```bash
python3 -c "
import json
with open('resultados/resultados.jsonl') as f:
    urls = [json.loads(l)['url'] for l in f if json.loads(l).get('error')]
with open('urls/urls-list.txt', 'w') as f:
    f.write('\n'.join(urls) + '\n')
print(len(urls), 'URLs written')
"
```

---

## Known Limitations

Sites protected by **Akamai Bot Manager**, **Cloudflare**, or similar enterprise WAFs may still return 403 even after the Playwright stealth fallback. These systems fingerprint at the TLS handshake and network/IP level, which cannot be bypassed by any local tool. To crawl those pages, a **residential proxy service** (e.g. Bright Data, Oxylabs, Smartproxy) would be required.
