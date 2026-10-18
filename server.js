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
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
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
    list: (p) => (p === 1 ? "/" : `/new/${p - 1}`),
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
  "ep-new": {
    prefix: "ep", name: "Eporner", base: "https://www.eporner.com",
    list: (p) => `/api/v2/video/search/?query=all&per_page=30&page=${p}&thumbsize=big&order=latest&format=json`,
    search: (q, p) => `/api/v2/video/search/?query=${enc(q)}&per_page=30&page=${p}&thumbsize=big&order=top-weekly&format=json`,
    item: "x", pageSize: 30,
    parse: (j) =>
      (j.videos || []).map((v) => ({
        path: new URL(v.url).pathname,
        title: v.title,
        poster: v.default_thumb && v.default_thumb.src,
      })),
  },
  "xn-new": {
    prefix: "xn", name: "XNXX", base: "https://www.xnxx.com",
    list: (p) => (p === 1 ? "/" : `/new/${p}`),
    search: (q, p) => `/search/${enc(q)}/${p - 1}`,
    item: "div.thumb-block", hrefRe: /^\/video-/, pageSize: 27,
  },
  "t8-new": {
    prefix: "t8", name: "Tube8", base: "https://www.tube8.com",
    list: (p) => `/newest.html?page=${p}`,
    search: (q, p) => `/searches.html?q=${enc(q)}&page=${p}`,
    item: "figure.video_box, div.gridVideoBlock, li.videoblock_list, div.video-box",
    hrefRe: /porn-video|\/video\/|\/\d{6,}/, pageSize: 32,
  },
  "bg-new": {
    prefix: "bg", name: "Beeg", base: "https://beeg.com",
    list: () => "/",
    search: () => "/",
    item: "div", hrefRe: /^$/, pageSize: 48,
    custom: async (search, page, site) => {
      const off = (page - 1) * 48;
      const api = search
        ? `https://store.externulls.com/facts/search?query=${enc(search)}&limit=48&offset=${off}`
        : `https://store.externulls.com/facts/tag?slug=index&limit=48&offset=${off}`;
      const r = await fetch(api, {
        headers: { "User-Agent": UA, Accept: "application/json", Origin: "https://beeg.com", Referer: "https://beeg.com/" },
      });
      if (!r.ok) throw new Error("Beeg API HTTP " + r.status);
      const data = await r.json();
      const arr = Array.isArray(data) ? data : data.items || data.data || [];
      const out = [];
      for (const e of arr) {
        const f = e.file || e;
        const fid = f.id || e.fc_file_id || e.id;
        if (!fid) continue;
        const name = f.stuff?.sf_name || f.data?.[0]?.cd_value || e.title || "Beeg video";
        const poster = wrap(`https://thumbs.externulls.com/videos/${fid}/0.webp?size=480x270`, "https://beeg.com/");
        const id = makeId(site, `/-${fid}`);
        remember(id, { name, poster });
        out.push({ id, type: "movie", name, poster });
      }
      console.log(`Beeg: ${out.length} items`);
      return out;
    },
  },
};
const BY_PREFIX = Object.fromEntries(Object.values(SITES).map((s) => [s.prefix, s]));

// Themed rows: same site and scraper, but the "newest" list is a fixed search.
function themed(key, label, term) {
  const b = SITES[key];
  SITES[`${b.prefix}-${term}`] = { ...b, catName: label, list: (p) => b.search(term, p) };
}
themed("ph-new", "Pornhub - Japanese", "japanese");
themed("xv-new", "XVideos - Japanese", "japanese");
themed("xh-new", "xHamster - Japanese", "japanese");
themed("ep-new", "Eporner - Japanese", "japanese");
themed("xn-new", "XNXX - Japanese", "japanese");

const manifest = {
  id: "community.multi.adult.addon",
  version: "2.7.0",
  name: "Adult Addon",
  description: "Browse, search and stream adult videos (18+)",
  resources: ["catalog", "meta", "stream"],
  types: ["movie"],
  idPrefixes: Object.values(SITES).map((s) => s.prefix + ":"),
  catalogs: Object.entries(SITES).map(([id, s]) => ({
    type: "movie", id, name: s.catName || `${s.name} - Newest`,
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

function pickPoster(img, site) {
  const attrs = img.attr() || {};
  const order = ["data-mediumthumb", "data-thumb_url", "data-original", "data-src", "data-lazy", "data-poster", "src"];
  const vals = order.map((k) => attrs[k]).filter(Boolean);
  for (const v of Object.values(attrs)) if (/\.(jpe?g|png|webp)/i.test(v)) vals.push(v);
  for (const v of vals) {
    if (!v || v.startsWith("data:")) continue;
    try { return new URL(v, site.base).href; } catch {}
  }
  return undefined;
}

function scrapeByAnchors($, site) {
  const clean = (t) => (t || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  const isDur = (t) => /^\d{1,2}:\d{2}(:\d{2})?$/.test(t);
  const matches = (href) => href && site.hrefRe.test(href);
  const out = [];
  const seen = new Set();
  $("a[href]").each((_, a) => {
    const href = $(a).attr("href");
    if (!matches(href)) return;
    let u;
    try { u = new URL(href, site.base); } catch { return; }
    const vpath = u.pathname + u.search;
    if (seen.has(vpath)) return;
    seen.add(vpath);
    let box = $(a);
    let img = box.find("img").first();
    for (let i = 0; i < 3; i++) {
      const up = box.parent();
      if (!up.length) break;
      const hrefs = new Set();
      up.find("a[href]").each((_, x) => {
        const h = $(x).attr("href");
        if (matches(h)) hrefs.add(h.split("#")[0]);
      });
      if (hrefs.size > 1) break;
      box = up;
      if (!img.length) img = box.find("img").first();
    }
    const html = box.html() || "";
    let title = "";
    box.find("a[href]").each((_, x) => {
      if (title || !matches($(x).attr("href"))) return;
      const c = [$(x).attr("title"), $(x).attr("aria-label"), $(x).text()]
        .map(clean)
        .find((t) => t && !isDur(t));
      if (c) title = c;
    });
    if (!title) title = clean(img.attr("alt")) || clean(box.find("[title]").first().attr("title"));
    if (!title || isDur(title)) title = "Video";
    let poster = pickPoster(img, site);
    if (!poster) {
      const m = html.match(/https?:\/\/[^"'\s]+?\.(?:jpe?g|png|webp)/i);
      if (m) poster = m[0];
    }
    if (poster) poster = wrap(poster, site.base + "/");
    const id = makeId(site, vpath);
    remember(id, { name: title, poster });
    out.push({ id, type: "movie", name: title, poster });
  });
  return out;
}

async function fetchVideos(site, { search, page }) {
  if (site.custom) return site.custom(search, page, site);
  const path = search ? site.search(search, page) : site.list(page);
  const res = await fetch(site.base + path, { headers: HEADERS });
  if (!res.ok) console.error(`${site.name}: HTTP ${res.status} for ${path}`);
  if (site.parse) {
    const rows = site.parse(await res.json());
    const out = rows.map((r) => {
      const id = makeId(site, r.path);
      const poster = r.poster ? wrap(r.poster, site.base + "/") : undefined;
      remember(id, { name: r.title, poster });
      return { id, type: "movie", name: r.title, poster };
    });
    console.log(`${site.name}: ${out.length} items (${path})`);
    return out;
  }
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
    const html = $el.html() || "";
    const clean = (t) => (t || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    const isDur = (t) => /^\d{1,2}:\d{2}(:\d{2})?$/.test(t);
    let title = "";
    for (const a of anchors) {
      const cands = [a.attr("title"), a.attr("aria-label"), a.text()].map(clean);
      title = cands.find((t) => t && !isDur(t)) || "";
      if (title) break;
    }
    const img = $el.find("img").first();
    if (!title) title = clean($el.find("[title]").first().attr("title"));
    if (!title) title = clean(img.attr("alt"));
    if (!title) {
      const m = html.match(/alt="([^"]+)"/);
      if (m) title = clean(m[1]);
    }
    if (!title || isDur(title)) title = "Video";
    let poster = pickPoster(img, site);
    if (!poster) {
      const m = html.match(/https?:\/\/[^"'\s]+?\.(?:jpe?g|png|webp)/i);
      if (m) poster = m[0];
    }
    if (poster) poster = wrap(poster, site.base + "/");
    const meta = { id, type: "movie", name: title.replace(/\s+/g, " ").trim(), poster };
    remember(id, { name: meta.name, poster });
    items.push(meta);
  });
  if (items.length < 5) {
    const alt = scrapeByAnchors($, site);
    if (alt.length > items.length) {
      console.log(`${site.name}: fallback found ${alt.length} items (${path})`);
      return alt;
    }
  }
  console.log(`${site.name}: ${items.length} items (${path})`);
  return items;
}

const catCache = new Map();

builder.defineCatalogHandler(async ({ id, extra }) => {
  const site = SITES[id];
  if (!site) return { metas: [] };
  const skip = parseInt(extra?.skip || 0, 10);
  const page = Math.floor(skip / site.pageSize) + 1;
  try {
    const ck = `${id}|${extra?.search || ""}|${page}`;
    const hit = catCache.get(ck);
    if (hit && Date.now() - hit.t < 10 * 60 * 1000) return { metas: hit.v };
    const metas = await fetchVideos(site, { search: extra?.search, page });
    if (metas.length) {
      catCache.set(ck, { t: Date.now(), v: metas });
      if (catCache.size > 300) catCache.delete(catCache.keys().next().value);
    }
    return { metas };
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

function ytdlpJson(pageUrl) {
  return new Promise((resolve, reject) => {
    execFile(
      "yt-dlp",
      ["-J", "--no-playlist", pageUrl],
      { timeout: 45000, maxBuffer: 20 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error((stderr || err.message || "unknown").trim()));
        resolve(stdout);
      }
    );
  });
}

const qcache = new Map();
async function getQualities(pageUrl) {
  const hit = qcache.get(pageUrl);
  if (hit && Date.now() - hit.t < 10 * 60 * 1000) return hit.v;
  const info = JSON.parse(await ytdlpJson(pageUrl));
  const byH = new Map();
  for (const f of info.formats || []) {
    if (!f.url || !f.height) continue;
    if (f.vcodec === "none" || f.acodec === "none") continue;
    if (/dash|mhtml|rtmp|ism/.test(f.protocol || "")) continue;
    const cur = byH.get(f.height);
    if (!cur || (f.tbr || 0) > (cur.tbr || 0)) byH.set(f.height, f);
  }
  let out = [...byH.values()]
    .sort((a, b) => b.height - a.height)
    .slice(0, 6)
    .map((f) => ({
      url: f.url,
      label: `${f.height}p - ${/m3u8/.test(f.protocol || "") ? "HLS" : (f.ext || "video").toUpperCase()}`,
    }));
  if (!out.length && info.url) out = [{ url: info.url, label: "Best available" }];
  if (!out.length) throw new Error("No playable formats found");
  qcache.set(pageUrl, { t: Date.now(), v: out });
  if (qcache.size > 200) qcache.delete(qcache.keys().next().value);
  return out;
}

const wrap = (u, ref) =>
  `${PUBLIC}/proxy?u=${Buffer.from(u).toString("base64url")}&r=${Buffer.from(ref).toString("base64url")}`;

builder.defineStreamHandler(async ({ id }) => {
  let parsed;
  try { parsed = parseId(id); } catch { return { streams: [] }; }
  const { site, url: pageUrl } = parsed;
  try {
    const list = await getQualities(pageUrl);
    return {
      streams: list.map((q) => ({
        url: wrap(q.url, site.base + "/"),
        name: site.name,
        title: q.label,
      })),
    };
  } catch (e) {
    console.error(`stream error (${site.name}):`, e.message);
    return {
      streams: [{ name: `${site.name} error`, title: String(e.message).slice(0, 200), externalUrl: pageUrl }],
    };
  }
});

const imgCache = new Map();
let imgBytes = 0;
const IMG_MAX = 60 * 1024 * 1024;
function imgPut(k, v) {
  imgCache.set(k, v);
  imgBytes += v.buf.length;
  while (imgBytes > IMG_MAX) {
    const [fk, fv] = imgCache.entries().next().value;
    imgCache.delete(fk);
    imgBytes -= fv.buf.length;
  }
}

async function handleProxy(req, res) {
  try {
    const q = new URL(req.url, "http://x").searchParams;
    const target = Buffer.from(q.get("u"), "base64url").toString();
    const ref = Buffer.from(q.get("r") || "", "base64url").toString();
    const cached = imgCache.get(req.url);
    if (cached) {
      res.writeHead(200, {
        "content-type": cached.type,
        "content-length": cached.buf.length,
        "cache-control": "public, max-age=86400",
      });
      return res.end(cached.buf);
    }
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
    if ((h["content-type"] || "").startsWith("image/")) {
      h["cache-control"] = "public, max-age=86400";
      if (up.ok) {
        const buf = Buffer.from(await up.arrayBuffer());
        imgPut(req.url, { type: h["content-type"], buf });
        res.writeHead(200, {
          "content-type": h["content-type"],
          "content-length": buf.length,
          "cache-control": h["cache-control"],
        });
        return res.end(buf);
      }
    }
    res.writeHead(up.status, h);
    Readable.fromWeb(up.body).pipe(res);
  } catch (e) {
    res.writeHead(502);
    res.end(String(e.message));
  }
}

async function handleDebug(req, res) {
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  try {
    const c = new URL(req.url, "http://x").searchParams.get("c") || "";
    const site = SITES[c];
    if (!site) return res.end("Use /debug?c=" + Object.keys(SITES).join(" or /debug?c="));
    const url = site.base + site.list(1);
    const r = await fetch(url, { headers: HEADERS });
    const text = await r.text();
    const $ = cheerio.load(text);
    res.end(
      JSON.stringify(
        {
          url,
          status: r.status,
          finalUrl: r.url,
          length: text.length,
          itemsFound: $(site.item).length,
          pageTitle: $("title").first().text().trim(),
          sample: text.slice(0, 150).replace(/\s+/g, " "),
        },
        null,
        1
      )
    );
  } catch (e) {
    res.end("fetch failed: " + e.message);
  }
}

async function handleSelfTest(req, res) {
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  const log = [];
  const say = (k, v) => log.push(`${k}: ${v}`);
  try {
    const c = new URL(req.url, "http://x").searchParams.get("c") || "ph-new";
    const site = SITES[c];
    if (!site) return res.end("Use /selftest?c=" + Object.keys(SITES).join(" or /selftest?c="));
    let t = Date.now();
    const items = await fetchVideos(site, { page: 1 });
    say("1 catalog", `${items.length} items in ${Date.now() - t}ms`);
    if (!items.length) return res.end(log.join("\n") + "\nSTOP: catalog is empty");
    const { url: pageUrl } = parseId(items[0].id);
    say("video", items[0].name);
    t = Date.now();
    const qs = await getQualities(pageUrl);
    say("2 qualities", `${qs.length} found in ${Date.now() - t}ms: ${qs.map((q) => q.label).join(" | ")}`);
    for (const q of qs.slice(0, 2)) {
      t = Date.now();
      const r = await fetch(q.url, { headers: { "User-Agent": UA, Referer: site.base + "/" } });
      const ct = r.headers.get("content-type") || "";
      const isText = /mpegurl|text|json/.test(ct) || q.url.includes(".m3u8");
      let full = "";
      if (isText) full = await r.text();
      say(
        `3 open ${q.label}`,
        `HTTP ${r.status}, ${ct || "no type"}, ${r.headers.get("content-length") || "?"} bytes, ${Date.now() - t}ms` +
          (isText ? "\n   starts: " + full.slice(0, 160).replace(/\s+/g, " ") : "")
      );
      if (!isText && r.body) await r.body.cancel();
      const line = full.split("\n").map((x) => x.trim()).find((x) => x && !x.startsWith("#"));
      if (line) {
        const sr = await fetch(new URL(line, q.url).href, { headers: { "User-Agent": UA, Referer: site.base + "/" } });
        say("   first playlist entry", `HTTP ${sr.status}, ${sr.headers.get("content-type") || "no type"}`);
        if (sr.body) await sr.body.cancel();
      }
    }
  } catch (e) {
    say("ERROR", String(e.message).slice(0, 300));
  }
  res.end(log.join("\n"));
}

async function checkSite(key, site) {
  const label = site.catName || `${site.name} - Newest`;
  try {
    let count = 0;
    if (site.custom) {
      count = (await site.custom(null, 1, site)).length;
    } else {
      const r = await fetch(site.base + site.list(1), {
        headers: HEADERS,
        signal: AbortSignal.timeout(20000),
      });
      const text = await r.text();
      const title = (cheerio.load(text)("title").first().text() || "").trim();
      const blocked =
        [403, 429, 503].includes(r.status) ||
        /just a moment|attention required|cloudflare|access denied|captcha/i.test(title);
      if (blocked) return `BLOCKED  ${label}: HTTP ${r.status}, "${title.slice(0, 40)}"`;
      if (site.parse) {
        try { count = site.parse(JSON.parse(text)).length; } catch { count = 0; }
      } else {
        const $s = cheerio.load(text);
        count = $s(site.item).length;
        if (count < 5) count = Math.max(count, scrapeByAnchors($s, site).length);
      }
      if (!count) return `EMPTY    ${label}: loaded (HTTP ${r.status}) but 0 videos found`;
    }
    if (!count) return `EMPTY    ${label}: 0 videos found`;
    return `OK       ${label}: ${count} videos`;
  } catch (e) {
    return `ERROR    ${label}: ${String(e.message).slice(0, 80)}`;
  }
}

async function handleStatus(req, res) {
  const lines = await Promise.all(Object.entries(SITES).map(([k, v]) => checkSite(k, v)));
  lines.sort();
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Adult Addon health check\n\n" + lines.join("\n") + "\n");
}

async function warm() {
  for (const [id, site] of Object.entries(SITES)) {
    try {
      const metas = await fetchVideos(site, { page: 1 });
      if (metas.length) catCache.set(`${id}||1`, { t: Date.now(), v: metas });
    } catch {}
    await new Promise((r) => setTimeout(r, 1500));
  }
}
setTimeout(warm, 5000);
setInterval(warm, 8 * 60 * 1000);

const router = getRouter(builder.getInterface());
http
  .createServer((req, res) => {
    if (req.url.startsWith("/proxy")) return handleProxy(req, res);
    if (req.url.startsWith("/debug")) return handleDebug(req, res);
    if (req.url.startsWith("/status")) return handleStatus(req, res);
    if (req.url.startsWith("/selftest")) return handleSelfTest(req, res);
    router(req, res, () => {
      res.writeHead(404);
      res.end();
    });
  })
  .listen(PORT, () => console.log("Addon running on port " + PORT));
