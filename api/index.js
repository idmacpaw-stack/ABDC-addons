// Jika addon gagal dimuat, tampilkan pesan error aslinya (bukan 500 buram dari Vercel)
let app;
try {
  app = require("../app");
} catch (e) {
  app = (req, res) => {
    res.statusCode = 500;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Gagal memuat addon:\n\n" + (e && e.stack ? e.stack : String(e)));
  };
}
module.exports = app;
