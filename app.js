// Express app bersama: dipakai Vercel (api/index.js) dan lokal (server.js)
const express = require("express");
const { getRouter } = require("stremio-addon-sdk");
const addonInterface = require("./addon");
const { getSrt, diagnose, scanEpisode, scanSeason } = require("./subtitles");

const app = express();
const esc = (t) => String(t).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const page = (txt) =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><pre style="white-space:pre-wrap;font:13px/1.5 monospace;padding:12px">${esc(txt)}</pre>`;

// Halaman cek pencocokan episode IMDb <-> file Drive
app.get("/debug", async (req, res) => {
  try { res.type("html").send(await addonInterface.debugHtml()); }
  catch (err) { res.status(500).send(String(err)); }
});

// Halaman cek subtitle: /debug/subs?s=1&e=2
app.get("/debug/subs", async (req, res) => {
  try {
    const s = +req.query.s || 1, e = +req.query.e || 1;
    const files = await addonInterface.filesFor(s, e);
    const info = await diagnose({ imdbId: addonInterface.SERIES_ID, season: s, episode: e, files, apiKey: addonInterface.API_KEY });
    res.type("html").send(page(`Episode IMDb S${s}E${e} | file Drive cocok: ${files.length}\n\n` + JSON.stringify(info, null, 2)));
  } catch (err) { res.status(500).send(page(String(err.stack || err))); }
});


// Pindai subtitle seluruh episode IMDb: /debug/subs-all (daftar season) atau /debug/subs-all?s=1
async function pool(items, size, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}
const html = (body) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font:14px/1.5 system-ui,sans-serif;padding:12px}table{border-collapse:collapse}td,th{border:1px solid #8884;padding:4px 8px;text-align:left}.ok{background:#2a73}.no{opacity:.6}a{margin-right:10px}</style>${body}`;

app.get("/debug/subs-all", async (req, res) => {
  try {
    const cm = await addonInterface.getCinemeta();
    const vids = ((cm && cm.videos) || [])
      .map((v) => ({ season: +v.season, episode: +(v.episode ?? v.number), title: v.name || v.title || "", date: v.released ? String(v.released).slice(0, 10) : "" }))
      .filter((v) => v.season > 0 && v.episode > 0)
      .sort((a, b) => a.season - b.season || a.episode - b.episode);
    if (!vids.length) return res.type("html").send(html("Metadata episode (Cinemeta) gagal diambil. Coba lagi sebentar lagi."));
    const seasons = [...new Set(vids.map((v) => v.season))];
    const nav = seasons.map((n) => `<a href="?s=${n}">Season ${n} (${vids.filter((v) => v.season === n).length} ep)</a>`).join("");
    const s = req.query.s ? +req.query.s : null;
    if (s == null) return res.type("html").send(html(`<h3>Pindai subtitle per season</h3><p>Pilih season (tiap season dipindai ke SubDL dan OpenSubtitles):</p><p>${nav}</p>`));

    const list = vids.filter((v) => v.season === s);
    const [sea, rows] = await Promise.all([
      scanSeason({ imdbId: addonInterface.SERIES_ID, season: s }),
      pool(list, 6, async (v) => ({
        v,
        r: await scanEpisode({ imdbId: addonInterface.SERIES_ID, season: v.season, episode: v.episode }),
        files: (await addonInterface.filesFor(v.season, v.episode)).length,
      })),
    ]);
    const withSub = rows.filter((x) => (+x.r.strem || 0) + (+x.r.subdl || 0) > 0).length;
    const tr = rows.map(({ v, r, files }) => {
      const has = (+r.strem || 0) + (+r.subdl || 0) > 0;
      return `<tr class="${has ? "ok" : "no"}"><td>S${v.season}E${v.episode}</td><td>${esc(v.date)}</td><td>${esc(v.title)}</td><td>${files}</td><td>${r.strem}</td><td>${r.subdl}</td><td>${esc(r.langs.join(", "))}</td><td>${esc(r.err.join("; "))}</td></tr>`;
    }).join("");
    res.type("html").send(html(
      `<p>${nav}</p><h3>Season ${s}: ${withSub} dari ${rows.length} episode punya subtitle</h3>` +
      `<p>Paket season di SubDL: ${sea.packs}${sea.langs && sea.langs.length ? " (" + esc(sea.langs.join(", ")) + ")" : ""}${sea.err ? " — " + esc(sea.err) : ""}</p>` +
      `<table><tr><th>Episode</th><th>Tayang</th><th>Judul</th><th>File Drive</th><th>OpenSubtitles (Stremio)</th><th>SubDL</th><th>Bahasa</th><th>Error</th></tr>${tr}</table>`
    ));
  } catch (err) { res.status(500).send(page(String(err.stack || err))); }
});


// Thumbnail video dari Drive: /thumb/<fileId>.jpg  (kalau tidak ada -> background serial)
const thumbCache = new Map();
app.get("/thumb/:id", async (req, res) => {
  const id = req.params.id.replace(/\.(jpg|jpeg|png)$/i, "");
  const send = (buf, type) => {
    res.setHeader("Content-Type", type || "image/jpeg");
    res.setHeader("Cache-Control", "public, max-age=21600");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.send(buf);
  };
  try {
    if (!/^[\w-]{10,}$/.test(id)) throw new Error("id tidak valid");
    const hit = thumbCache.get(id);
    if (hit && Date.now() - hit.t < 6 * 3600 * 1000) return send(hit.buf, hit.type);
    const meta = await fetch(`https://www.googleapis.com/drive/v3/files/${id}?fields=thumbnailLink&supportsAllDrives=true&key=${addonInterface.API_KEY}`);
    const link = meta.ok ? (await meta.json()).thumbnailLink : null;
    if (link) {
      const img = await fetch(link.replace(/=s\d+.*$/, "=s640"));
      if (img.ok) {
        const buf = Buffer.from(await img.arrayBuffer());
        const type = img.headers.get("content-type") || "image/jpeg";
        thumbCache.set(id, { buf, type, t: Date.now() });
        return send(buf, type);
      }
    }
    throw new Error("Drive belum punya thumbnail untuk file ini");
  } catch (err) {
    const cm = await addonInterface.getCinemeta().catch(() => null);
    const bg = cm && (cm.background || cm.poster);
    res.setHeader("Cache-Control", "public, max-age=300");
    if (bg) return res.redirect(302, bg);
    res.status(404).type("text/plain").send(err.message);
  }
});

// Galeri cek thumbnail: /debug/thumbs?s=7
app.get("/debug/thumbs", async (req, res) => {
  try {
    const s = +req.query.s || 1;
    const meta = await addonInterface.metaFor(addonInterface.SERIES_ID);
    const vids = ((meta.meta && meta.meta.videos) || []).filter((v) => +v.season === s).sort((a, b) => a.episode - b.episode);
    const cards = vids.map((v) => `<div style="display:inline-block;margin:6px;width:220px;vertical-align:top"><div style="height:124px;background:#8883"><img src="${esc(v.thumbnail || "")}" loading="lazy" width="220" height="124" style="object-fit:cover"></div><small>S${v.season}E${v.episode}</small><br><small style="word-break:break-all;opacity:.6">${esc((v.thumbnail || "(kosong)").slice(0, 80))}</small></div>`).join("");
    res.type("html").send(html(`<h3>Thumbnail Season ${s} (${vids.length} episode)</h3><p>Ganti season: ?s=1, ?s=2, ...</p>${cards}`));
  } catch (err) { res.status(500).send(page(String(err.stack || err))); }
});

// Unduh + konversi subtitle jadi .srt UTF-8 (URL ini yang diberikan ke Stremio/Nuvio)
app.get("/sub/:src/:file", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  try {
    const key = req.params.file.replace(/\.srt$/i, "");
    const text = await getSrt(req.params.src, key, { s: req.query.s, e: req.query.e });
    res.setHeader("Content-Type", "application/x-subrip; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.send(text);
  } catch (err) {
    console.warn("Gagal unduh subtitle:", err.message);
    res.status(502).type("text/plain").send(err.message);
  }
});

app.use(getRouter(addonInterface));
module.exports = app;
