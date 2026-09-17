"use strict";

const path = require("path");
const fs = require("fs");

let loadedFromFile = false;
if (!process.env.TELEGRAM_BOT_TOKEN) {
  const envPath = path.join(__dirname, "..", ".env");
  if (fs.existsSync(envPath)) {
    require("dotenv").config({ path: envPath });
    loadedFromFile = true;
  }
}

const BASE_URL = (process.env.KONTER_BASE_URL || "https://konterkuota.com").replace(/\/+$/, "");
const COOKIE = process.env.KONTER_COOKIE || "";
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";

function getAllowedChatIds() {
  const raw = process.env.ALLOWED_CHAT_IDS || "";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (isNaN(Number(s)) ? s : Number(s)));
}

module.exports = {
  LOADED_FROM_FILE: loadedFromFile,
  BASE_URL,
  COOKIE,
  BOT_TOKEN,
  ALLOWED_CHAT_IDS: getAllowedChatIds(),
};
