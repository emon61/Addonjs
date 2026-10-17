const http = require("http");
const { Readable } = require("stream");
const { addonBuilder, getRouter } = require("stremio-addon-sdk");
const { execFile } = require("child_process");
const cheerio = require("cheerio");

const BASE = "https://www.pornhub.com";
const PORT = process.env.PORT || 7000;
const PUBLIC = (process.env.RENDER_EXTERNAL_URL || `http://127.0.0.1:${PORT}`).replace(/\/$/, "");
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const HEADERS = { "User-Agent": UA, Cookie: "accessAgeDisclaimerPH=1; platform=pc" };

const manifest = {
  id: "community.ph.addon",
  version: "1.0.2",
  name: "PH Addon",
  description: "Browse, search and stream adult videos (18+)",
  resources: ["catalog", "meta", "stream"],
  types: ["movie"],
  idPrefixes: ["ph:"],
  catalogs: [
    {
      type: "movie",
      id: "ph-recent",
      name: "PH - Recently Featured",
      extra: [{ name: "search" }, { name: "skip" }],
    },
  ],
  behaviorHints: { adult: true },
};

const builder = new addonBuilder(manifest);

async function fetchVideos({ search, page }) {
  const url = search
    ? `${BASE}/video/search?search=${encodeURIComponent(search)}&page=${page}`
    : `${BASE}/video?page=${page}`;
  const res = await fetch(url, { headers: HEADERS });
  const $ = cheerio.load(await res.text());
  const items = [];
  $("li.pcVideoListItem[data-video-vkey]").each((_, el) => {
    const $el = $(el);
    const key = $el.attr("data-video-vkey");
    const title = $el.find("a[title]").first().attr("title");
    const img = $el.find("img").first();
    const poster =
      img.attr("data-mediumthumb") || img.attr("data-src") || img.attr("src");
    if (key && title) items.push({ id: `ph:${key}`, type: "movie", name: title, poster });
  });
  return items;
}

builder.defineCatalogHandler(async ({ extra }) => {
  const skip = parseInt(extra?.skip || 0, 10);
  const page = Math.floor(skip / 32) + 1;
  try {
    return { metas: await fetchVideos({ search: extra?.search, page }) };
  } catch (e) {
    console.error("catalog error:", e.message);
    return { metas: [] };
  }
});

builder.defineMetaHandler(async ({ id }) => {
  const key = id.replace("ph:", "");
  return {
    meta: {
      id,
      type: "movie",
      name: `Video ${key}`,
      website: `${BASE}/view_video.php?viewkey=${key}`,
    },
  };
});

function ytdlpUrls(pageUrl) {
  return new Promise((resolve, reject) => {
    execFile(
      "yt-dlp",
      ["-g", "-f", "best[height<=1080]/best", pageUrl],
      { timeout: 30000 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error((stderr || err.message || "unknown").trim()));
        resolve(stdout.split("\n").map((s) => s.trim()).filter(Boolean));
      }
    );
  });
}

const wrap = (u) => `${PUBLIC}/proxy?u=${Buffer.from(u).toString("base64url")}`;

builder.defineStreamHandler(async ({ id }) => {
  const key = id.replace("ph:", "");
  const pageUrl = `${BASE}/view_video.php?viewkey=${key}`;
  try {
    const urls = await ytdlpUrls(pageUrl);
    return {
      streams: urls.slice(0, 1).map((url) => ({
        url: wrap(url),
        name: "PH",
        title: "Stream (via server)",
      })),
    };
  } catch (e) {
    console.error("stream error:", e.message);
    return {
      streams: [
        { name: "PH error", title: String(e.message).slice(0, 200), externalUrl: pageUrl },
      ],
    };
  }
});

async function handleProxy(req, res) {
  try {
    const u = new URL(req.url, "http://x").searchParams.get("u");
    const target = Buffer.from(u, "base64url").toString();
    const headers = { "User-Agent": UA, Referer: BASE + "/" };
    if (req.headers.range) headers.Range = req.headers.range;
    const up = await fetch(target, { headers });
    const ct = up.headers.get("content-type") || "";
    if (target.includes(".m3u8") || ct.includes("mpegurl")) {
      const text = await up.text();
      const base = new URL(target);
      const out = text
        .split("\n")
        .map((line) => {
          const t = line.trim();
          if (!t) return line;
          if (t.startsWith("#"))
            return line.replace(/URI="([^"]+)"/g, (_, x) => `URI="${wrap(new URL(x, base).href)}"`);
          return wrap(new URL(t, base).href);
        })
        .join("\n");
      res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" });
      return res.end(out);
    }
    const h = {};
    for (const k of ["content-type", "content-length", "content-range", "accept-ranges"]) {
      const v = up.headers.get(k);
      if (v) h[k] = v;
    }
    res.writeHead(up.status, h);
    Readable.fromWeb(up.body).pipe(res);
  } catch (e) {
    res.writeHead(502);
    res.end(String(e.message));
  }
}

const router = getRouter(builder.getInterface());
http
  .createServer((req, res) => {
    if (req.url.startsWith("/proxy")) return handleProxy(req, res);
    router(req, res, () => {
      res.writeHead(404);
      res.end();
    });
  })
  .listen(PORT, () => console.log("Addon running on port " + PORT));
