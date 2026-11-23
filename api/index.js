const express = require("express");
const { getRouter } = require("stremio-addon-sdk");
const addonInterface = require("../addon");

const app = express();
app.use(getRouter(addonInterface));
module.exports = app;
