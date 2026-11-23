const { addonBuilder } = require("stremio-addon-sdk");

const API_KEY = process.env.GDRIVE_API_KEY;
const FOLDER_ID = process.env.GDRIVE_FOLDER_ID;
const SERIES_ID = "abdc";
const SERIES_NAME = "America's Best Dance Crew";
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
  version: "1.0.0",
  name: "ABDC Drive",
  description: "America's Best Dance Crew dari Google Drive pribadi",
  resources: ["catalog", "meta", "stream"],
  types: ["series"],
  idPrefixes: [SERIES_ID],
  catalogs: [{ type: "series", id: "abdc-catalog", name: SERIES_NAME }],
};

const builder = new addonBuilder(manifest);

builder.defineCatalogHandler(async () => ({
  metas: [{ id: SERIES_ID, type: "series", name: SERIES_NAME }],
}));

builder.defineMetaHandler(async ({ id }) => {
  if (id !== SERIES_ID) return { meta: null };
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
    // Stremio butuh tanggal rilis untuk mengurutkan; ini hanya penanda urutan
    released: new Date(Date.UTC(2000 + e.season, 0, e.episode)).toISOString(),
  }));
  return { meta: { id: SERIES_ID, type: "series", name: SERIES_NAME, videos } };
});

builder.defineStreamHandler(async ({ id }) => {
  const [prefix, season, episode] = id.split(":");
  if (prefix !== SERIES_ID) return { streams: [] };
  const eps = await getEpisodes();
  const matches = eps.filter((e) => e.season === +season && e.episode === +episode);
  return {
    streams: matches.map((e) => ({
      name: "Drive",
      title: e.fileName,
      url: `https://www.googleapis.com/drive/v3/files/${e.fileId}?alt=media&supportsAllDrives=true&key=${API_KEY}`,
      behaviorHints: { bingeGroup: "abdc-drive" },
    })),
  };
});

module.exports = builder.getInterface();
