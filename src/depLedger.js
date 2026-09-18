"use strict";

const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "..", "data", "deposit.json");

const locks = new Map();

async function acquireLock(key) {
  while (locks.get(key)) {
    await locks.get(key);
  }
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  locks.set(key, promise);
  return () => { locks.delete(key); resolve(); };
}

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch (e) {
    return [];
  }
}

async function save(list) {
  const release = await acquireLock("deposit");
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(list, null, 2));
  } finally {
    release();
  }
}

async function add(entry) {
  const release = await acquireLock("deposit");
  try {
    const list = load();
    list.push(entry);
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(list, null, 2));
    return entry;
  } finally {
    release();
  }
}

function get(depId) {
  return load().find((x) => String(x.depId) === String(depId));
}

function listByChat(chat, limit) {
  return load()
    .filter((x) => String(x.chat) === String(chat))
    .slice(-(limit || 20))
    .reverse();
}

function listAll(limit) {
  return load()
    .slice(-(limit || 100))
    .reverse();
}

module.exports = { load, add, get, listByChat, listAll };
