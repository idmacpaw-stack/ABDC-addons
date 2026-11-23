const express = require("express");
const { getRouter } = require("stremio-addon-sdk");
const addonInterface = require("../addon");

const app = express();

// Halaman cek pencocokan episode IMDb <-> file Drive
app.get("/debug", async (req, res) => {
  try {
    res.type("html").send(await addonInterface.debugHtml());
  } catch (err) {
    res.status(500).send(String(err));
  }
});

app.use(getRouter(addonInterface));
module.exports = app;
