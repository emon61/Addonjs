const http = require("http");
const { Readable } = require("stream");
const { addonBuilder, getRouter } = require("stremio-addon-sdk");
const { execFile } = require("child_process");
const cheerio = require("cheerio");

const PORT = process.env.PORT || 7000;
const PUBLIC = (process.env.RENDER_EXTERNAL_URL || `http://127.0.0.1:${PORT}`).replace(/\/$/, "");
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const HEADERS = {
  "User-Agent": UA,
  "Accept-Language": "en-US,en;q=0.9",
  Cookie: "accessAgeDisclaimerPH=1; platform=pc; age_verified=1",
};
const enc = encodeURIComponent;

// One entry per site. Add a new site by adding a block here.
const SITES = {
  "ph-new": {
    prefix: "ph", name: "Pornhub", base: "https://www.pornhub.com",
    list: (p) => `/video?page=${p}`,
    search: (q, p) => `/video/search?search=${enc(q)}&page=${p}`,
    item: "li.pcVideoListItem", hrefRe: /viewkey=/, pageSize: 32,
  },
  "xv-new": {
    prefix: "xv", name: "XVideos", base: "https://www.xvideos.com",
    list: (p) => `/new/${p - 1}`,
    search: (q, p) => `/?k=${enc(q)}&p=${p - 1}`,
    item: "div.thumb-block", hrefRe: /^\/video/, pageSize: 27,
  },
  "xh-new": {
    prefix: "xh", name: "xHamster", base: "https://xhamster.com",
    list: (p) => `/newest/${p}`,
    search: (q, p) => `/search/${enc(q)}?page=${p}`,
    item: "div.thumb-list__item", hrefRe: /\/videos\//, pageSize: 40,
  },
  "rt-new": {
    prefix: "rt", name: "RedTube", base: "https://www.redtube.com",
    list: (p) => `/newest?page=${p}`,
    search: (q, p) => `/?search=${enc(q)}&page=${p}`,
    item: "li.videoblock_list", hrefRe: /^\/\d+/, pageSize: 32,
  },
  "yp-new": {
    prefix: "yp", name: "YouPorn", base: "https://www.youporn.com",
    list: (p) => `/browse/time/?page=${p}`,
    search: (q, p) => `/search/?query=${enc(q)}&page=${p}`,
    item: "div.video-box", hrefRe: /\/watch\//, pageSize: 36,
  },
};
const BY_PREFIX = Object.fromEntries(Object.values(SITES).map((s) => [s.prefix, s]));

const manifest = {
  id: "community.multi.adult.addon",
  version: "2.0.0",
  name: "Adult Addon",
  description: "Browse, search and stream adult videos (18+)",
  resources: ["catalog", "meta", "stream"],
  types: ["movie"],
  idPrefixes: Object.values(SITES).map((s) => s.prefix + ":"),
  catalogs: Object.entries(SITES).map(([id, s]) => ({
    type: "movie", id, name: `${s.name} - Newest`,
    extra: [{ name: "search" }, { name: "skip" }],
  })),
  behaviorHints: { adult: true },
};

const builder = new addonBuilder(manifest);

const cache = new Map(); // id -> { name, poster }
function remember(id, v) {
  cache.set(id, v);
  if (cache.size > 5000) cache.delete(cache.keys().next().value);
}

const makeId = (site, path) => `${site.prefix}:${Buffer.from(path).toString("base64url")}`;
function parseId(id) {
  const i = id.indexOf(":");
  const site = BY_PREFIX[id.slice(0, i)];
  const path = Buffer.from(id.slice(i + 1), "base64url").toString();
  return { site, path, url: site.base + path };
}

async function fetchVideos(site, { search, page }) {
  const path = search ? site.search(search, page) : site.list(page);
  const res = await fetch(site.base + path, { headers: HEADERS });
  const $ = cheerio.load(await res.text());
  const items = [];
  const seen = new Set();
  $(site.item).each((_, el) => {
    const $el = $(el);
    const anchors = [];
    $el.find("a[href]").each((_, a) => {
      const href = $(a).attr("href");
      if (site.hrefRe.test(href)) anchors.push($(a));
    });
    if (!anchors.length) return;
    let u;
    try {
      u = new URL(anchors[0].attr("href"), site.base);
    } catch { return; }
    const vpath = u.pathname + u.search;
    const id = makeId(site, vpath);
    if (seen.has(id)) return;
    seen.add(id);
    let title = "";
    for (const a of anchors) {
      title = a.attr("title") || a.text().trim();
      if (title) break;
    }
    const img = $el.find("img").first();
    title = title || $el.find("[title]").first().attr("title") || img.attr("alt") || "Video";
    let poster =
      img.attr("data-mediumthumb") || img.attr("data-thumb_url") ||
      img.attr("data-original") || img.attr("data-src") || img.attr("src");
    if (poster && poster.startsWith("//")) poster = "https:" + poster;
    if (poster && poster.startsWith("data:")) poster = undefined;
    const meta = { id, type: "movie", name: title.replace(/\s+/g, " ").trim(), poster };
    remember(id, { name: meta.name, poster });
    items.push(meta);
  });
  console.log(`${site.name}: ${items.length} items (${path})`);
  return items;
}

builder.defineCatalogHandler(async ({ id, extra }) => {
  const site = SITES[id];
  if (!site) return { metas: [] };
  const skip = parseInt(extra?.skip || 0, 10);
  const page = Math.floor(skip / site.pageSize) + 1;
  try {
    return { metas: await fetchVideos(site, { search: extra?.search, page }) };
  } catch (e) {
    console.error(`catalog error (${site.name}):`, e.message);
    return { metas: [] };
  }
});

builder.defineMetaHandler(async ({ id }) => {
  try {
    const { url } = parseId(id);
    const c = cache.get(id) || {};
    return {
      meta: { id, type: "movie", name: c.name || "Video", poster: c.poster, website: url },
    };
  } catch {
    return { meta: { id, type: "movie", name: "Video" } };
  }
});

function ytdlpUrls(pageUrl) {
  return new Promise((resolve, reject) => {
    execFile(
      "yt-dlp",
      ["-g", "-f", "best[height<=1080]/best", pageUrl],
      { timeout: 40000 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error((stderr || err.message || "unknown").trim()));
        resolve(stdout.split("\n").map((s) => s.trim()).filter(Boolean));
      }
    );
  });
}

const wrap = (u, ref) =>
  `${PUBLIC}/proxy?u=${Buffer.from(u).toString("base64url")}&r=${Buffer.from(ref).toString("base64url")}`;

builder.defineStreamHandler(async ({ id }) => {
  let parsed;
  try { parsed = parseId(id); } catch { return { streams: [] }; }
  const { site, url: pageUrl } = parsed;
  try {
    const urls = await ytdlpUrls(pageUrl);
    return {
      streams: urls.slice(0, 1).map((u) => ({
        url: wrap(u, site.base + "/"),
        name: site.name,
        title: "Stream (via server)",
      })),
    };
  } catch (e) {
    console.error(`stream error (${site.name}):`, e.message);
    return {
      streams: [{ name: `${site.name} error`, title: String(e.message).slice(0, 200), externalUrl: pageUrl }],
    };
  }
});

async function handleProxy(req, res) {
  try {
    const q = new URL(req.url, "http://x").searchParams;
    const target = Buffer.from(q.get("u"), "base64url").toString();
    const ref = Buffer.from(q.get("r") || "", "base64url").toString();
    const headers = { "User-Agent": UA };
    if (ref) headers.Referer = ref;
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
            return line.replace(/URI="([^"]+)"/g, (_, x) => `URI="${wrap(new URL(x, base).href, ref)}"`);
          return wrap(new URL(t, base).href, ref);
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
