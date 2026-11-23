// Jalankan lokal: node server.js
const app = require("./app");
const PORT = process.env.PORT || 7000;
app.listen(PORT, () => console.log(`Addon jalan: http://127.0.0.1:${PORT}/manifest.json`));
