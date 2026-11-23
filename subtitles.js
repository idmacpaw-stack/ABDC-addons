// Subtitle dari OpenSubtitles + SUBDL untuk addon ABDC.
// Semua key diambil dari environment variable; sumber tanpa key otomatis dilewati.
const zlib = require("zlib");

const UA = "ABDC-Drive-Addon v1.2";
const OS_KEY = process.env.OPENSUBTITLES_API_KEY;
const OS_USER = process.env.OPENSUBTITLES_USERNAME;
const OS_PASS = process.env.OPENSUBTITLES_PASSWORD;
const SUBDL_KEY = process.env.SUBDL_API_KEY;
const LANGS = (process.env.SUB_LANGS || "id,en").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const PER_LANG = +(process.env.SUBS_PER_LANG || 3);
const NO_HASH = !!process.env.NO_HASH;

// Stremio memakai kode bahasa 3 huruf (ISO 639-2)
const LANG3 = { en: "eng", id: "ind", ms: "may", es: "spa", pt: "por", fr: "fre", de: "ger", ar: "ara", ja: "jpn", ko: "kor", zh: "chi", th: "tha", vi: "vie" };
const LANG_NAMES = { indonesian: "id", english: "en", malay: "ms", spanish: "es", portuguese: "pt", french: "fr", german: "de", arabic: "ar", japanese: "ja", korean: "ko", chinese: "zh", thai: "th", vietnamese: "vi" };

const b64u = (s) => Buffer.from(s, "utf8").toString("base64url");
const unb64u = (s) => Buffer.from(s, "base64url").toString("utf8");

function publicBase() {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, "");
  const h = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
  return h ? `https://${h}` : `http://127.0.0.1:${process.env.PORT || 7000}`;
}

async function fetchT(url, opts = {}, ms = 9000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ---------- Hash OpenSubtitles (size + 64 bit checksum 64KB awal & akhir) ----------
const hashCache = new Map();
async function hashFor(file, apiKey, ms = 9000) {
  if (NO_HASH || !file || !file.size) return null;
  if (hashCache.has(file.fileId)) return hashCache.get(file.fileId);
  const size = BigInt(file.size);
  if (size < 131072n) return null;
  const url = `https://www.googleapis.com/drive/v3/files/${file.fileId}?alt=media&supportsAllDrives=true&key=${apiKey}`;
  const part = async (range) => {
    const r = await fetchT(url, { headers: { Range: `bytes=${range}` } }, ms);
    if (r.status !== 206) { // jangan pernah mengunduh seluruh file
      if (r.body && r.body.cancel) r.body.cancel();
      throw new Error(`Range ditolak (${r.status})`);
    }
    return Buffer.from(await r.arrayBuffer());
  };
  const [a, b] = await Promise.all([part("0-65535"), part(`${size - 65536n}-${size - 1n}`)]);
  const MASK = (1n << 64n) - 1n;
  let h = size;
  for (const buf of [a, b]) for (let i = 0; i + 8 <= 65536; i += 8) h = (h + buf.readBigUInt64LE(i)) & MASK;
  const hex = h.toString(16).padStart(16, "0");
  hashCache.set(file.fileId, hex);
  return hex;
}

// ---------- Pencarian ----------
function normLang(x) {
  const t = String(x || "").toLowerCase().trim();
  return LANG_NAMES[t] || t.split(/[-_]/)[0];
}

async function searchOS({ imdbId, season, episode, hash }) {
  if (!OS_KEY) return [];
  const q = { episode_number: episode, languages: LANGS.join(","), parent_imdb_id: imdbId.replace(/^tt/, ""), season_number: season, type: "episode" };
  if (hash) q.moviehash = hash;
  const qs = Object.keys(q).sort().map((k) => `${k}=${encodeURIComponent(q[k])}`).join("&");
  const r = await fetchT(`https://api.opensubtitles.com/api/v1/subtitles?${qs}`, { headers: { "Api-Key": OS_KEY, "User-Agent": UA, Accept: "application/json" } });
  if (!r.ok) throw new Error(`OpenSubtitles cari ${r.status}`);
  const d = await r.json();
  return (d.data || []).map((x) => {
    const a = x.attributes || {};
    const f = (a.files || [])[0];
    if (!f) return null;
    return { src: "os", key: String(f.file_id), lang: normLang(a.language), release: a.release || f.file_name || "", hashMatch: !!a.moviehash_match, downloads: +a.download_count || 0 };
  }).filter(Boolean);
}

async function searchSubdl({ imdbId, season, episode }) {
  if (!SUBDL_KEY) return [];
  const p = new URLSearchParams({ api_key: SUBDL_KEY, imdb_id: imdbId, type: "tv", season_number: String(season), episode_number: String(episode), languages: LANGS.map((l) => l.toUpperCase()).join(","), subs_per_page: "30" });
  const r = await fetchT(`https://api.subdl.com/api/v1/subtitles?${p}`, { headers: { "User-Agent": UA } });
  if (!r.ok) throw new Error(`SUBDL cari ${r.status}`);
  const d = await r.json();
  if (d.status === false) throw new Error(`SUBDL: ${d.error || "gagal"}`);
  return (d.subtitles || []).map((x) => {
    if (!x.url) return null;
    return { src: "subdl", key: b64u(x.url), lang: normLang(x.language || x.lang), release: x.release_name || x.name || "", hashMatch: false, downloads: 0 };
  }).filter(Boolean);
}

// Kemiripan nama rilis subtitle dengan nama file kita (grup rilis, kualitas, dsb.)
const STOP = new Set(["americas", "america", "best", "dance", "crew", "randy", "jackson", "presents", "abdc", "srt", "avi", "mp4", "mkv", "com"]);
const tokens = (s) => new Set(String(s).toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1 && !STOP.has(t)));
function sim(release, name) {
  const a = tokens(release), b = tokens(name);
  if (!a.size) return 0;
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n / a.size;
}

async function findSubtitles({ imdbId, season, episode, files = [], extra = {}, apiKey }) {
  if (!OS_KEY && !SUBDL_KEY) return [];
  const names = [extra.filename, ...files.map((f) => f.fileName)].filter(Boolean);

  let hash = extra.videoHash || null;
  if (!hash) {
    for (const f of files.slice(0, 2)) {
      hash = await hashFor(f, apiKey).catch(() => null);
      if (hash) break;
    }
  }

  const [os, sd] = await Promise.all([
    searchOS({ imdbId, season, episode, hash }).catch((e) => (console.warn(e.message), [])),
    searchSubdl({ imdbId, season, episode }).catch((e) => (console.warn(e.message), [])),
  ]);

  const seen = new Set();
  const all = [...os, ...sd].filter((c) => LANGS.includes(c.lang) && !seen.has(c.src + c.key) && seen.add(c.src + c.key));
  for (const c of all) c.score = Math.max(0, ...names.map((n) => sim(c.release, n)));
  all.sort((a, b) => (b.hashMatch - a.hashMatch) || (b.score - a.score) || (b.downloads - a.downloads));

  const base = publicBase();
  const out = [];
  for (const lang of LANGS) {
    for (const c of all.filter((x) => x.lang === lang).slice(0, PER_LANG)) {
      out.push({ id: `${c.src}-${c.key}`, url: `${base}/sub/${c.src}/${c.key}.srt?s=${season}&e=${episode}`, lang: LANG3[lang] || lang });
    }
  }
  return out;
}

// ---------- Unduh & konversi (dipanggil oleh route /sub/...) ----------
let osAuth = { token: null, base: "https://api.opensubtitles.com/api/v1", time: 0 };
async function osLogin() {
  const r = await fetchT("https://api.opensubtitles.com/api/v1/login", {
    method: "POST",
    headers: { "Api-Key": OS_KEY, "User-Agent": UA, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ username: OS_USER, password: OS_PASS }),
  });
  if (!r.ok) throw new Error(`OpenSubtitles login ${r.status}`);
  const d = await r.json();
  const host = String(d.base_url || "api.opensubtitles.com").replace(/^https?:\/\//, "");
  osAuth = { token: d.token, base: `https://${host}/api/v1`, time: Date.now() };
}

async function osDownload(fileId) {
  if (!OS_KEY || !OS_USER || !OS_PASS) throw new Error("Username/password OpenSubtitles belum diisi");
  if (!osAuth.token || Date.now() - osAuth.time > 20 * 3600 * 1000) await osLogin();
  const call = () => fetchT(`${osAuth.base}/download`, {
    method: "POST",
    headers: { "Api-Key": OS_KEY, "User-Agent": UA, "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${osAuth.token}` },
    body: JSON.stringify({ file_id: +fileId, sub_format: "srt" }),
  });
  let r = await call();
  if (r.status === 401) { await osLogin(); r = await call(); }
  if (!r.ok) throw new Error(`OpenSubtitles unduh ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const d = await r.json();
  const f = await fetchT(d.link);
  if (!f.ok) throw new Error(`File subtitle ${f.status}`);
  return Buffer.from(await f.arrayBuffer());
}

function unzip(buf) {
  let i = buf.length - 22;
  while (i >= 0 && buf.readUInt32LE(i) !== 0x06054b50) i--;
  if (i < 0) throw new Error("ZIP tidak valid");
  const count = buf.readUInt16LE(i + 10);
  let off = buf.readUInt32LE(i + 16);
  const out = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10), csize = buf.readUInt32LE(off + 20);
    const nlen = buf.readUInt16LE(off + 28), elen = buf.readUInt16LE(off + 30), clen = buf.readUInt16LE(off + 32);
    const lho = buf.readUInt32LE(off + 42);
    const name = buf.toString("utf8", off + 46, off + 46 + nlen);
    off += 46 + nlen + elen + clen;
    const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    const raw = buf.subarray(start, start + csize);
    if (method === 0) out.push({ name, data: raw });
    else if (method === 8) out.push({ name, data: zlib.inflateRawSync(raw) });
  }
  return out;
}

function pickEntry(entries, s, e) {
  const srt = entries.filter((x) => /\.srt$/i.test(x.name));
  if (!srt.length) throw new Error("Tidak ada file .srt di dalam ZIP");
  if (srt.length === 1) return srt[0];
  const E = String(e).padStart(2, "0");
  const pats = [
    new RegExp(`s0*${s}[\\s._-]*e0*${e}(?!\\d)`, "i"),
    new RegExp(`(?<!\\d)0*${s}x0*${e}(?!\\d)`, "i"),
    new RegExp(`(?<!\\d)${s}${E}(?!\\d)`),
  ];
  for (const p of pats) {
    const hit = srt.find((x) => p.test(x.name));
    if (hit) return hit;
  }
  return srt[0];
}

function toUtf8(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder("utf-16le").decode(buf.subarray(2));
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) buf = buf.subarray(3);
  try { return new TextDecoder("utf-8", { fatal: true }).decode(buf); }
  catch { return new TextDecoder("windows-1252").decode(buf); }
}

async function getSrt(src, key, { s = 1, e = 1 } = {}) {
  let buf;
  if (src === "os") {
    if (!/^\d+$/.test(key)) throw new Error("ID tidak valid");
    buf = await osDownload(key);
  } else if (src === "subdl") {
    const path = unb64u(key);
    if (!/^\/subtitle\/[\w.-]+\.zip$/.test(path) || path.includes("..")) throw new Error("Path SUBDL tidak valid");
    const r = await fetchT(`https://dl.subdl.com${path}`, { headers: { "User-Agent": UA } }, 15000);
    if (!r.ok) throw new Error(`SUBDL unduh ${r.status}`);
    const entry = pickEntry(unzip(Buffer.from(await r.arrayBuffer())), +s, +e);
    buf = entry.data;
  } else {
    throw new Error("Sumber tidak dikenal");
  }
  return toUtf8(buf);
}

module.exports = { findSubtitles, getSrt, hashFor, _t: { unzip, pickEntry, toUtf8, b64u } };
