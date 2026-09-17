"use strict";

const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "..", "data", "transaksi.json");

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch (e) {
    return [];
  }
}

function save(list) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(list, null, 2));
}

function add(entry) {
  const list = load();
  list.push(entry);
  save(list);
  return entry;
}

function get(trx) {
  return load().find((x) => String(x.trx) === String(trx));
}

function listByChat(chat, limit) {
  return load()
    .filter((x) => String(x.chat) === String(chat))
    .slice(-(limit || 10))
    .reverse();
}

function listAll(limit) {
  return load()
    .slice(-(limit || 10))
    .reverse();
}

function updateStatus(trx, patch) {
  const list = load();
  const e = list.find((x) => String(x.trx) === String(trx));
  if (!e) return null;
  Object.assign(e, patch, { updatedAt: Date.now() });
  save(list);
  return e;
}

module.exports = { load, add, get, listByChat, listAll, updateStatus };