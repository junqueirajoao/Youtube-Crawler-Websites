import fs from "node:fs";
import readline from "node:readline";
import axios from "axios";
import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

// Register stealth plugin — patches fingerprints that sites use to detect headless browsers
chromium.use(StealthPlugin());

// ---------------------------------------------------------
// Config
// ---------------------------------------------------------

const INPUT_FILE = "./urls/urls-list.txt";
const OUTPUT_FILE = "./resultados/resultados.jsonl";

const VIDEO_ID = "eiKEhwPUGY0";

const CONCURRENCY = 10;   // reduced a bit since Playwright workers are heavier
const TIMEOUT = 15_000;   // ms
const RETRIES = 2;

// How many Playwright browser contexts to keep open simultaneously.
// Each context is a full headless Chrome session, so keep this low.
const PLAYWRIGHT_CONCURRENCY = 3;

// ---------------------------------------------------------
// Stealth headers — look like a real Chrome on Windows
// ---------------------------------------------------------

const STEALTH_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
    "AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/124.0.0.0 Safari/537.36",
  "Accept":
    "text/html,application/xhtml+xml,application/xml;q=0.9," +
    "image/avif,image/webp,image/apng,*/*;q=0.8",
  "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
  "Accept-Encoding": "gzip, deflate, br",
  "Connection": "keep-alive",
  "Upgrade-Insecure-Requests": "1",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
  "sec-ch-ua":
    '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
  "Cache-Control": "max-age=0",
};

// ---------------------------------------------------------
// Utilities
// ---------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------
// Detect the video ID in different YouTube embed formats
// ---------------------------------------------------------

function findYoutubeVideo(html, videoId) {
  const id = escapeRegExp(videoId);

  const patterns = [
    {
      type: "youtube-watch",
      regex: new RegExp(
        `(?:https?:\\/\\/)?(?:www\\.)?youtube\\.com\\/watch\\?[^"'\\s<>]*\\bv=${id}(?:[^"'\\s<>]*)?`,
        "g"
      ),
    },
    {
      type: "youtube-embed",
      regex: new RegExp(
        `(?:https?:\\/\\/)?(?:www\\.)?youtube\\.com\\/embed\\/${id}(?:[^"'\\s<>]*)?`,
        "g"
      ),
    },
    {
      type: "youtube-nocookie",
      regex: new RegExp(
        `(?:https?:\\/\\/)?(?:www\\.)?youtube-nocookie\\.com\\/embed\\/${id}(?:[^"'\\s<>]*)?`,
        "g"
      ),
    },
    {
      type: "youtu-be",
      regex: new RegExp(
        `(?:https?:\\/\\/)?youtu\\.be\\/${id}(?:[^"'\\s<>]*)?`,
        "g"
      ),
    },
    // Bare ID match
    {
      type: "id",
      regex: new RegExp(
        `(?<![A-Za-z0-9_-])${id}(?![A-Za-z0-9_-])`,
        "g"
      ),
    },
  ];

  const matches = [];

  for (const pattern of patterns) {
    const found = html.match(pattern.regex);
    if (!found) continue;
    for (const value of found) {
      matches.push({ type: pattern.type, value });
    }
  }

  // Deduplicate
  return [
    ...new Map(
      matches.map((item) => [`${item.type}:${item.value}`, item])
    ).values(),
  ];
}

// ---------------------------------------------------------
// Axios fetch — fast, low overhead, good stealth headers
// ---------------------------------------------------------

async function fetchWithAxios(url) {
  const response = await axios.get(url, {
    timeout: TIMEOUT,
    maxRedirects: 10,
    headers: STEALTH_HEADERS,
    // Return the raw response even on 4xx/5xx so we can inspect the status
    validateStatus: () => true,
    // Decompress automatically
    decompress: true,
  });

  return {
    status: response.status,
    finalUrl: response.request?.res?.responseUrl || url,
    contentType: response.headers["content-type"] || "",
    data: typeof response.data === "string" ? response.data : "",
  };
}

// ---------------------------------------------------------
// Playwright fetch — full headless Chrome with stealth plugin
// Used as fallback when axios gets a 403.
// ---------------------------------------------------------

// Single shared browser instance — started lazily, reused across all fallback calls.
let _browser = null;

async function getBrowser() {
  if (!_browser) {
    _browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-blink-features=AutomationControlled",
        "--disable-dev-shm-usage",
      ],
    });
  }
  return _browser;
}

async function closeBrowser() {
  if (_browser) {
    await _browser.close();
    _browser = null;
  }
}

// Semaphore to limit concurrent Playwright contexts
let _playwrightActive = 0;

async function acquirePlaywrightSlot() {
  while (_playwrightActive >= PLAYWRIGHT_CONCURRENCY) {
    await sleep(200);
  }
  _playwrightActive++;
}

function releasePlaywrightSlot() {
  _playwrightActive--;
}

async function fetchWithPlaywright(url) {
  await acquirePlaywrightSlot();

  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent: STEALTH_HEADERS["User-Agent"],
    locale: "pt-BR",
    timezoneId: "America/Sao_Paulo",
    extraHTTPHeaders: {
      "Accept-Language": STEALTH_HEADERS["Accept-Language"],
    },
    viewport: { width: 1366, height: 768 },
  });

  const page = await context.newPage();

  try {
    // Hide navigator.webdriver and other automation tells
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", {
        get: () => false,
      });
    });

    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: TIMEOUT,
    });

    const status = response?.status() ?? 0;
    const finalUrl = page.url();

    // Wait a short moment to let inline scripts populate the DOM
    await sleep(500);

    const html = await page.content();

    return { status, finalUrl, contentType: "text/html", data: html };
  } finally {
    await context.close();
    releasePlaywrightSlot();
  }
}

// ---------------------------------------------------------
// Process a single URL — axios first, Playwright on 403
// ---------------------------------------------------------

async function processUrl(url) {
  let lastError = null;

  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try {
      // --- Step 1: try with Axios ---
      let result = await fetchWithAxios(url);

      // --- Step 2: if blocked, retry with Playwright ---
      if (result.status === 403 || result.status === 429) {
        console.log(`  → [${result.status}] Switching to Playwright for ${url}`);
        result = await fetchWithPlaywright(url);
      }

      // --- Step 3: non-OK statuses that aren't 403/429 ---
      if (result.status !== 200 && result.status !== 0) {
        // Only return error without retrying for hard errors
        if (result.status >= 400) {
          return {
            url,
            found: false,
            status: result.status,
            matches: [],
            error: `HTTP ${result.status}`,
          };
        }
      }

      // --- Step 4: skip non-HTML content ---
      if (
        !result.contentType.includes("text/html") &&
        !result.contentType.includes("application/xhtml+xml")
      ) {
        return {
          url,
          found: false,
          status: result.status,
          matches: [],
          error: `Content-Type não suportado: ${result.contentType}`,
        };
      }

      const matches = findYoutubeVideo(result.data, VIDEO_ID);

      return {
        url,
        finalUrl: result.finalUrl,
        status: result.status,
        found: matches.length > 0,
        matches,
      };
    } catch (error) {
      lastError = error;

      if (attempt < RETRIES) {
        const delay = 500 * Math.pow(2, attempt);
        await sleep(delay);
      }
    }
  }

  return {
    url,
    found: false,
    matches: [],
    error:
      lastError?.code === "ECONNABORTED" || lastError?.name === "AbortError"
        ? "Timeout"
        : lastError?.message || "Erro desconhecido",
  };
}

// ---------------------------------------------------------
// Load URLs from file
// ---------------------------------------------------------

async function loadUrls(filename) {
  const urls = new Set();

  const stream = fs.createReadStream(filename, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    const url = line.trim();
    if (!url || url.startsWith("#")) continue;
    urls.add(url);
  }

  return [...urls];
}

// ---------------------------------------------------------
// Concurrency pool
// ---------------------------------------------------------

async function processInPool(urls) {
  const results = [];

  let index = 0;
  let completed = 0;

  async function worker() {
    while (true) {
      const currentIndex = index++;
      if (currentIndex >= urls.length) return;

      const url = urls[currentIndex];
      const result = await processUrl(url);

      results[currentIndex] = result;
      completed++;

      const percentage = ((completed / urls.length) * 100).toFixed(1);
      const status = result.found ? "FOUND" : result.error ? "ERROR" : "----";

      console.log(
        `[${completed}/${urls.length}] ${percentage}% [${status}] ${url}`
      );
    }
  }

  const workerCount = Math.min(CONCURRENCY, urls.length);
  const workers = [];

  for (let i = 0; i < workerCount; i++) {
    workers.push(worker());
  }

  await Promise.all(workers);

  return results;
}

// ---------------------------------------------------------
// Main
// ---------------------------------------------------------

async function main() {
  console.log("======================================");
  console.log(" YouTube Video Crawler");
  console.log("======================================");
  console.log(`Vídeo: ${VIDEO_ID}`);
  console.log(`Concorrência: ${CONCURRENCY} (Playwright: ${PLAYWRIGHT_CONCURRENCY})`);
  console.log(`Timeout: ${TIMEOUT}ms`);
  console.log(`Retries: ${RETRIES}`);
  console.log("");

  const urls = await loadUrls(INPUT_FILE);

  console.log(`URLs encontradas: ${urls.length}`);
  console.log("");

  if (urls.length === 0) {
    console.log("Nenhuma URL encontrada.");
    return;
  }

  const results = await processInPool(urls);

  // Shut down the shared Playwright browser (if it was started)
  await closeBrowser();

  // Write JSONL output
  const output = fs.createWriteStream(OUTPUT_FILE);
  for (const result of results) {
    output.write(JSON.stringify(result) + "\n");
  }
  output.end();

  // Summary
  const found = results.filter((r) => r.found);
  const errors = results.filter((r) => r.error);

  console.log("");
  console.log("======================================");
  console.log(" FINALIZADO");
  console.log("======================================");
  console.log(`Total: ${results.length}`);
  console.log(`Encontrados: ${found.length}`);
  console.log(`Não encontrados: ${results.length - found.length}`);
  console.log(`Erros: ${errors.length}`);
  console.log("");
  console.log(`Resultado salvo em: ${OUTPUT_FILE}`);

  if (found.length > 0) {
    console.log("");
    console.log("URLs que possuem o vídeo:");
    for (const result of found) {
      console.log(`  ${result.url}`);
      for (const match of result.matches) {
        console.log(`    [${match.type}] ${match.value}`);
      }
    }
  }
}

main().catch((error) => {
  console.error("Erro fatal:", error);
  process.exit(1);
});
