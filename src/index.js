"use strict";

const { initBot, isAllowed, guard, reply, inlineButtons, removeKeyboard } = require("../bot/telegram");
const { loadCatalog, searchProducts, formatHarga } = require("./harga");
const akun = require("./akun");
const order = require("./order");
const ledger = require("./ledger");
const { getBuffer, request } = require("./konterApi");
const { BASE_URL, LOADED_FROM_FILE } = require("./config");
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const bot = initBot();

const states = new Map();

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
  return states.get(chatId);
}

function clearState(chatId) {
  states.delete(chatId);
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
    const d = await akun.getHistoryDetail(entry.trx);
    const stNow = (d.statusPembayaran || "-") + " / " + (d.statusPengisian || "-");
    if (stNow !== entry.last) {
      entry.last = stNow;
      ledger.updateStatus(entry.trx, {
        statusPembayaran: d.statusPembayaran,
        statusPengisian: d.statusPengisian,
        status: d.statusPengisian || d.statusPembayaran,
      });
      if (/sukses/i.test(stNow)) {
        await reply({ chat: { id: chatId } }, "✅ *Pembayaran diterima & pengisian sukses!*\nTrx *#" + entry.trx + "*\nStatus: " + stNow, { parse_mode: "Markdown" });
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
  if (admin) {
    rows.push([{ text: "💰 Saldo Saya", data: "menu:saldo" }, { text: "🧾 Mutasi", data: "menu:mutasi" }]);
  }
  rows.push([{ text: "📋 Riwayat", data: "menu:riwayat" }, { text: "❓ Bantuan", data: "menu:bantuan" }]);
  return rows;
}

function replyKeyboardKeys(admin) {
  if (admin) {
    return [
      ["🛒 Order", "🔍 Cari Harga"],
      ["📋 Riwayat", "🧾 Mutasi"],
      ["💰 Saldo Akun", "❓ Bantuan"],
    ];
  }
  return [
    ["🛒 Order", "🔍 Cari Harga"],
    ["📋 Riwayat", "❓ Bantuan"],
  ];
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
  const wait = await reply(msg, "Mengambil data akun...");
  try {
    const p = await akun.getProfil();
    await bot.deleteMessage(chatId, wait.message_id).catch(() => {});
    if (p.status !== 200) {
      return reply(msg, "Gagal (status " + p.status + "). Cek KONTER_COOKIE / sesi login.");
    }
    const text = [
      "👤 *" + (p.nama || p.pengguna || "Akun") + "*",
      "User: " + fmt(p.pengguna),
      "No. HP: " + fmt(p.noHp),
      "Jenis: " + fmt(p.jenisAkun) + " (" + fmt(p.statusAkun) + ")",
      "",
      "💰 Saldo: " + fmt(p.saldo),
      "💳 Saldo QRIS: " + fmt(p.saldoQris),
      "",
      "Total transaksi sukses: " + fmt(p.totalTransaksi),
    ].join("\n");
    const rows = [
      [
        { text: "🧾 Mutasi", data: "menu:mutasi" },
        { text: "⬅️ Menu", data: "menu" },
        { text: "Top Up", url: BASE_URL + "/akun/profil" },
      ],
    ];
    return reply(msg, text, { parse_mode: "Markdown", ...inlineButtons(rows) });
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
  for (const e of slice) {
    if (!e.trx) continue;
    const row = [];
    if (isPendingStatus(e)) row.push({ text: "🖼️ Kirim QR #" + e.trx, data: "qr:" + e.trx });
    row.push({ text: "👁 Detail #" + e.trx, data: "hist:" + e.trx });
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
    return reply(msg, "🧾 *Mutasi Saldo*\n\n" + lines.join("\n\n") + "\n\n_klik ⬇️ untuk menu_", {
      parse_mode: "Markdown",
      ...inlineButtons([[{ text: "⬅️ Menu Utama", data: "menu" }]]),
    });
  } catch (e) {
    await bot.deleteMessage(chatId, wait.message_id).catch(() => {});
    return reply(msg, "Gagal: " + e.message);
  }
}
bot.onText(/^\/mutasi(?:\s+(\d+))?$/, guard(doMutasi));

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
  return reply(msg, "Pilih *kategori produk*:", { parse_mode: "Markdown", ...inlineButtons(rows) });
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
  if (!isAllowed(chatId)) {
    const e = ledger.get(id);
    if (!e || String(e.chat) !== String(chatId)) {
      return reply(msg, "🔒 Ini bukan transaksi Anda.");
    }
  }
  await reply(msg, "Mengirim konfirmasi pembayaran #" + id + "...");
  let r;
  try {
    r = await request("GET", "/payment/qris_livin_nt/trx/" + encodeURIComponent(id));
  } catch (e) {
    return reply(msg, "Gagal konfirmasi: " + e.message);
  }
  let d = null;
  try {
    d = await akun.getHistoryDetail(id);
  } catch (e) {
    d = null;
  }
  const st = (d ? d.statusPembayaran : "-") + " / " + (d ? d.statusPengisian : "-");
  if (d && d.statusPembayaran) {
    ledger.updateStatus(id, {
      statusPembayaran: d.statusPembayaran,
      statusPengisian: d.statusPengisian,
      status: d.statusPengisian || d.statusPembayaran,
    });
  }
  await reply(msg, "Konfirmasi terkirim (status " + r.status + ").\nStatus trx *#" + id + "*: " + st, { parse_mode: "Markdown" });
  const entry = ledger.get(id);
  const target = entry ? Number(entry.chat) : chatId;
  if (/sukses/i.test(st)) {
    if (target !== chatId) {
      await reply({ chat: { id: target } }, "✅ *Pembayaran diterima & pengisian sukses!*\nTrx *#" + id + "*\nStatus: " + st, { parse_mode: "Markdown" }).catch(() => {});
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
  const data = q.data || "";
  const st = getState(chatId);
  bot.answerCallbackQuery(q.id).catch(() => {});

  (async () => {
    if (data === "menu") return showMainMenu(chatId, "📋 *Menu Utama*");
    if (data === "menu:cari") return handleCari(q.message, "");
    if (data === "menu:saldo") return guard(doSaldo)(q.message);
    if (data === "menu:riwayat") return doRiwayat(q.message);
    if (data === "menu:mutasi") return guard(doMutasi)(q.message);
    if (data === "menu:order") return doOrder(q.message);
    if (data === "menu:bantuan") {
      await reply(q.message, helpFor(chatId), { parse_mode: "Markdown" });
      return showMainMenu(chatId);
    }
    if (data.startsWith("ord:")) return handleDirect(chatId, q.message, st, data.slice(4));
    if (data.startsWith("hist:")) return handleHistoryDetail(chatId, q.message, data.slice(5));
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
      clearState(chatId);
      return reply(q.message, "Dibatalkan.", removeKeyboard());
    }
    return reply(q.message, "Perintah tidak dikenal.");
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
  rows.push([{ text: "⬅️ Menu Utama", data: "menu" }]);
  return reply(msg, `Kategori *${cat.label.trim()}*\nPilih *provider*:`, {
    parse_mode: "Markdown",
    ...inlineButtons(rows),
  });
}

const VOUCHER_PAGE = 20;

function renderVouchers(msg, st) {
  const cfg = st.cfg;
  const opId = st.order.operator;
  const list = st.voucherList || (cfg.vouchers[opId] || []);
  if (!list.length) {
    return reply(msg, "Voucher tidak ditemukan untuk provider ini.");
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
  rows.push([{ text: "⬅️ Menu Utama", data: "menu" }]);

  const header = total > VOUCHER_PAGE ? ` (${total} paket — pakai halaman)` : "";
  return reply(msg, `Provider *${cfg.operators[opId] || opId}*\nPilih *paket*${header}:`, {
    parse_mode: "Markdown",
    ...inlineButtons(rows),
  });
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
    return reply(msg, `Paket: *${cfg.operators[opId]} — ${v.nama}*\nHarga: ${formatHarga(v.harga)}\n\nKetik *Kode/Barcode Voucher*:`, { parse_mode: "Markdown" });
  }
  const fieldLabel = st.order.field === "id_plgn" ? "ID Pelanggan / ID Game" : "Nomor HP / tujuan";
  st.step = "nomor";
  await reply(msg, `Paket: *${cfg.operators[opId]} — ${v.nama}*\nHarga: ${formatHarga(v.harga)}\n\nKetik *${fieldLabel}*:`, { parse_mode: "Markdown" });
  await reply(msg, "Cukup ketik teksnya. Ketik /batal untuk membatalkan.", { parse_mode: "Markdown" });
}

async function handleDirect(chatId, msg, st, payload) {
  const [opId, vchId] = payload.split(":");
  let cfg = st.cfg;
  if (!cfg) {
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
    return reply(msg, `Paket: *${opName} — ${v.nama}*\nHarga: ${formatHarga(v.harga)}\n\nKetik *Kode/Barcode Voucher*:`, { parse_mode: "Markdown" });
  }
  const fieldLabel = cat.field === "id_plgn" ? "ID Pelanggan / ID Game" : "Nomor HP / tujuan";
  st.step = "nomor";
  await reply(msg, `Paket: *${opName} — ${v.nama}*\nHarga: ${formatHarga(v.harga)}\n\nKetik *${fieldLabel}*:`, { parse_mode: "Markdown" });
  await reply(msg, "Cukup ketik teksnya. Ketik /batal untuk membatalkan.", { parse_mode: "Markdown" });
}

/* ==================== pembayaran & captcha & submit ==================== */

async function handlePayPick(chatId, msg, st, pay) {
  if (pay === "balance" && !isAllowed(chatId)) {
    return reply(msg, "🔒 Pembayaran *Saldo Akun* hanya untuk admin. Pilih QRIS.", { parse_mode: "Markdown" });
  }
  st.order.pembayaran = pay;
  const payName = (st.cfg.payments[pay] && st.cfg.payments[pay].nama) || pay;
  st.step = "captcha";
  await reply(msg, `Pembayaran: *${payName}*\nSebentar, ambil captcha...`, { parse_mode: "Markdown" });
  const ok = await sendCaptcha(chatId);
  if (ok) st.step = "wait_captcha";
}

async function doSubmit(chatId, msg, st) {
  const o = st.order;
  const payName = (st.cfg.payments[o.pembayaran] && st.cfg.payments[o.pembayaran].nama) || o.pembayaran;
  await reply({ chat: { id: chatId } }, "Memproses order...");
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
    ledger.add({
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
    out =
      "✅ *Order sukses!*\n" +
      `Trx: ${o.kategori} — ${o.voucherName}\n` +
      `Harga: ${formatHarga(o.harga)}\n` +
      `Pembayaran: ${payName}\n` +
      `ID Transaksi: ${id}\n\n` +
      (o.pembayaran === "qris_livin_nt" ? "Kirim QR untuk pembayaran..." : "Cek status: /riwayat");
    clearState(chatId);
    await reply({ chat: { id: chatId } }, out, { parse_mode: "Markdown" });

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
      ["Jenis", d.jenisProduk],
      ["Paket", d.paket],
      ["Nominal", d.nominal],
      ["Nomor", d.noHp],
      ["Harga", d.harga],
      ["Bayar", d.pembayaran],
      ["Tgl", d.tanggal],
      ["Status Bayar", d.statusPembayaran],
      ["Status Isi", d.statusPengisian],
    ];
    const html =
      `<b>🔍 Detail Transaksi #${escHtml(id)}</b>\n<table bordered>` +
      pairs.map(([k, v]) => `<tr><th>${escHtml(k)}</th><td>${escHtml(v)}</td></tr>`).join("") +
      "</table>";
    const fallback = ["🔍 *Detail Transaksi #" + id + "*"].concat(pairs.map(([k, v]) => k + ": " + fmt(v))).join("\n");
    return bot.sendRichMessage(chatId, html, fallback, { parse_mode: "Markdown" });
  } catch (e) {
    await bot.deleteMessage(chatId, wait.message_id).catch(() => {});
    return reply(msg, "Gagal: " + e.message);
  }
}

/* ==================== message capture (reply keyboard, nomor & captcha) ==================== */

const REPLY_ACTION = {
  "🔍 Cari Harga": (msg) => handleCari(msg, ""),
  "💰 Saldo Akun": (msg) => guard(doSaldo)(msg),
  "📋 Riwayat": (msg) => doRiwayat(msg),
  "🧾 Mutasi": (msg) => guard(doMutasi)(msg),
  "🛒 Order": (msg) => doOrder(msg),
  "❓ Bantuan": async (msg) => {
    await reply(msg, helpFor(msg.chat.id), { parse_mode: "Markdown" });
    return showMainMenu(msg.chat.id);
  },
};

bot.on("message", (msg) => {
  if (!msg.text) return;
  const chatId = msg.chat.id;
  const st = getState(chatId);
  const text = msg.text.trim();

  const action = REPLY_ACTION[text];
  if (action) {
    if (st && st.step) {
      return reply(msg, "Masih dalam proses order. Ketik /batal untuk batal, lalu gunakan menu lagi.");
    }
    return action(msg);
  }

  if (text.startsWith("/")) return;
  if (!st.step) return;

  if (st.step === "barcode") {
    st.order.values = { barcode_voucher: text };
    st.step = "nomor";
    return reply(msg, "Sekarang ketik *Nomor HP* tujuan:", { parse_mode: "Markdown" });
  }

  if (st.step === "nomor") {
    if (!st.order.values) st.order.values = {};
    const field = st.order.field || "nomor_hp";
    const key = field === "id_plgn" ? "id_plgn" : "nomor_hp";
    st.order.values[key] = text;
    const pay = st.cfg.payments;
    const rows = [];
    if (isAllowed(chatId) && pay.balance) rows.push([{ text: "Saldo Akun (" + formatHarga(st.order.harga) + ")", data: "pay:balance" }]);
    if (pay.qris_livin_nt) rows.push([{ text: "QRIS (" + formatHarga(st.order.harga) + ")", data: "pay:qris_livin_nt" }]);
    if (!rows.length) {
      clearState(chatId);
      return reply(msg, "Tidak ada metode pembayaran tersedia untuk user biasa saat ini (QRIS tidak tersedia).", removeKeyboard());
    }
    st.step = "pembayaran";
    return reply(msg, "Pilih *metode pembayaran*:", { parse_mode: "Markdown", ...inlineButtons(rows) });
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