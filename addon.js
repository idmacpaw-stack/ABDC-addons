const { addonBuilder } = require("stremio-addon-sdk");
const subs = require("./subtitles");

const API_KEY = process.env.GDRIVE_API_KEY;
const FOLDER_ID = process.env.GDRIVE_FOLDER_ID;
const SERIES_ID = "tt1145872"; // IMDb ID America's Best Dance Crew
const SERIES_NAME = "America's Best Dance Crew";
let MAPPING = {};
try { MAPPING = require("./mapping.json"); } catch (e) { /* tanpa mapping */ }
const VIDEO_EXT = /\.(mkv|mp4|avi|mov|m4v|webm|rmvb|3gp|flv|wmv|mpg|mpeg|ts)$/i;

if (!API_KEY || !FOLDER_ID) {
  throw new Error("Set environment variable GDRIVE_API_KEY dan GDRIVE_FOLDER_ID dulu.");
}

// ---------- Google Drive ----------
async function listFolder(folderId) {
  const files = [];
  let pageToken = "";
  do {
    const params = new URLSearchParams({
      q: `'${folderId}' in parents and trashed=false`,
      fields: "nextPageToken,files(id,name,mimeType,size)",
      pageSize: "1000",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
      key: API_KEY,
    });
    if (pageToken) params.set("pageToken", pageToken);
    const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`);
    if (!res.ok) throw new Error(`Drive API ${res.status}: ${await res.text()}`);
    const data = await res.json();
    files.push(...data.files);
    pageToken = data.nextPageToken || "";
  } while (pageToken);
  return files;
}

// Scan rekursif: folder utama bisa berisi subfolder per season
async function scan(folderId, folderName = "") {
  const items = await listFolder(folderId);
  let out = [];
  for (const f of items) {
    if (f.mimeType === "application/vnd.google-apps.folder") {
      out = out.concat(await scan(f.id, f.name));
    } else if (VIDEO_EXT.test(f.name)) {
      out.push({ ...f, folderName });
    }
  }
  return out;
}

function romanToInt(str) {
  const map = { i: 1, v: 5, x: 10 };
  const t = str.toLowerCase();
  let total = 0;
  for (let i = 0; i < t.length; i++) {
    const v = map[t[i]], n = map[t[i + 1]];
    total += n > v ? -v : v;
  }
  return total;
}

function folderSeason(name) {
  const m = name.match(/(?:season|musim)\s*([ivx]+|\d+)\b/i);
  if (!m) return null;
  return /^\d+$/.test(m[1]) ? +m[1] : romanToInt(m[1]);
}

function cleanTitle(name) {
  return name.replace(VIDEO_EXT, "").replace(/[._]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 90);
}

// Hasil: { season, episode, label } atau null jika perlu masuk "Specials"
function parseEpisode(file) {
  const fs = folderSeason(file.folderName);

  // S01E02 / 1x02
  let m = file.name.match(/S(\d{1,2})\s*E(\d{1,3})/i) || file.name.match(/\b(\d{1,2})x(\d{1,3})\b/i);
  if (m) return { season: +m[1], episode: +m[2], label: `Episode ${+m[2]}` };

  if (fs) {
    // "Week 3"
    m = file.name.match(/\bweek\s*(\d{1,2})\b/i);
    if (m) return { season: fs, episode: +m[1], label: `Week ${+m[1]}` };

    // 3 digit: 201, 607, 701 (digit pertama harus sama dengan nomor season folder)
    for (const x of file.name.matchAll(/(?<!\d)(\d{3})(?!\d)/g)) {
      const n = +x[1];
      if (Math.floor(n / 100) === fs && n % 100 > 0) {
        return { season: fs, episode: n % 100, label: `Episode ${n % 100}` };
      }
    }
  }
  return null;
}

let cache = { time: 0, episodes: [] };
async function getEpisodes() {
  if (Date.now() - cache.time < 10 * 60 * 1000 && cache.episodes.length) return cache.episodes;
  const files = await scan(FOLDER_ID);
  const episodes = [];
  const specials = [];
  for (const f of files) {
    const p = parseEpisode(f);
    if (p) {
      episodes.push({ ...p, fileId: f.id, fileName: f.name, size: f.size });
    } else {
      specials.push(f);
    }
  }
  // File yang tidak dikenali -> Season 0 (Specials), diurutkan menurut nama
  specials.sort((a, b) => a.name.localeCompare(b.name));
  specials.forEach((f, i) => {
    episodes.push({ season: 0, episode: i + 1, label: cleanTitle(f.name), fileId: f.id, fileName: f.name, size: f.size });
  });
  episodes.sort((a, b) => a.season - b.season || a.episode - b.episode);
  cache = { time: Date.now(), episodes };
  console.log(`Ditemukan ${episodes.length} file (${specials.length} masuk Specials).`);
  return episodes;
}

// ---------- Addon ----------
const manifest = {
  id: "community.abdc.gdrive",
  version: "1.2.0",
  name: "ABDC Drive",
  description: "America's Best Dance Crew dari Google Drive pribadi",
  resources: ["catalog", "meta", "stream", "subtitles"],
  types: ["series"],
  idPrefixes: [SERIES_ID],
  catalogs: [{ type: "series", id: "abdc-catalog", name: SERIES_NAME }],
};

const builder = new addonBuilder(manifest);

// ---------- Metadata IMDb (via Cinemeta, sumber metadata bawaan Stremio) ----------
let metaCache = { time: 0, meta: null };
async function getCinemeta() {
  if (Date.now() - metaCache.time < 24 * 60 * 60 * 1000 && metaCache.meta) return metaCache.meta;
  try {
    const res = await fetch(`https://v3-cinemeta.strem.io/meta/series/${SERIES_ID}.json`);
    if (!res.ok) throw new Error(`Cinemeta ${res.status}`);
    const data = await res.json();
    if (data && data.meta) {
      metaCache = { time: Date.now(), meta: data.meta };
      return data.meta;
    }
  } catch (err) {
    console.warn("Gagal ambil metadata Cinemeta:", err.message);
  }
  return metaCache.meta; // bisa null -> pakai fallback dari daftar file
}

builder.defineCatalogHandler(async () => {
  const cm = await getCinemeta();
  return {
    metas: [{
      id: SERIES_ID,
      type: "series",
      name: (cm && cm.name) || SERIES_NAME,
      poster: cm && cm.poster,
      description: cm && cm.description,
    }],
  };
});

builder.defineMetaHandler(async ({ id }) => {
  if (id !== SERIES_ID) return { meta: null };

  // 1) Utamakan metadata IMDb/Cinemeta: poster, deskripsi, daftar episode & judulnya
  const cm = await getCinemeta();
  if (cm) return { meta: { ...cm, id: SERIES_ID, type: "series" } };

  // 2) Fallback: daftar episode dari nama file di Drive
  const eps = await getEpisodes();
  const seen = new Map();
  for (const e of eps) {
    const key = `${e.season}:${e.episode}`;
    if (!seen.has(key)) seen.set(key, e);
  }
  const videos = [...seen.values()].map((e) => ({
    id: `${SERIES_ID}:${e.season}:${e.episode}`,
    title: e.label,
    season: e.season,
    episode: e.episode,
    released: new Date(Date.UTC(2000 + e.season, 0, e.episode)).toISOString(),
  }));
  return { meta: { id: SERIES_ID, type: "series", name: SERIES_NAME, videos } };
});

// File Drive yang cocok untuk satu episode IMDb (memakai mapping.json)
async function filesFor(season, episode) {
  const eps = await getEpisodes();
  const key = `${+season}:${+episode}`;
  const mapped = MAPPING[key];
  const targets = mapped === undefined ? [key] : [].concat(mapped);
  return eps.filter((e) => targets.includes(`${e.season}:${e.episode}`));
}

// Subtitle dicari berdasarkan nomor episode IMDb (bukan nomor di nama file)
const subCache = new Map();
async function subsFor(season, episode, extra = {}) {
  const k = `${+season}:${+episode}`;
  const hit = subCache.get(k);
  if (hit && Date.now() - hit.time < 30 * 60 * 1000) return hit.list;
  const matches = await filesFor(season, episode);
  const list = await subs.findSubtitles({
    imdbId: SERIES_ID, season: +season, episode: +episode,
    files: matches, extra, apiKey: API_KEY,
  });
  if (list.length) subCache.set(k, { time: Date.now(), list });
  return list;
}

builder.defineSubtitlesHandler(async ({ id, extra }) => {
  try {
    const [prefix, season, episode] = String(id).split(":");
    if (prefix !== SERIES_ID || !season || !episode) return { subtitles: [] };
    return { subtitles: await subsFor(season, episode, extra || {}) };
  } catch (err) {
    console.warn("Subtitle error:", err.message);
    return { subtitles: [] };
  }
});

builder.defineStreamHandler(async ({ id }) => {
  const [prefix, season, episode] = id.split(":");
  if (prefix !== SERIES_ID) return { streams: [] };
  const matches = await filesFor(season, episode);

  // Opsional (STREAM_SUBS=1): sisipkan subtitle di dalam stream. Default mati agar stream langsung muncul.
  let subtitles = [];
  if (process.env.STREAM_SUBS === "1" && matches.length) { // default MATI: bikin stream lambat
    subtitles = await Promise.race([
      subsFor(season, episode).catch(() => []),
      new Promise((r) => setTimeout(() => r([]), 7000)),
    ]);
  }
  return {
    streams: matches.map((e) => ({
      name: "Drive",
      title: e.fileName,
      url: `https://www.googleapis.com/drive/v3/files/${e.fileId}?alt=media&supportsAllDrives=true&key=${API_KEY}`,
      ...(subtitles.length ? { subtitles } : {}),
      behaviorHints: { bingeGroup: "abdc-drive", filename: e.fileName },
    })),
  };
});

async function debugHtml() {
  const [eps, cm] = await Promise.all([getEpisodes(), getCinemeta()]);
  const esc = (t) => String(t).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  const files = new Map();
  for (const e of eps) {
    const k = `${e.season}:${e.episode}`;
    if (!files.has(k)) files.set(k, []);
    files.get(k).push(e.fileName);
  }
  const imdb = ((cm && cm.videos) || [])
    .map((v) => ({
      season: +v.season,
      episode: +(v.episode ?? v.number),
      title: v.name || v.title || "",
      date: v.released ? String(v.released).slice(0, 10) : "",
    }))
    .sort((a, b) => a.season - b.season || a.episode - b.episode);

  const out = [];
  out.push(`Metadata IMDb/Cinemeta: ${cm ? "OK (" + imdb.length + " episode)" : "GAGAL DIAMBIL"}`);
  out.push(`File video terbaca: ${eps.length}`, "");

  const seasons = [...new Set([...imdb.map((v) => v.season), ...eps.map((e) => e.season)])].sort((a, b) => a - b);
  out.push("== RINGKASAN PER SEASON ==");
  for (const s of seasons) {
    const ni = imdb.filter((v) => v.season === s && v.episode > 0).length;
    const nf = new Set(eps.filter((e) => e.season === s).map((e) => e.episode)).size;
    out.push(`Season ${s}: IMDb ${ni} episode | file ${nf} episode ${ni === nf ? "(jumlah sama)" : "(JUMLAH BEDA)"}`);
  }

  out.push("", "== EPISODE IMDb -> FILE ==");
  for (const v of imdb) {
    const k = `${v.season}:${v.episode}`;
    const mapped = MAPPING[k];
    const targets = mapped === undefined ? [k] : [].concat(mapped);
    const f = targets.flatMap((t) => files.get(t) || []);
    const note = mapped !== undefined ? ` [mapping ${k} -> ${targets.join(", ") || "kosong"}]` : "";
    out.push(`S${v.season}E${v.episode} | ${v.date} | ${v.title}${note}\n     ${f.length ? f.join("\n     ") : "(TIDAK ADA FILE)"}`);
  }

  const used = new Set(imdb.flatMap((v) => {
    const k = `${v.season}:${v.episode}`;
    return MAPPING[k] === undefined ? [k] : [].concat(MAPPING[k]);
  }));
  out.push("", "== FILE YANG TIDAK DIPAKAI EPISODE IMDb MANA PUN ==");
  for (const k of files.keys()) {
    if (!used.has(k)) out.push(`S${k.replace(":", "E")}: ${files.get(k).join(" | ")}`);
  }
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ABDC debug</title><pre style="white-space:pre-wrap;font:13px/1.5 monospace;padding:12px">${esc(out.join("\n"))}</pre>`;
}

const addonInterface = builder.getInterface();
addonInterface.debugHtml = debugHtml;
addonInterface.filesFor = filesFor;
addonInterface.SERIES_ID = SERIES_ID;
addonInterface.API_KEY = API_KEY;
module.exports = addonInterface;
