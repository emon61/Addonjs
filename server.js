const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const { execFile } = require("child_process");
const cheerio = require("cheerio");

const BASE = "https://www.pornhub.com";
const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  Cookie: "accessAgeDisclaimerPH=1; platform=pc",
};

const manifest = {
  id: "community.ph.addon",
  version: "1.0.0",
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
  const html = await res.text();
  const $ = cheerio.load(html);
  const items = [];
  $("li.pcVideoListItem[data-video-vkey]").each((_, el) => {
    const $el = $(el);
    const key = $el.attr("data-video-vkey");
    const title = $el.find("a[title]").first().attr("title");
    const img = $el.find("img").first();
    const poster =
      img.attr("data-mediumthumb") || img.attr("data-src") || img.attr("src");
    if (key && title) {
      items.push({ id: `ph:${key}`, type: "movie", name: title, poster });
    }
  });
  return items;
}

builder.defineCatalogHandler(async ({ extra }) => {
  const skip = parseInt(extra?.skip || 0, 10);
  const page = Math.floor(skip / 32) + 1;
  try {
    const metas = await fetchVideos({ search: extra?.search, page });
    return { metas };
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

builder.defineStreamHandler(async ({ id }) => {
  const key = id.replace("ph:", "");
  const pageUrl = `${BASE}/view_video.php?viewkey=${key}`;
  try {
    const urls = await ytdlpUrls(pageUrl);
    return {
      streams: urls.map((url) => ({
        url,
        name: "PH",
        title: "Direct stream",
        behaviorHints: { notWebReady: true },
      })),
    };
  } catch (e) {
    console.error("stream error:", e.message);
    return {
      streams: [
        {
          name: "PH error",
          title: String(e.message).slice(0, 200),
          externalUrl: pageUrl,
        },
      ],
    };
  }
});

serveHTTP(builder.getInterface(), { port: process.env.PORT || 7000 });
console.log("Addon running: http://127.0.0.1:7000/manifest.json");
