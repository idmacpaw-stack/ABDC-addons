// Express app bersama: dipakai Vercel (api/index.js) dan lokal (server.js)
const express = require("express");
const { getRouter } = require("stremio-addon-sdk");
const addonInterface = require("./addon");
const { getSrt, diagnose } = require("./subtitles");

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
