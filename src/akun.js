"use strict";

const { getHTML } = require("./konterApi");

function cleanSaldo(v) {
  return v.replace(/\s*Tambah Saldo.*$/i, "").trim();
}

function stripTags(html) {  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/\s+/g, " ")
    .trim();
}

// Parse a `<tr><td>label</td><td>value</td></tr>` table into a key->value map.
function parseKeyValueTable(html) {
  const map = {};
  const trRe = /<tr>([\s\S]*?)<\/tr>/g;
  let tr;
  while ((tr = trRe.exec(html))) {
    const tds = [...tr[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map((x) => x[1]);
    if (tds.length < 2) continue;
    const key = stripTags(tds[0]);
    let val = stripTags(tds[1]);
    if (!key) continue;
    // remove leading ":" that appears in profile values
    val = val.replace(/^:\s*/, "");
    map[key] = val;
  }
  return map;
}

async function getProfil() {
  const r = await getHTML("/akun/profil");
  const kv = parseKeyValueTable(r.text);
  return {
    status: r.status,
    nama: kv["Nama Lengkap"] || "",
    pengguna: kv["Nama Pengguna"] || "",
    email: kv["Email"] || "",
    noHp: kv["No. HP"] || "",
    statusAkun: kv["Status Akun"] || "",
    jenisAkun: kv["Jenis Akun"] || "",
    saldo: cleanSaldo(kv["Saldo"] || ""),
    saldoQris: kv["Saldo Qris"] || "",
    totalTransaksi: kv["Total Transaksi"] || "",
    text: stripTags(r.text),
  };
}

function parseHistoryTable(html) {
  const rows = [];
  const m = html.match(/<tbody id="history_transaksi">([\s\S]*?)<\/tbody>/);
  if (!m) return rows;
  const tbody = m[1];
  const trRe = /<tr>([\s\S]*?)<\/tr>/g;
  let tr;
  while ((tr = trRe.exec(tbody))) {
    const tds = [...tr[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map((x) => x[1]);
    const linkIdx = tds.findIndex((c) => /\/view\/\d+/.test(c));
    if (linkIdx === -1 || tds.length < linkIdx + 7) continue;
    const idM = tds[linkIdx].match(/(?:riwayat-transaksi|history)\/view\/(\d+)/);
    rows.push({
      no: stripTags(tds[0] || ""),
      id: idM ? idM[1] : "",
      tanggal: stripTags(tds[linkIdx].replace(/<a[^>]*>/g, "").replace(/<\/a>/g, "")),
      provider: stripTags(tds[linkIdx + 1]),
      voucher: stripTags(tds[linkIdx + 2]),
      noHp: stripTags(tds[linkIdx + 3]),
      harga: stripTags(tds[linkIdx + 4]),
      pembayaran: stripTags(tds[linkIdx + 5]),
      status: stripTags(tds[linkIdx + 6]),
    });
  }
  return rows;
}

async function getHistory(limit = 5) {
  const r = await getHTML("/akun/riwayat-transaksi");
  const rows = parseHistoryTable(r.text);
  return { status: r.status, rows: rows.slice(0, limit) };
}

async function getHistoryDetail(id) {
  const r = await getHTML("/akun/riwayat-transaksi/view/" + encodeURIComponent(id));
  const kv = parseKeyValueTable(r.text);
  return {
    status: r.status,
    id,
    jenisProduk: kv["Jenis Produk"] || "",
    paket: kv["Paket"] || "",
    nominal: kv["Nominal"] || "",
    noHp: kv["Nomor HP"] || "",
    harga: kv["Harga"] || "",
    pembayaran: kv["Pembayaran"] || "",
    tanggal: kv["Tanggal Pembelian"] || "",
    statusPembayaran: kv["Status Pembayaran"] || "",
    statusPengisian: kv["Status Pengisian"] || "",
  };
}

async function getPaymentQr(trx) {
  const view = await getHTML("/akun/riwayat-transaksi/view/" + encodeURIComponent(trx));
  const m = (view.text || "").match(/\/payment\/qris_livin_nt\/get_qr\/(\d+)/);
  if (!m) return { ok: false, error: "Sesi QR tidak ditemukan." };
  const session = m[1];
  const qr = await getHTML("/payment/qris_livin_nt/get_qr/" + session);
  const t = qr.text || "";
  if (/^ERROR/.test(t)) return { ok: false, error: t.slice(0, 160), session };
  let buffer = null;
  try {
    buffer = Buffer.from(t, "base64");
  } catch (e) {
    buffer = null;
  }
  return { ok: !!buffer && buffer.length > 100, buffer, session, panjang: t.length };
}

async function getMutasi(limit = 5) {
  const r = await getHTML("/akun/riwayat-saldo");
  const text = stripTags(r.text);
  const idx = text.indexOf("Mutasi Saldo ");
  const after = idx === -1 ? text : text.slice(idx);
  const lines = after.split(/(?=\d{2}\/\d{2}\/\d{4} \d{2}:\d{2})/);
  const rows = lines
    .map((l) => l.trim())
    .filter((l) => /^\d{2}\/\d{2}\/\d{4}/.test(l))
    .slice(0, limit)
    .map((l) => {
      const tm = l.match(/^(\d{2}\/\d{2}\/\d{4} \d{2}:\d{2})/);
      const tanggal = tm ? tm[1] : "";
      const jm = l.match(/([+\-]\d[\d.]*)\s+(\d[\d.]+\s*)$/);
      let jumlah = "";
      let saldoAkhir = "";
      if (jm) {
        jumlah = jm[1];
        saldoAkhir = jm[2];
      }
      let ket = l.slice(tanggal.length).replace(jm ? jm[0] : "", "");
      return { tanggal, keterangan: ket.trim(), jumlah, saldoAkhir };
    });
  return { status: r.status, rows };
}

module.exports = { getProfil, getHistory, getHistoryDetail, getPaymentQr, getMutasi };
