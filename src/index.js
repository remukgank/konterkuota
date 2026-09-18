"use strict";

const { initBot, isAllowed, guard, reply, inlineButtons, removeKeyboard } = require("../bot/telegram");
const { loadCatalog, searchProducts, formatHarga } = require("./harga");
const akun = require("./akun");
const order = require("./order");
const ledger = require("./ledger");
const depLedger = require("./depLedger");
const { generateStruk, roundSell, formatRp } = require("./struk");
const { getBuffer, request } = require("./konterApi");
const { BASE_URL, LOADED_FROM_FILE } = require("./config");
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const bot = initBot();

const states = new Map();
const STATE_TTL = 30 * 60 * 1000; // 30 minutes
const STATE_CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 minutes

function cleanupStates() {
  const now = Date.now();
  for (const [chatId, st] of states.entries()) {
    if (st.updatedAt && now - st.updatedAt > STATE_TTL) {
      states.delete(chatId);
    }
  }
}

setInterval(cleanupStates, STATE_CLEANUP_INTERVAL);

const rateLimits = new Map();
const RATE_LIMIT_WINDOW = 1000; // 1 second
const RATE_LIMIT_MAX = 3; // max 3 requests per window

function isRateLimited(chatId) {
  const now = Date.now();
  const timestamps = rateLimits.get(chatId) || [];
  const recent = timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW);
  if (recent.length >= RATE_LIMIT_MAX) return true;
  recent.push(now);
  rateLimits.set(chatId, recent);
  return false;
}

bot.on("message", (msg) => {
  const chatId = msg.chat && msg.chat.id;
  const txt = (msg.text || "").replace(/\n/g, " ");
  console.log(`[MSG] chat=${chatId} ${JSON.stringify(txt)}`);
});

bot.on("callback_query", (q) => {
  const chatId = q.message && q.message.chat && q.message.chat.id;
  console.log(`[CB]  chat=${chatId} data=${JSON.stringify(q.data)}`);
});

function getState(chatId) {
  if (!states.has(chatId)) states.set(chatId, {});
  const st = states.get(chatId);
  st.updatedAt = Date.now();
  return st;
}

function clearState(chatId) {
  // Clear QRIS polls if any
  if (QRIS_POLLS[chatId]) {
    clearTimeout(QRIS_POLLS[chatId].timer);
    delete QRIS_POLLS[chatId];
  }
  states.delete(chatId);
}

function clearDep(chatId) {
  const st = states.get(chatId);
  if (st) {
    delete st.dep;
    delete st.depStep;
    delete st.depMsg;
  }
}

async function depEdit(msg, st, text, rows) {
  if (!st) st = getState(msg.chat.id);
  const kb =
    rows && rows.length
      ? inlineButtons(rows).reply_markup
      : { inline_keyboard: [] };
  const body = { parse_mode: "Markdown", reply_markup: kb };
  if (!st.depMsg) {
    const sent = await reply(msg, text, body);
    st.depMsg = sent.message_id;
    return sent;
  }
  try {
    return await bot.editMessageText(msg.chat.id, st.depMsg, text, body);
  } catch (e) {
    const desc = ((e && (e.description || e.message)) || "").toLowerCase();
    if (desc.includes("not modified")) return null;
    const sent = await reply(msg, text, body);
    st.depMsg = sent.message_id;
    return sent;
  }
}

async function depNew(msg, st, text, rows) {
  if (!st) st = getState(msg.chat.id);
  const kb =
    rows && rows.length
      ? inlineButtons(rows).reply_markup
      : { inline_keyboard: [] };
  if (st.depMsg) await bot.deleteMessage(msg.chat.id, st.depMsg).catch(() => {});
  const body = { parse_mode: "Markdown", reply_markup: kb, reply_to_message_id: msg.message_id };
  let sent;
  try {
    sent = await reply(msg, text, body);
  } catch (e) {
    sent = await bot.sendMessage(msg.chat.id, text, { reply_markup: kb, reply_to_message_id: msg.message_id });
  }
  st.depMsg = sent.message_id;
  return sent;
}

async function flowEdit(msg, st, text, rows) {
  if (!st) st = getState(msg.chat.id);
  const kb =
    rows && rows.length
      ? inlineButtons(rows).reply_markup
      : { inline_keyboard: [] };
  const body = { parse_mode: "Markdown", reply_markup: kb };
  if (!st.flowMsg) {
    const sent = await reply(msg, text, body);
    st.flowMsg = sent.message_id;
    return sent;
  }
  try {
    return await bot.editMessageText(msg.chat.id, st.flowMsg, text, body);
  } catch (e) {
    const desc = ((e && (e.description || e.message)) || "").toLowerCase();
    if (desc.includes("not modified")) return null;
    const sent = await reply(msg, text, body);
    st.flowMsg = sent.message_id;
    return sent;
  }
}

async function flowNew(msg, st, text, rows) {
  if (!st) st = getState(msg.chat.id);
  const kb =
    rows && rows.length
      ? inlineButtons(rows).reply_markup
      : { inline_keyboard: [] };
  if (st.flowMsg) await bot.deleteMessage(msg.chat.id, st.flowMsg).catch(() => {});
  const body = { parse_mode: "Markdown", reply_markup: kb, reply_to_message_id: msg.message_id };
  let sent;
  try {
    sent = await reply(msg, text, body);
  } catch (e) {
    sent = await bot.sendMessage(msg.chat.id, text, { reply_markup: kb, reply_to_message_id: msg.message_id });
  }
  st.flowMsg = sent.message_id;
  return sent;
}

async function flowNewRich(msg, st, html, fallback, rows) {
  if (!st) st = getState(msg.chat.id);
  const kb =
    rows && rows.length
      ? inlineButtons(rows).reply_markup
      : { inline_keyboard: [] };
  if (st.flowMsg) await bot.deleteMessage(msg.chat.id, st.flowMsg).catch(() => {});
  const opts = { parse_mode: "Markdown", reply_markup: kb, reply_to_message_id: msg.message_id };
  const sent = await bot.sendRichMessage(msg.chat.id, html, fallback, opts);
  st.flowMsg = sent.message_id;
  return sent;
}

function chatAction(chatId, action = "typing") {
  return bot.sendChatAction(chatId, action).catch(() => {});
}

async function showBusy(msg, st, label) {
  if (!st) st = getState(msg.chat.id);
  const text = "⏳ " + label + "…";
  const body = { parse_mode: "Markdown" };
  if (st.flowMsg) {
    return bot.editMessageText(msg.chat.id, st.flowMsg, text, body).catch(() => {});
  }
  if (st.depMsg) {
    return bot.editMessageText(msg.chat.id, st.depMsg, text, body).catch(() => {});
  }
  return reply(msg, text, body).catch(() => {});
}

function fmt(n) {
  return (n === "" || n == null) ? "-" : n;
}

function escHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escMd(s) {
  return String(s == null ? "" : s).replace(/([_*`[\]])/g, "\\$1");
}

function orderCatLabel(st, key) {
  const c = (st.cfg.categories || []).find((x) => x.key === key);
  return (c && c.label ? c.label.trim() : key) || String(key || "");
}

function orderTableHtml(title, pairs) {
  return (
    "<b>" + escHtml(title) + "</b>\n<table bordered>" +
    pairs.map(([k, v]) => "<tr><th>" + escHtml(k) + "</th><td>" + escHtml(v) + "</td></tr>").join("") +
    "</table>"
  );
}

function orderTableFallback(title, pairs) {
  return "*" + title + "*\n" + pairs.map(([k, v]) => k + ": " + fmt(v)).join("\n");
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out.length ? out : [[]];
}

function userName(msg) {
  const u = msg && msg.from;
  if (!u) return "";
  return u.username ? "@" + u.username : [u.first_name, u.last_name].filter(Boolean).join(" ").trim();
}

const QRIS_POLLS = {};

function gracefulShutdown() {
  console.log("[SHUTDOWN] Cleaning up...");
  // Clear all QRIS polls
  for (const chatId of Object.keys(QRIS_POLLS)) {
    clearTimeout(QRIS_POLLS[chatId].timer);
    delete QRIS_POLLS[chatId];
  }
  // Clear all states
  states.clear();
  console.log("[SHUTDOWN] Cleanup complete. Exiting.");
  process.exit(0);
}

process.on("SIGTERM", gracefulShutdown);
process.on("SIGINT", gracefulShutdown);

function startQrisPoll(chatId, trx) {
  const prev = QRIS_POLLS[chatId];
  if (prev) {
    clearTimeout(prev.timer);
    delete QRIS_POLLS[chatId];
  }
  const entry = { trx: String(trx), tries: 0, last: "" };
  QRIS_POLLS[chatId] = entry;
  entry.timer = setTimeout(qrisTick, 30000, chatId, entry);
}

async function qrisTick(chatId, entry) {
  if (QRIS_POLLS[chatId] !== entry) return;
  entry.tries += 1;
  try {
    const isDep = !!depLedger.get(entry.trx);
    const d = isDep
      ? await akun.getDepositDetail(entry.trx)
      : await akun.getHistoryDetail(entry.trx);
    const stNow = isDep ? (d.status || "-") : (d.statusPembayaran || "-") + " / " + (d.statusPengisian || "-");
    if (stNow !== entry.last) {
      entry.last = stNow;
      if (!isDep) {
        await ledger.updateStatus(entry.trx, {
          statusPembayaran: d.statusPembayaran,
          statusPengisian: d.statusPengisian,
          status: d.statusPengisian || d.statusPembayaran,
        });
      }
      if (/sukses/i.test(stNow)) {
        await reply(
          { chat: { id: chatId } },
          isDep
            ? "✅ *Deposit terbayar!*\nTrx *#" + entry.trx + "* — Status: Sukses\nCek /deposit."
            : "✅ *Pembayaran diterima & pengisian sukses!*\nTrx *#" + entry.trx + "*\nStatus: " + stNow,
          { parse_mode: "Markdown" }
        );
        clearTimeout(entry.timer);
        delete QRIS_POLLS[chatId];
        return;
      }
      if (/batal|dibatalkan|gagal/i.test(stNow)) {
        await reply({ chat: { id: chatId } }, "⚠️ Trx *#" + entry.trx + "* dibatalkan/gagal.\nStatus: " + stNow, { parse_mode: "Markdown" });
        clearTimeout(entry.timer);
        delete QRIS_POLLS[chatId];
        return;
      }
    }
  } catch (e) {
    // lanjut coba berikutnya
  }
  if (entry.tries < 25) {
    entry.timer = setTimeout(qrisTick, 30000, chatId, entry);
  } else {
    delete QRIS_POLLS[chatId];
  }
}

function isOngoing(chatId) {
  return !!QRIS_POLLS[chatId];
}

function upscalePng(buf, size = 640) {
  return new Promise((resolve) => {
    const t1 = path.join(os.tmpdir(), "q" + Date.now() + Math.random().toString(36).slice(2) + ".png");
    const t2 = path.join(os.tmpdir(), "o" + Date.now() + Math.random().toString(36).slice(2) + ".png");
    fs.writeFile(t1, buf, () => {
      execFile("magick", [t1, "-filter", "point", "-resize", size + "x" + size, "-background", "white", "-flatten", t2], (err) => {
        fs.readFile(t2, (e, out) => {
          fs.unlink(t1, () => {});
          fs.unlink(t2, () => {});
          if (err || e || !out || !out.length) return resolve(buf);
          resolve(out);
        });
      });
    });
  });
}

async function buildQrSet(id, entry) {
  let qr = { ok: false, error: "QR tidak tersedia" };
  try {
    qr = await akun.getPaymentQr(id);
  } catch (e) {
    qr = { ok: false, error: e.message };
  }
  let buffer = null;
  if (qr.ok && qr.buffer) {
    try {
      buffer = await upscalePng(qr.buffer, 640);
    } catch (e) {
      buffer = qr.buffer;
    }
  }
  let d = null;
  try {
    d = await akun.getHistoryDetail(id);
  } catch (e) {
    d = null;
  }
  const row = (label, val) => (val === "" || val == null ? "" : label + val);
  const info = [
    "Trx: *#" + id + "*",
    row("Jenis: ", d && d.jenisProduk),
    row("Paket: ", d && d.nominal ? d.nominal : entry && entry.voucher),
    row("Nomor: ", d && d.noHp ? d.noHp : entry && entry.nomor),
    row("Harga: ", d && d.harga ? d.harga : entry && entry.harga),
    row("Bayar: ", d && d.pembayaran ? d.pembayaran : entry && entry.pembayaran),
    row("Status Bayar: ", d && d.statusPembayaran ? d.statusPembayaran : entry && entry.statusPembayaran),
    row("Status Isi: ", d && d.statusPengisian ? d.statusPengisian : entry && entry.statusPengisian),
    entry && entry.user ? "Pelanggan: " + entry.user : "",
  ].filter(Boolean).join("\n");
  const buyer = [
    "Trx: *#" + id + "*",
    row("Paket: ", d && d.nominal ? d.nominal : entry && entry.voucher),
    row("Nomor: ", d && d.noHp ? d.noHp : entry && entry.nomor),
    row("Total: ", d && d.harga ? d.harga : entry && entry.harga),
    row("Status: ", d && d.statusPembayaran ? d.statusPembayaran : entry && entry.statusPembayaran),
  ].filter(Boolean).join("\n");
  return { ok: !!buffer, buffer, error: qr.error, d, info, buyer };
}

function confirmButton(id) {
  return [[{ text: "✅ Konfirmasi Pembayaran", data: "konfirm:" + id }]];
}

/* ==================== Menu utama + reply keyboard ==================== */

const HELP_NORMAL = [
  "🤖 *Bot KonterKuota*",
  "",
  "Perintah:",
  "• /menu — tampilkan menu utama",
  "• /harga `<kata>` — cari produk & harga (bisa langsung order)",
  "• /riwayat `[n]` — riwayat transaksi (default 5)",
  "• /deposit — riwayat deposit & buat deposit (top-up)",
  "• /order — mulai transaksi",
  "• /batal — batalkan proses order",
  "",
  "Gunakan tombol *reply keyboard* di bawah atau menu utama.",
  "",
  "Order, cek harga & riwayat bisa dilakukan semua orang.",
].join("\n");

const HELP_ADMIN = [
  "🤖 *Bot KonterKuota*",
  "",
  "Perintah:",
  "• /menu — tampilkan menu utama",
  "• /harga `<kata>` — cari produk & harga (bisa langsung order)",
  "• /saldo — cek saldo & info akun",
  "• /riwayat `[n]` — riwayat transaksi (default 5)",
  "• /mutasi `[n]` — mutasi saldo",
  "• /deposit — riwayat deposit & buat deposit (top-up)",
  "• /order — mulai transaksi",
  "• /batal — batalkan proses order",
  "• /kirimqr `<id>` — kirim ulang QR pembayaran (admin)",
  "",
  "Gunakan tombol *reply keyboard* di bawah atau menu utama.",
].join("\n");

function mainMenuRows(admin) {
  const rows = [
    [{ text: "🛒 Order", data: "menu:order" }, { text: "🔍 Cari Harga", data: "menu:cari" }],
  ];
  rows.push([{ text: "📋 Riwayat", data: "menu:riwayat" }, { text: "➕ Deposit", data: "menu:deposit" }]);
  if (admin) {
    rows.push([{ text: "💰 Saldo Saya", data: "menu:saldo" }, { text: "🧾 Mutasi", data: "menu:mutasi" }]);
  }
  rows.push([{ text: "❓ Bantuan", data: "menu:bantuan" }]);
  return rows;
}

function replyKeyboardKeys(admin) {
  const rows = [
    ["🛒 Order", "🔍 Cari Harga"],
    ["📋 Riwayat", "➕ Deposit"],
  ];
  if (admin) {
    rows.push(["💰 Saldo Akun", "🧾 Mutasi"]);
  }
  rows.push(["❓ Bantuan"]);
  return rows;
}

function replyKeyboardMarkup(admin) {
  return {
    reply_markup: {
      keyboard: replyKeyboardKeys(admin),
      one_time_keyboard: false,
      persistent: true,
      resize_keyboard: true,
    },
  };
}

async function showMainMenu(chatId, label) {
  const admin = isAllowed(chatId);
  const text = label || "🤖 *Menu Utama — KonterKuota*";
  return bot.sendMessage(chatId, text, {
    parse_mode: "Markdown",
    ...inlineButtons(mainMenuRows(admin)),
  });
}

function helpFor(chatId) {
  return isAllowed(chatId) ? HELP_ADMIN : HELP_NORMAL;
}

async function doStart(msg) {
  const admin = isAllowed(msg.chat.id);
  await bot.sendMessage(msg.chat.id, helpFor(msg.chat.id), { parse_mode: "Markdown", ...replyKeyboardMarkup(admin) });
  return showMainMenu(msg.chat.id);
}

bot.onText(/^\/start$/, doStart);
bot.onText(/^\/help$/, doStart);
bot.onText(/^\/menu$/, (msg) => showMainMenu(msg.chat.id));

/* ==================== /harga & /cari (read-only, public) ==================== */

async function handleCari(msg, q) {
  if (!q) {
    await reply(msg, "Gunakan: /harga `<kata>`\nContoh: `/harga axis 5` atau `/harga 10 gb telkomsel`\n\nMencari dari katalog produk konterkuota (tanpa login).", { parse_mode: "Markdown" });
    return showMainMenu(msg.chat.id);
  }
  const chatId = msg.chat.id;
  chatAction(chatId);
  const wait = await reply(msg, "Mencari...");
  try {
    const cat = await loadCatalog();
    const res = searchProducts(cat, q);
    await bot.deleteMessage(chatId, wait.message_id).catch(() => {});
    if (!res.length) return reply(msg, "Tidak ada produk cocok dengan *" + q + "*", { parse_mode: "Markdown" });

    const lines = res.slice(0, 12).map((p) => {
      const status = p.status === 0 ? " *(Kosong)*" : "";
      return `• ${p.operatorName} — ${p.nama}: ${formatHarga(p.harga)}${status}`;
    });
    let out = `Ditemukan ${res.length} produk untuk *"${q}"*:\n\n` + lines.join("\n");
    if (res.length > 12) out += `\n... dan ${res.length - 12} lainnya.`;

    const rows = [];
    const orderable = res.filter((p) => p.status === 1).slice(0, 6);
    for (let i = 0; i < orderable.length; i += 2) {
      rows.push(
        orderable.slice(i, i + 2).map((p) => ({
          text: `🛒 ${p.nama}`,
          data: `ord:${p.operatorId}:${p.voucherId}`,
        }))
      );
    }
    rows.push([{ text: "⬅️ Menu Utama", data: "menu" }]);
    return reply(msg, out, { parse_mode: "Markdown", ...inlineButtons(rows) });
  } catch (e) {
    await bot.deleteMessage(chatId, wait.message_id).catch(() => {});
    return reply(msg, "Gagal mengambil katalog: " + e.message);
  }
}
bot.onText(/^\/harga\s+(.+)$/, (msg, m) => handleCari(msg, m[1].trim()));
bot.onText(/^\/cari\s+(.+)$/, (msg, m) => handleCari(msg, m[1].trim()));
bot.onText(/^\/harga$/, (msg) => handleCari(msg, ""));
bot.onText(/^\/cari$/, (msg) => handleCari(msg, ""));

/* ==================== /saldo & /profil (login) ==================== */

async function doSaldo(msg) {
  const chatId = msg.chat.id;
  chatAction(chatId);
  const wait = await reply(msg, "Mengambil data akun...");
  try {
    const p = await akun.getProfil();
    await bot.deleteMessage(chatId, wait.message_id).catch(() => {});
    if (p.status !== 200) {
      return reply(msg, "Gagal (status " + p.status + "). Cek KONTER_COOKIE / sesi login.");
    }
    const name = p.nama || p.pengguna || "Akun";
    const pairs = [
      ["User", p.pengguna],
      ["No. HP", p.noHp],
      ["Jenis", p.jenisAkun ? p.jenisAkun + " (" + fmt(p.statusAkun) + ")" : fmt(p.statusAkun)],
      ["Saldo", p.saldo],
      ["Saldo QRIS", p.saldoQris],
      ["Total Transaksi Sukses", p.totalTransaksi],
    ];
    const html =
      "<b>👤 " + escHtml(name) + "</b>\n<table bordered>" +
      pairs.map(([k, v]) => "<tr><th>" + escHtml(k) + "</th><td>" + escHtml(v) + "</td></tr>").join("") +
      "</table>";
    const fallback = "👤 *" + name + "*\n" + pairs.map(([k, v]) => k + ": " + fmt(v)).join("\n");
    const rows = [
      [
        { text: "🧾 Mutasi", data: "menu:mutasi" },
        { text: "⬅️ Menu", data: "menu" },
        { text: "💰 Top Up", data: "dep:new" },
      ],
    ];
    return bot.sendRichMessage(msg.chat.id, html, fallback, {
      parse_mode: "Markdown",
      reply_markup: inlineButtons(rows).reply_markup,
    });
  } catch (e) {
    await bot.deleteMessage(chatId, wait.message_id).catch(() => {});
    return reply(msg, "Gagal: " + e.message);
  }
}
bot.onText(/^\/(saldo|profil)$/, guard(doSaldo));

/* ==================== /riwayat & /mutasi (login) ==================== */

function isPendingStatus(e) {
  const st = ((e.statusPembayaran || "") + " " + (e.statusPengisian || "") + " " + (e.status || "")).toLowerCase();
  return /tunggu|pending|menunggu|proses|belum/i.test(st);
}

function renderRiwayat(msg, adm, list) {
  const slice = list.slice(0, 10);
  if (!slice.length) {
    return reply(msg, "Belum ada transaksi.", inlineButtons([[{ text: "⬅️ Menu", data: "menu" }]]));
  }
  const btns = [];
  for (let i = 0; i < slice.length; i++) {
    const e = slice[i];
    if (!e.trx) continue;
    const row = [];
    if (isPendingStatus(e)) row.push({ text: "🖼️ Kirim QR #" + e.trx, data: "qr:" + e.trx });
    const label = (i + 1) + " — " + (e.voucher || "Produk");
    row.push({ text: label, data: "hist:" + e.trx });
    btns.push(row);
  }
  btns.push([{ text: "⬅️ Menu Utama", data: "menu" }]);
  const head = adm ? "🗂 *Riwayat Transaksi (Semua User)*" : "🗂 *Riwayat Transaksi*";
  const lines = slice.map((e) => {
    const who = adm ? ` 👤 ${e.user || "akun/web"}` : "";
    const st = e.statusPembayaran && e.statusPengisian ? `${e.statusPembayaran}/${e.statusPengisian}` : e.statusPembayaran || e.status || "-";
    return `#${e.trx} | ${e.tanggal}${who}\n  ${e.voucher} — ${e.harga} (${e.pembayaran})\n  No: ${e.nomor} | ${st}`;
  });

  const headers = ["No", "Tanggal", "Produk", "Nomor", "Harga", "Bayar", "Status"];
  if (adm) headers.push("Sumber");
  const thead = "<tr>" + headers.map((c) => "<th>" + escHtml(c) + "</th>").join("") + "</tr>";
  const body = slice
    .map((e, i) => {
      const st = e.statusPembayaran && e.statusPengisian ? `${e.statusPembayaran}/${e.statusPengisian}` : e.statusPembayaran || e.status || "-";
      const cells = [String(i + 1), e.tanggal, e.voucher, e.nomor, e.harga, e.pembayaran, st];
      if (adm) cells.push(e.user || "akun/web");
      return "<tr>" + cells.map((c) => "<td>" + escHtml(c) + "</td>").join("") + "</tr>";
    })
    .join("");
  const html = `<b>${escHtml(head.replace(/\*/g, ""))}</b>\n<table bordered striped>${thead}${body}</table>`;
  return bot.sendRichMessage(msg.chat.id, html, head + "\n\n" + lines.join("\n\n"), {
    parse_mode: "Markdown",
    reply_markup: inlineButtons(btns).reply_markup,
  });
}

async function doRiwayat(msg) {
  const chatId = msg.chat.id;
  chatAction(chatId);
  const adm = isAllowed(chatId);
  if (!adm) {
    return renderRiwayat(msg, adm, ledger.listByChat(chatId, 10));
  }
  // admin: gabung ledger + transaksi akun (web), dedup per id transaksi
  const led = ledger.listAll(100);
  const byTrx = new Map(led.map((e) => [String(e.trx), e]));
  let web = [];
  try {
    const h = await akun.getHistory(50);
    web = (h.rows || []).map((r) => {
      const L = byTrx.get(String(r.id));
      return {
        trx: r.id,
        tanggal: r.tanggal,
        voucher: `${r.provider} ${r.voucher}`.trim(),
        nomor: r.noHp,
        harga: r.harga,
        pembayaran: r.pembayaran,
        statusPembayaran: r.status,
        statusPengisian: "",
        user: L ? L.user : "akun/web",
      };
    });
  } catch (e) {
    web = [];
  }
  const seen = new Set(web.map((e) => String(e.trx)));
  const extra = led.filter((e) => !seen.has(String(e.trx)));
  return renderRiwayat(msg, adm, web.concat(extra).sort((a, b) => String(b.trx).localeCompare(String(a.trx))));
}
bot.onText(/^\/riwayat(?:\s+(\d+))?$/, doRiwayat);

async function doMutasi(msg, m) {
  const chatId = msg.chat.id;
  chatAction(chatId);
  const limit = Math.min(parseInt(m && m[1] ? m[1] : "5", 10) || 5, 15);
  const wait = await reply(msg, "Mengambil mutasi saldo...");
  try {
    const { status, rows } = await akun.getMutasi(limit);
    await bot.deleteMessage(chatId, wait.message_id).catch(() => {});
    if (status !== 200) return reply(msg, "Gagal (status " + status + "). Cek sesi login.");
    if (!rows.length) {
      return reply(msg, "Belum ada mutasi.", inlineButtons([[{ text: "⬅️ Menu", data: "menu" }]]));
    }
    const lines = rows.map((r) => {
      return `${r.tanggal} | ${r.jumlah}\n  ${r.keterangan}\n  Saldo akhir: ${r.saldoAkhir}`;
    });
    const thead = "<tr>" + ["Tanggal", "Jumlah", "Keterangan", "Saldo Akhir"].map((c) => "<th>" + escHtml(c) + "</th>").join("") + "</tr>";
    const body = rows
      .map(
        (r) =>
          "<tr><td>" + escHtml(r.tanggal) + "</td><td>" + escHtml(r.jumlah) + "</td><td>" + escHtml(r.keterangan) + "</td><td>" +
          escHtml(r.saldoAkhir) + "</td></tr>"
      )
      .join("");
    const html = "<b>🧾 Mutasi Saldo</b>\n<table bordered striped>" + thead + body + "</table>";
    const fallback = "🧾 *Mutasi Saldo*\n\n" + lines.join("\n\n");
    return bot.sendRichMessage(msg.chat.id, html, fallback, {
      parse_mode: "Markdown",
      reply_markup: inlineButtons([[{ text: "⬅️ Menu Utama", data: "menu" }]]).reply_markup,
    });
  } catch (e) {
    await bot.deleteMessage(chatId, wait.message_id).catch(() => {});
    return reply(msg, "Gagal: " + e.message);
  }
}
bot.onText(/^\/mutasi(?:\s+(\d+))?$/, guard(doMutasi));

/* ==================== /deposit (riwayat + buat deposit, admin) ==================== */

async function doDeposit(msg) {
  const chatId = msg.chat.id;
  chatAction(chatId);
  const adm = isAllowed(chatId);
  const wait = await reply(msg, "Mengambil riwayat deposit...");
  try {
    const { status, rows } = await akun.getDeposit(50);
    await bot.deleteMessage(chatId, wait.message_id).catch(() => {});
    if (status !== 200) return reply(msg, "Gagal (status " + status + "). Cek sesi login.");
    const mine = new Set(depLedger.listByChat(chatId).map((e) => String(e.depId)));
    const shown = adm ? rows : rows.filter((r) => mine.has(String(r.id))).slice(0, 10);
    const btns = [
      { text: "➕ Buat Deposit", data: "dep:new" },
      { text: "⬅️ Menu Utama", data: "menu" },
    ];
    if (!shown.length) {
      return reply(
        msg,
        adm
          ? "Belum ada riwayat deposit."
          : "Belum ada deposit yang kamu buat.\nKlik *Buat Deposit* untuk top-up saldo.",
        { parse_mode: "Markdown", ...inlineButtons([btns]) }
      );
    }
    const thead = "<tr>" + ["No", "Tanggal", "Jumlah", "Metode", "Status"].map((c) => "<th>" + escHtml(c) + "</th>").join("") + "</tr>";
    const body = shown
      .map(
        (r, i) =>
          "<tr><td>" + (i + 1) + "</td><td>" + escHtml(r.tanggal) + "</td><td>" + escHtml(r.jumlah) + "</td><td>" +
          escHtml(r.metode) + "</td><td>" + escHtml(r.status) + "</td></tr>"
      )
      .join("");
    const html = `<b>➕ Deposit (Riwayat)</b>\n<table bordered striped>${thead}${body}</table>`;
    const fallback = "➕ *Deposit*\n\n" + shown.map((r, i) => `${i + 1}. ${r.tanggal} — ${r.jumlah} (${r.metode}) — ${r.status}`).join("\n");
    return bot.sendRichMessage(chatId, html, fallback, {
      parse_mode: "Markdown",
      reply_markup: inlineButtons([btns]).reply_markup,
    });
  } catch (e) {
    await bot.deleteMessage(chatId, wait.message_id).catch(() => {});
    return reply(msg, "Gagal: " + e.message);
  }
}
bot.onText(/^\/deposit$/, doDeposit);

async function startDeposit(chatId, msg, st) {
  st.dep = {};
  st.depStep = "amount";
  return depEdit(msg, st, "💰 *Buat Deposit*\nKetik *nominal* (minimal Rp 10.000). Contoh: `50000`", []);
}

async function handleDepPay(chatId, msg, st, methodKey) {
  if (!st.dep || !st.dep.amount || !st.depMsg || msg.message_id !== st.depMsg) {
    return reply(msg, "Sesi deposit sudah habis atau bukan pesan terbaru. Ketik /deposit untuk mulai lagi.");
  }
  const method = (st.dep.methods || []).find((m) => m.value === methodKey);
  const mlabel = method ? method.label : methodKey;
  const amount = st.dep.amount;
  await depEdit(msg, st, `Membuat deposit *${formatHarga(amount)}* via *${mlabel}*...`, []);
  let res;
  try {
    res = await akun.createDeposit({ amount, payment: methodKey, csrfToken: st.dep.csrf });
  } catch (e) {
    clearDep(chatId);
    await depEdit(msg, st, "❌ Gagal membuat deposit: " + e.message, []);
    return reply(msg, "Silakan coba lagi /deposit.");
  }
  clearDep(chatId);
  console.log(`[DEP] create res ok=${res.ok} status=${res.status} id=${res.id} loc=${res.location || "-"} msg=${res.message || "-"}`);
  if (!res.ok) {
    await depEdit(msg, st, "❌ Gagal membuat deposit (status " + res.status + ").", []);
    return reply(msg, "Silakan coba lagi /deposit. Pastikan metode & nominal valid." + (res.message ? "\n\n_Situs_: " + res.message : ""));
  }
  try {
    await depLedger.add({
      depId: String(res.id),
      chat: chatId,
      user: userName(msg) || String(chatId),
      jumlah: formatHarga(amount),
      metode: mlabel,
      tanggal: new Date().toLocaleString("id-ID", { dateStyle: "short", timeStyle: "short" }),
      createdAt: Date.now(),
    });
  } catch (e) {}
  await depEdit(msg, st, `✅ Deposit dibuat: *#${res.id}*\nCek status via /deposit.`, []);
  const info = res.detail
    ? `Jumlah: ${res.detail.jumlah}\nMetode: ${res.detail.metode}\nStatus: ${res.detail.status}`
    : `Jumlah: ${formatHarga(amount)}\nMetode: ${mlabel}`;
  if (res.qr && res.qr.ok && res.qr.buffer) {
    const big = await upscalePng(res.qr.buffer, 1024);
    await bot.sendPhoto(chatId, big || res.qr.buffer, {
      caption: `🧾 *Scan & bayar Deposit #${res.id}*\n${info}\n\nScan QR, bayar, lalu tekan *Konfirmasi Pembayaran*. Bot akan mengabari begitu lunas.`,
      parse_mode: "Markdown",
      ...inlineButtons(confirmButton(res.id)),
    });
    startQrisPoll(chatId, res.id);
    return;
  }
  return reply(msg, `🧾 *Deposit #${res.id}*\n${info}${res.qr && res.qr.error ? "\nQR: " + res.qr.error : ""}`, { parse_mode: "Markdown" });
}

/* ==================== /order (interactive, login) ==================== */

async function doOrder(msg) {
  const chatId = msg.chat.id;
  if (isOngoing(chatId)) {
    return reply(msg, "Masih ada pembayaran QRIS yang berjalan (#" + QRIS_POLLS[chatId].trx + "). Tunggu sampai selesai atau hubungi admin.");
  }
  const wait = await reply(msg, "Menyiapkan menu order...");
  let cfg;
  try {
    cfg = await order.getOrderConfig();
  } catch (e) {
    await bot.deleteMessage(chatId, wait.message_id).catch(() => {});
    return reply(msg, "Gagal memuat config order: " + e.message);
  }
  await bot.deleteMessage(chatId, wait.message_id).catch(() => {});
  if (cfg.status !== 200) return reply(msg, "Sesi tidak valid (status " + cfg.status + "). Cek login.");

  const st = getState(chatId);
  st.step = "kategori";
  st.cfg = cfg;
  st.order = {};

  const rows = chunk(cfg.categories.map((c) => ({ text: c.label, data: "cat:" + c.key })), 2);
  rows.push([{ text: "⬅️ Menu Utama", data: "menu" }]);
  const sent = await reply(msg, "Pilih *kategori produk*:", { parse_mode: "Markdown", ...inlineButtons(rows) });
  st.flowMsg = sent.message_id;
  return sent;
}
bot.onText(/^\/order$/, doOrder);

bot.onText(/^\/batal$/, (msg) => {
  clearState(msg.chat.id);
  return reply(msg, "Proses order dibatalkan.", removeKeyboard());
});

bot.onText(/^\/kirimqr\s+(\d+)$/, guard((msg, m) => doKirimQr(msg, m[1])));

function parseId(str) {
  return str.replace(/^\D+/, "");
}

async function doKirimQr(msg, trx) {
  const chatId = msg.chat.id;
  const id = parseId(String(trx));
  const entry = ledger.get(id);
  await reply(msg, "Mengambil QR untuk #" + id + "...");
  const s = await buildQrSet(id, entry);
  if (!s.buffer) return reply(msg, "QR belum tersedia: " + (s.error || "belum ada sesi pembayaran."));

  await bot.sendPhoto(chatId, s.buffer, {
    caption: "🖼️ *QR Pembayaran QRIS*\n" + s.info + "\n\nScan QR, bayar, lalu tekan tombol konfirmasi. Status dipantau otomatis.",
    parse_mode: "Markdown",
    ...inlineButtons(confirmButton(id)),
  });
  const target = entry ? Number(entry.chat) : chatId;
  if (target !== chatId) {
    await bot.sendPhoto(target, s.buffer, {
      caption: "🧾 *Scan & bayar QRIS*\n" + s.buyer + "\n\nScan QR, bayar, lalu tekan *Konfirmasi Pembayaran*. Bot akan mengabari begitu lunas.",
      parse_mode: "Markdown",
      ...inlineButtons(confirmButton(id)),
    }).catch(() => {});
  }
  if (isOngoing(target)) {
    return reply(msg, "QR #" + id + " terkirim. Polling untuk pengguna itu sudah berjalan.");
  }
  startQrisPoll(target, id);
  return reply(msg, "QR #" + id + " terkirim" + (target !== chatId ? " ke pengguna." : "") + " Polling status dimulai.");
}

async function handleKonfirm(chatId, msg, trx) {
  const id = parseId(String(trx));
  const isDep = !!depLedger.get(id);
  if (!isAllowed(chatId)) {
    const e = isDep ? depLedger.get(id) : ledger.get(id);
    if (!e || String(e.chat) !== String(chatId)) {
      return reply(msg, "🔒 Ini bukan transaksi Anda.");
    }
  }
  await reply(msg, "Mengirim konfirmasi pembayaran #" + id + "...");
  let r;
  try {
    r = await request(
      "GET",
      (isDep ? "/payment/qris_livin_nt/deposit/" : "/payment/qris_livin_nt/trx/") + encodeURIComponent(id)
    );
  } catch (e) {
    return reply(msg, "Gagal konfirmasi: " + e.message);
  }
  let st = "";
  let stLabel = "-";
  if (isDep) {
    let dd = null;
    try {
      dd = await akun.getDepositDetail(id);
    } catch (e) {
      dd = null;
    }
    st = dd ? dd.status : "";
    stLabel = st || "-";
  } else {
    let d = null;
    try {
      d = await akun.getHistoryDetail(id);
    } catch (e) {
      d = null;
    }
    st = (d ? d.statusPembayaran : "-") + " / " + (d ? d.statusPengisian : "-");
    stLabel = st;
    if (d && d.statusPembayaran) {
      await ledger.updateStatus(id, {
        statusPembayaran: d.statusPembayaran,
        statusPengisian: d.statusPengisian,
        status: d.statusPengisian || d.statusPembayaran,
      });
    }
  }
  await reply(msg, "Konfirmasi terkirim (status " + r.status + ").\nStatus trx *#" + id + "*: " + stLabel, { parse_mode: "Markdown" });
  const entry = isDep ? depLedger.get(id) : ledger.get(id);
  const target = entry ? Number(entry.chat) : chatId;
  if (/sukses/i.test(st)) {
    if (target !== chatId) {
      await reply(
        { chat: { id: target } },
        isDep
          ? "✅ *Deposit terbayar!*\nTrx *#" + id + "* — Status: Sukses\nCek /deposit."
          : "✅ *Pembayaran diterima & pengisian sukses!*\nTrx *#" + id + "*\nStatus: " + st,
        { parse_mode: "Markdown" }
      ).catch(() => {});
    }
    if (QRIS_POLLS[chatId]) {
      clearTimeout(QRIS_POLLS[chatId].timer);
      delete QRIS_POLLS[chatId];
    }
  }
}

async function handleQrPick(chatId, msg, trx) {
  const id = parseId(String(trx));
  if (!isAllowed(chatId)) {
    const e = ledger.get(id);
    if (!e || String(e.chat) !== String(chatId)) {
      return reply(msg, "🔒 Ini bukan transaksi Anda.");
    }
  }
  return doKirimQr(msg, id);
}

/* ==================== captcha ==================== */

async function sendCaptcha(chatId) {
  const { buffer } = await getBuffer("/captcha?r=" + Date.now());
  if (!buffer) {
    await reply({ chat: { id: chatId } }, "Gagal mengambil gambar captcha. Coba lagi.");
    return false;
  }
  await bot.sendPhoto(chatId, buffer, {
    caption: "Ketik *kode keamanan* (captcha) di atas. Contoh: `a1b2c3`",
    parse_mode: "Markdown",
  });
  return true;
}

/* ==================== callback query ==================== */

bot.on("callback_query", (q) => {
  const chatId = q.message.chat.id;
  if (isRateLimited(chatId)) return;
  const data = q.data || "";
  const st = getState(chatId);

  (async () => {
    try {
      const FLOW_CB = ["cat:", "op:", "vch:", "vchp:", "pay:", "order:cancel"];
    const isFlow = FLOW_CB.some((p) => data.startsWith(p));
    if (isFlow && (!st.step || !st.flowMsg || !st.cfg || q.message.message_id !== st.flowMsg)) {
      return reply(q.message, "Sesi order ini sudah kedaluwarsa atau bukan pesan terbaru. Ketik /order untuk mulai lagi.");
    }
    if (data === "menu") {
      if (st && st.step && st.flowMsg) {
        try {
          await bot.editMessageText(chatId, st.flowMsg, "🛒 Order dibatalkan — kembali ke menu.", {
            parse_mode: "Markdown",
            reply_markup: { inline_keyboard: [] },
          });
        } catch (e) {}
        clearState(chatId);
      }
      if (st && st.depStep && st.depMsg) {
        try {
          await bot.editMessageText(chatId, st.depMsg, "Deposit dibatalkan — kembali ke menu.", {
            parse_mode: "Markdown",
            reply_markup: { inline_keyboard: [] },
          });
        } catch (e) {}
        clearDep(chatId);
      }
      return showMainMenu(chatId, "📋 *Menu Utama*");
    }
    if (data === "menu:cari") return handleCari(q.message, "");
    if (data === "menu:saldo") return guard(doSaldo)(q.message);
    if (data === "menu:riwayat") return doRiwayat(q.message);
    if (data === "menu:mutasi") return guard(doMutasi)(q.message);
    if (data === "back:kategori") return handleBackKategori(chatId, q.message, st);
    if (data === "back:operator") return handleBackOperator(chatId, q.message, st);
    if (data === "menu:order") return doOrder(q.message);
    if (data === "menu:bantuan") {
      await reply(q.message, helpFor(chatId), { parse_mode: "Markdown" });
      return showMainMenu(chatId);
    }
    if (data === "menu:deposit") return doDeposit(q.message);
    if (data === "dep:new") return startDeposit(chatId, q.message, st);
    if (data.startsWith("dep:pay:")) return handleDepPay(chatId, q.message, st, data.slice(8));
    if (data.startsWith("ord:")) return handleDirect(chatId, q.message, st, data.slice(4));
    if (data.startsWith("hist:")) return handleHistoryDetail(chatId, q.message, data.slice(5));
    if (data.startsWith("struk:")) return handleStruk(chatId, q.message, data.slice(6));
    if (data.startsWith("qr:")) return handleQrPick(chatId, q.message, data.slice(3));
    if (data.startsWith("konfirm:")) return handleKonfirm(chatId, q.message, data.slice(8));
    if (data.startsWith("cat:")) return handleCatPick(chatId, q.message, st, data.slice(4));
    if (data.startsWith("op:")) return handleOpPick(chatId, q.message, st, data.slice(3));
    if (data.startsWith("vch:")) return handleVchPick(chatId, q.message, st, data.slice(4));
    if (data.startsWith("vchp:")) {
      st.vouchPage = parseInt(data.slice(5), 10) || 0;
      return renderVouchers(q.message, st);
    }
    if (data === "noop") return;
    if (data.startsWith("pay:")) return handlePayPick(chatId, q.message, st, data.slice(4));
    if (data === "order:cancel") {
      const target = st.flowMsg;
      clearState(chatId);
      try {
        return await bot.editMessageText(chatId, target, "🛒 Order dibatalkan.", {
          parse_mode: "Markdown",
          reply_markup: { inline_keyboard: [] },
        });
      } catch (e) {
        return reply(q.message, "🛒 Order dibatalkan.", removeKeyboard());
      }
    }
    return reply(q.message, "Perintah tidak dikenal.");
    } finally {
      bot.answerCallbackQuery(q.id).catch(() => {});
    }
  })().catch((e) => reply(q.message, "Error: " + e.message));
});

/* ==================== order flow handlers ==================== */

async function handleCatPick(chatId, msg, st, key) {
  const cfg = st.cfg;
  const cat = order.categoryByKey(cfg, key);
  if (!cat) return reply(msg, "Kategori tidak ditemukan.");
  st.order.kategori = key;
  st.order.field = cat.field;

  const ops = cat.operators || {};
  const keys = Object.keys(ops);
  if (!keys.length) return reply(msg, "Tidak ada provider untuk kategori ini.");
  const rows = chunk(keys.map((id) => ({ text: ops[id], data: "op:" + id })), 2);
  rows.push([{ text: "⬅️ Kategori", data: "back:kategori" }]);
  return flowEdit(msg, st, `Kategori *${cat.label.trim()}*\nPilih *provider*:`, rows);
}

async function handleBackKategori(chatId, msg, st) {
  const cfg = st.cfg;
  if (!cfg) return reply(msg, "Sesi expired. Ketik /order untuk mulai lagi.");
  st.step = "kategori";
  st.order = {};
  const rows = chunk(cfg.categories.map((c) => ({ text: c.label, data: "cat:" + c.key })), 2);
  rows.push([{ text: "⬅️ Menu Utama", data: "menu" }]);
  return flowEdit(msg, st, "Pilih *kategori produk*:", rows);
}

async function handleBackOperator(chatId, msg, st) {
  const cfg = st.cfg;
  const kategori = st.order.kategori;
  if (!cfg || !kategori) return reply(msg, "Sesi expired. Ketik /order untuk mulai lagi.");
  const cat = order.categoryByKey(cfg, kategori);
  if (!cat) return reply(msg, "Kategori tidak ditemukan.");
  st.step = "kategori";
  st.order = { kategori };
  st.order.field = cat.field;
  const ops = cat.operators || {};
  const keys = Object.keys(ops);
  const rows = chunk(keys.map((id) => ({ text: ops[id], data: "op:" + id })), 2);
  rows.push([{ text: "⬅️ Kategori", data: "back:kategori" }]);
  return flowEdit(msg, st, `Kategori *${cat.label.trim()}*\nPilih *provider*:`, rows);
}

const VOUCHER_PAGE = 20;

function renderVouchers(msg, st) {
  const cfg = st.cfg;
  const opId = st.order.operator;
  const list = st.voucherList || (cfg.vouchers[opId] || []);
  if (!list.length) {
    return flowEdit(msg, st, "Voucher tidak ditemukan untuk provider ini.");
  }
  st.voucherList = list;
  const page = st.vouchPage || 0;
  const total = list.length;
  const pages = Math.ceil(total / VOUCHER_PAGE);
  const cur = Math.max(0, Math.min(page, pages - 1));
  st.vouchPage = cur;

  const slice = list.slice(cur * VOUCHER_PAGE, (cur + 1) * VOUCHER_PAGE);
  const rows = slice.map((v) => {
    const label = v.nama + (v.status === 0 ? " (Kosong)" : "");
    return [{ text: label, data: "vch:" + v.id }];
  });

  const nav = [];
  if (cur > 0) nav.push({ text: "⬅️ Prev", data: "vchp:" + (cur - 1) });
  nav.push({ text: `Halaman ${cur + 1}/${Math.max(pages, 1)}`, data: "noop" });
  if (cur < pages - 1) nav.push({ text: "Next ➡️", data: "vchp:" + (cur + 1) });
  rows.push(nav);
  rows.push([{ text: "⬅️ Provider", data: "back:operator" }]);

  const header = total > VOUCHER_PAGE ? ` (${total} paket — pakai halaman)` : "";
  return flowEdit(msg, st, `Provider *${cfg.operators[opId] || opId}*\nPilih *paket*${header}:`, rows);
}

async function handleOpPick(chatId, msg, st, opId) {
  st.order.operator = opId;
  st.vouchPage = 0;
  return renderVouchers(msg, st);
}

async function handleVchPick(chatId, msg, st, vchId) {
  const cfg = st.cfg;
  const opId = st.order.operator;
  const v = (cfg.vouchers[opId] || []).find((x) => x.id === vchId);
  if (!v) return reply(msg, "Paket tidak ditemukan.");
  if (v.status === 0) return reply(msg, "Paket sedang kosong, pilih yang lain.");

  st.order.voucher = vchId;
  st.order.harga = v.harga;
  st.order.voucherName = v.nama;

  if (st.order.field === "barcode_voucher") {
    st.step = "barcode";
    return flowEdit(msg, st, `Paket: *${cfg.operators[opId]} — ${v.nama}*\nHarga: ${formatHarga(v.harga)}\n\nKetik *Kode/Barcode Voucher*:`);
  }
  const fieldLabel = st.order.field === "id_plgn" ? "ID Pelanggan / ID Game" : "Nomor HP / tujuan";
  st.step = "nomor";
  return flowEdit(msg, st, `Paket: *${cfg.operators[opId]} — ${v.nama}*\nHarga: ${formatHarga(v.harga)}\n\nKetik *${fieldLabel}* (atau /batal untuk batal):`);
}

async function handleDirect(chatId, msg, st, payload) {
  const [opId, vchId] = payload.split(":");
  let cfg = st.cfg;
  if (!cfg) {
    await showBusy(msg, st, "Memuat produk");
    try {
      cfg = await order.getOrderConfig();
    } catch (e) {
      return reply(msg, "Gagal memuat config: " + e.message);
    }
    st.cfg = cfg;
  }
  const cat = order.findCategoryForOperator(cfg, opId);
  if (!cat) return reply(msg, "Kategori tidak ditemukan untuk operator ini.");
  const v = (cfg.vouchers[opId] || []).find((x) => x.id === vchId);
  if (!v) return reply(msg, "Paket tidak ditemukan.");
  if (v.status === 0) return reply(msg, "Paket sedang kosong, pilih yang lain.");

  st.order = {
    kategori: cat.key,
    field: cat.field,
    operator: opId,
    voucher: vchId,
    harga: v.harga,
    voucherName: v.nama,
  };
  const opName = cfg.operators[opId] || opId;

  if (cat.field === "barcode_voucher") {
    st.step = "barcode";
    return flowEdit(msg, st, `Paket: *${opName} — ${v.nama}*\nHarga: ${formatHarga(v.harga)}\n\nKetik *Kode/Barcode Voucher*:`);
  }
  const fieldLabel = cat.field === "id_plgn" ? "ID Pelanggan / ID Game" : "Nomor HP / tujuan";
  st.step = "nomor";
  return flowEdit(msg, st, `Paket: *${opName} — ${v.nama}*\nHarga: ${formatHarga(v.harga)}\n\nKetik *${fieldLabel}* (atau /batal untuk batal):`);
}

/* ==================== pembayaran & captcha & submit ==================== */

async function handlePayPick(chatId, msg, st, pay) {
  if (pay === "balance" && !isAllowed(chatId)) {
    return reply(msg, "🔒 Pembayaran *Saldo Akun* hanya untuk admin. Pilih QRIS.", { parse_mode: "Markdown" });
  }
  st.order.pembayaran = pay;
  const payName = (st.cfg.payments[pay] && st.cfg.payments[pay].nama) || pay;
  st.step = "captcha";
  await flowEdit(msg, st, `Pembayaran: *${payName}*\nKetik *kode keamanan* (captcha) dari gambar yang dikirim di atas:`, []);
  const ok = await sendCaptcha(chatId);
  if (ok) st.step = "wait_captcha";
  else {
    clearState(chatId);
    return reply(msg, "Silakan coba lagi dengan /order.");
  }
}

async function doSubmit(chatId, msg, st) {
  const o = st.order;
  const canvas = st.flowMsg;
  const payName = (st.cfg.payments[o.pembayaran] && st.cfg.payments[o.pembayaran].nama) || o.pembayaran;
  const proc = await reply({ chat: { id: chatId } }, "Memproses order...");
  // ambil csrf token segar dari home agar cocok dengan cookie
  const fresh = await order.getOrderConfig();
  const csrf = fresh.csrfToken || st.cfg.csrfToken;
  const submit = await order.submitOrder({
    kategori: o.kategori,
    operator: o.operator,
    voucher: o.voucher,
    values: o.values,
    pembayaran: o.pembayaran,
    captcha: o.captcha,
    csrfToken: csrf,
  });
  await bot.deleteMessage(chatId, proc.message_id).catch(() => {})

  let out;
  if (submit.json && submit.json.success) {
    let id = submit.json.id || (submit.json.data && submit.json.data.id) || submit.json.trx;
    if (!id && Array.isArray(submit.json.errors) === false) {
      try {
        const h = await akun.getHistory(1);
        id = h.rows[0] && h.rows[0].id;
      } catch (e) {
        id = "";
      }
    }
    const nomor = (o.values && (o.values.nomor_hp || o.values.id_plgn || o.values.barcode_voucher)) || "";
    await ledger.add({
      trx: String(id || ""),
      chat: chatId,
      user: userName(msg) || String(chatId),
      kategori: o.kategori,
      provider: (st.cfg.operators && st.cfg.operators[o.operator]) || o.operator,
      voucher: o.voucherName,
      nomor,
      harga: formatHarga(o.harga),
      pembayaran: payName,
      tanggal: new Date().toLocaleString("id-ID", { dateStyle: "short", timeStyle: "short" }),
      statusPembayaran: o.pembayaran === "qris_livin_nt" ? "Pending" : "Lunas",
      statusPengisian: "Menunggu proses",
      status: "Pending",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const pairs = [
      ["Jenis", o.kategori],
      ["Paket", o.voucherName],
      ["Harga", formatHarga(o.harga)],
      ["Nomor", nomor],
      ["Pembayaran", payName],
      ["ID Transaksi", String(id || "")],
      ["Waktu", new Date().toLocaleString("id-ID", { dateStyle: "short", timeStyle: "short" })],
      ["Status Bayar", o.pembayaran === "qris_livin_nt" ? "Pending" : "Lunas"],
      ["Status Isi", "Menunggu proses"],
    ];
    const note = o.pembayaran === "qris_livin_nt" ? "Kirim QR untuk pembayaran..." : "Cek status: /riwayat";
    const html =
      "<b>✅ Order Sukses!</b>\n<table bordered>" +
      pairs.map(([k, v]) => "<tr><th>" + escHtml(k) + "</th><td>" + escHtml(v) + "</td></tr>").join("") +
      "</table>\n" + note;
    const fallback =
      "✅ *Order Sukses!*\n" +
      pairs.map(([k, v]) => k + ": " + fmt(v)).join("\n") +
      "\n\n" + note;
    clearState(chatId);
    await bot.sendRichMessage(chatId, html, fallback, { parse_mode: "Markdown" });
    await bot.deleteMessage(chatId, canvas).catch(() => {});

    if (o.pembayaran === "qris_livin_nt" && id) {
      const s = await buildQrSet(id, null);
      if (s.buffer) {
        await bot.sendPhoto(chatId, s.buffer, {
          caption: "🧾 *Scan & bayar QRIS*\n" + s.buyer + "\n\nScan QR, bayar, lalu tekan *Konfirmasi Pembayaran*. Bot akan mengabari begitu lunas.",
          parse_mode: "Markdown",
          ...inlineButtons(confirmButton(id)),
        });
        startQrisPoll(chatId, id);
      } else {
        await reply({ chat: { id: chatId } }, "Order dibuat (#" + id + "). QR belum tersedia saat ini: " + (s.error || "cek /riwayat"), { parse_mode: "Markdown" });
      }
    }
    return;
  } else {
    const errs = submit.json && Array.isArray(submit.json.errors) ? submit.json.errors : ["Gagal memproses order (status " + submit.status + ")"];
    out = "❌ *Order gagal:*\n" + errs.map((e) => "• " + e).join("\n") + "\n\nSilakan coba lagi /order. Captcha/CSRF sudah diperbarui otomatis.";
    clearState(chatId);
    await bot.deleteMessage(chatId, canvas).catch(() => {});
  }
  return reply({ chat: { id: chatId } }, out, { parse_mode: "Markdown" });
}

/* ==================== detail riwayat ==================== */

async function handleHistoryDetail(chatId, msg, id) {
  if (!isAllowed(chatId)) {
    const e = ledger.get(id);
    if (!e || String(e.chat) !== String(chatId)) {
      return reply(msg, "🔒 Detail transaksi ini bukan milik Anda.");
    }
  }
  const wait = await reply(msg, "Mengambil detail transaksi...");
  try {
    const d = await akun.getHistoryDetail(id);
    await bot.deleteMessage(chatId, wait.message_id).catch(() => {});
    const pairs = [
      ["Jenis Produk", d.jenisProduk],
      ["Provider", d.provider],
      ["Nominal", d.nominal],
      ["Nomor HP", d.noHp],
      ["Harga", d.harga],
      ["Pembayaran", d.pembayaran],
      ["Tgl Beli", d.tanggal],
      ["Tgl Bayar", d.tanggalBayar],
      ["Status Bayar", d.statusPembayaran],
      ["Status Isi", d.statusPengisian],
      ["SN/Ref", d.snRef],
      ["ID Pelanggan", d.idPelanggan],
      ["Token", d.token],
    ].filter(([k, v]) => v && v !== "-");
    const html =
      `<b>🔍 Detail Transaksi #${escHtml(id)}</b>\n<table bordered>` +
      pairs.map(([k, v]) => `<tr><th>${escHtml(k)}</th><td>${escHtml(v)}</td></tr>`).join("") +
      "</table>";
    const fallback = ["🔍 *Detail Transaksi #" + id + "*"].concat(pairs.map(([k, v]) => k + ": " + fmt(v))).join("\n");
    const btns = [[{ text: "🖨️ Cetak Struk", data: "struk:" + id }], [{ text: "⬅️ Riwayat", data: "menu:riwayat" }]];
    return bot.sendRichMessage(chatId, html, fallback, {
      parse_mode: "Markdown",
      reply_markup: inlineButtons(btns).reply_markup,
    });
  } catch (e) {
    await bot.deleteMessage(chatId, wait.message_id).catch(() => {});
    return reply(msg, "Gagal: " + e.message);
  }
}

async function handleStruk(chatId, msg, id) {
  const idn = parseId(String(id));
  if (!isAllowed(chatId)) {
    const e = ledger.get(idn);
    if (!e || String(e.chat) !== String(chatId)) {
      return reply(msg, "🔒 Ini bukan transaksi Anda.");
    }
  }
  const wait = await reply(msg, "Membuat struk pembayaran...");
  try {
    const d = await akun.getHistoryDetail(idn);
    const sell = roundSell(d.harga);
    const buf = await generateStruk({
      trx: idn,
      tanggal: d.tanggal,
      produk: (d.jenisProduk ? d.jenisProduk + " — " : "") + (d.nominal || d.paket || "-"),
      provider: d.provider,
      nomor: d.noHp,
      idPelanggan: d.idPelanggan,
      metode: d.pembayaran,
      harga: formatRp(sell),
      snRef: d.snRef,
      token: d.token,
      status: d.statusPengisian,
    });
    await bot.deleteMessage(chatId, wait.message_id).catch(() => {});
    if (!buf) return reply(msg, "Gagal membuat gambar struk.");
    return bot.sendPhoto(chatId, buf, {
      caption: "🧾 *Struk pembayaran #" + idn + "*\nKirim gambar ini ke pelanggan.",
      parse_mode: "Markdown",
      reply_markup: inlineButtons([[{ text: "⬅️ Detail", data: "hist:" + idn }]]).reply_markup,
    });
  } catch (e) {
    await bot.deleteMessage(chatId, wait.message_id).catch(() => {});
    return reply(msg, "Gagal membuat struk: " + e.message);
  }
}

/* ==================== message capture (reply keyboard, nomor & captcha) ==================== */

function startCari(msg) {
  const st = getState(msg.chat.id);
  st.cariWait = true;
  return reply(
    msg,
    "🔍 *Cari Harga*\nKetik *kata kunci* yang mau dicari.\nContoh: `axis 5`, `10 gb telkomsel`\n\nKetik /batal untuk membatalkan.",
    { parse_mode: "Markdown" }
  );
}

const REPLY_ACTION = {
  "🔍 Cari Harga": startCari,
  "💰 Saldo Akun": (msg) => guard(doSaldo)(msg),
  "📋 Riwayat": (msg) => doRiwayat(msg),
  "🧾 Mutasi": (msg) => guard(doMutasi)(msg),
  "🛒 Order": (msg) => doOrder(msg),
  "➕ Deposit": (msg) => doDeposit(msg),
  "❓ Bantuan": async (msg) => {
    await reply(msg, helpFor(msg.chat.id), { parse_mode: "Markdown" });
    return showMainMenu(msg.chat.id);
  },
};

bot.on("message", async (msg) => {
  if (!msg.text) return;
  const chatId = msg.chat.id;
  if (isRateLimited(chatId)) return;
  const st = getState(chatId);
  const text = msg.text.trim();

  const action = REPLY_ACTION[text];
  if (action) {
    if (st && st.step) {
      return reply(msg, "Masih dalam proses order. Ketik /batal untuk batal, lalu gunakan menu lagi.");
    }
    if (st && st.cariWait && action !== startCari) delete st.cariWait;
    return action(msg);
  }

  if (text.startsWith("/")) {
    if (text === "/batal" && st && st.cariWait) {
      delete st.cariWait;
      return reply(msg, "Pencarian dibatalkan.");
    }
    return;
  }

  if (st && st.cariWait) {
    delete st.cariWait;
    return handleCari(msg, text);
  }

  if (st.depStep === "amount") {
    const nominal = parseInt(text.replace(/[^0-9]/g, ""), 10);
    if (!nominal || nominal < 10000) {
      return reply(msg, "Nominal minimal *Rp 10.000*. Ketik ulang nominal (atau /batal):", { parse_mode: "Markdown", ...removeKeyboard() });
    }
    st.dep.amount = nominal;
    st.depStep = "choose_pay";
    chatAction(chatId);
    try {
      const m = await akun.getDepositMethods();
      st.dep.methods = m.methods;
      st.dep.csrf = m.csrf;
    } catch (e) {
      clearDep(chatId);
      return reply(msg, "Gagal memuat metode pembayaran: " + e.message);
    }
    if (!(st.dep.methods || []).length) {
      clearDep(chatId);
      return reply(msg, "Tidak ada metode pembayaran deposit tersedia saat ini.");
    }
    const rows = chunk(st.dep.methods.map((x) => ({ text: x.label, data: "dep:pay:" + x.value })), 2);
    rows.push([{ text: "⬅️ Menu Utama", data: "menu" }]);
    return depNew(msg, st, `Nominal deposit: *${formatHarga(nominal)}*\nPilih *metode pembayaran*:`, rows);
  }

  if (!st.step) return;

  if (st.step === "barcode") {
    st.order.values = { barcode_voucher: text };
    st.step = "nomor";
    const op = st.cfg.operators[st.order.operator] || st.order.operator;
    const pairs = [
      ["Jenis", orderCatLabel(st, st.order.kategori)],
      ["Paket", op + " — " + st.order.voucherName],
      ["Harga", formatHarga(st.order.harga)],
      ["Kode/Barcode", text],
    ];
    return flowNewRich(
      msg,
      st,
      orderTableHtml("Ringkasan Order", pairs) + "\n<b>Sekarang ketik Nomor HP tujuan:</b>",
      orderTableFallback("Ringkasan Order", pairs) + "\n\nSekarang ketik *Nomor HP* tujuan:",
      []
    );
  }

  if (st.step === "nomor") {
    if (!st.order.values) st.order.values = {};
    const field = st.order.field || "nomor_hp";
    const key = field === "id_plgn" ? "id_plgn" : "nomor_hp";
    
    // Validasi input
    const cleaned = text.replace(/[^0-9]/g, "");
    if (key === "nomor_hp") {
      // Validasi nomor HP: harus 10-13 digit
      if (!/^[0-9]{10,13}$/.test(cleaned)) {
        return reply(msg, "⚠️ Nomor HP tidak valid. Masukkan 10-13 digit angka.\nContoh: 081234567890");
      }
    } else {
      // Validasi ID Pelanggan: harus 10-15 digit
      if (!/^[0-9]{10,15}$/.test(cleaned)) {
        return reply(msg, "⚠️ ID Pelanggan/ID Game tidak valid. Masukkan 10-15 digit angka.");
      }
    }
    
    st.order.values[key] = cleaned;
    const pay = st.cfg.payments;
    const rows = [];
    if (isAllowed(chatId) && pay.balance) rows.push([{ text: "Saldo Akun (" + formatHarga(st.order.harga) + ")", data: "pay:balance" }]);
    if (pay.qris_livin_nt) rows.push([{ text: "QRIS (" + formatHarga(st.order.harga) + ")", data: "pay:qris_livin_nt" }]);
    if (!rows.length) {
      bot.editMessageText(chatId, st.flowMsg, "⚠️ Pembayaran tidak tersedia.", {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: [] },
      }).catch(() => {});
      clearState(chatId);
      return reply(msg, "Tidak ada metode pembayaran tersedia untuk user biasa saat ini (QRIS tidak tersedia).", removeKeyboard());
    }
    st.step = "pembayaran";
    const op = st.cfg.operators[st.order.operator] || st.order.operator;
    const pairs = [
      ["Jenis", orderCatLabel(st, st.order.kategori)],
      ["Paket", op + " — " + st.order.voucherName],
      ["Harga", formatHarga(st.order.harga)],
      ["Nomor", text],
    ];
    return flowNewRich(
      msg,
      st,
      orderTableHtml("Ringkasan Order", pairs) + "\n<b>Pilih metode pembayaran:</b>",
      orderTableFallback("Ringkasan Order", pairs) + "\n\nPilih *metode pembayaran*:",
      rows
    );
  }

  if (st.step === "wait_captcha") {
    st.order.captcha = text;
    return doSubmit(chatId, msg, st);
  }
});

/* ==================== boot ==================== */

console.log("KonterBot sedang berjalan.");
console.log(
  LOADED_FROM_FILE
    ? "Konfigurasi dibaca dari file .env"
    : "Konfigurasi dibaca dari environment/Replit Secrets"
);
if (!process.env.TELEGRAM_BOT_TOKEN && !require("./config").BOT_TOKEN) {
  console.error("WARNING: TELEGRAM_BOT_TOKEN belum diisi.");
}
if (!require("./config").BASE_URL) {
  console.error("WARNING: KONTER_BASE_URL belum diisi (isi di .env / secrets).");
}