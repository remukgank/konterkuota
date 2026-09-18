"use strict";

const { getHTML, request } = require("./konterApi");
const { extractVar, parseCatalog, extractSelectOptions, extractCsrfFromHtml } = require("./harga");

const BASE_URL = require("./config").BASE_URL;

const CATEGORY_ORDER = [
  "pulsa", "kuota_axis", "kuota_indosat", "kuota_smartfren", "kuota_telkomsel",
  "kuota_tri", "kuota_xl", "kuota_byu", "nelpon_sms", "game", "token_pln",
  "voucher_digital", "voucher_internet", "voucher_game", "indosat_gift",
  "telkomsel_combo_sakti", "paket_internet", "pdam", "tagihan", "dompet_digital",
  "telkomsel_bulk", "indosat_only4u", "tv_prabayar", "pbb", "aktivasi_voucher",
];

function categoryBlock(html, key) {
  const si = html.indexOf('id="' + key + '"');
  if (si === -1) return null;
  const nextCats = CATEGORY_ORDER.map((c) => 'id="' + c + '"').filter(
    (t) => html.indexOf(t) > si
  );
  nextCats.push('id="keterangan"');
  const end = Math.min(...nextCats.map((t) => html.indexOf(t)).filter((v) => v > -1));
  return html.slice(si, end === -1 ? html.length : end);
}

function parseCategories(html) {
  const cats = [];
  const m = html.match(/<select[^>]*id="produk-select"[\s\S]*?<\/select>/);
  const sel = m ? m[0] : html;
  const optRe = /<option[^>]*value="([^"]*)"[^>]*>([\s\S]*?)<\/option>/g;
  let o;
  while ((o = optRe.exec(sel))) {
    const val = o[1];
    if (!val) continue;
    const label = o[2].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    const blk = categoryBlock(html, val) || "";
    cats.push({
      key: val,
      label,
      field: categoryFieldFromBlock(blk),
      operators: extractSelectOptions(blk, "operator"),
    });
  }
  return cats;
}

function categoryFieldFromBlock(blk) {
  const hasBarcode = /<input[^>]*name="barcode_voucher"/.test(blk);
  if (hasBarcode) return "barcode_voucher";
  const hasIdPlgn = /<input[^>]*name="id_plgn"/.test(blk);
  if (hasIdPlgn) return "id_plgn";
  return "nomor_hp";
}

async function getOrderConfig() {
  const r = await getHTML("/");
  const catalog = parseCatalog(r.text);
  return {
    status: r.status,
    categories: parseCategories(r.text),
    operators: catalog.operators,
    vouchers: catalog.vouchers,
    payments: catalog.payments,
    csrfToken: extractCsrfFromHtml(r.text),
  };
}

function categoryByKey(cfg, key) {
  return cfg.categories.find((c) => c.key === key) || null;
}

function findCategoryForOperator(cfg, opId) {
  return cfg.categories.find((c) => c.operators && c.operators[opId]) || null;
}

async function submitOrder({ kategori, operator, voucher, values, pembayaran, captcha, csrfToken }) {
  const endpoint = BASE_URL + "/" + kategori;

  const data = {
    csrf_token: csrfToken,
    operator,
    voucher,
    pembayaran,
    captcha,
    json_format: "1",
  };
  if (values) {
    if (values.nomor_hp) data.nomor_hp = values.nomor_hp;
    if (values.id_plgn) data.id_plgn = values.id_plgn;
    if (values.barcode_voucher) data.barcode_voucher = values.barcode_voucher;
  }

  const r = await request("POST", endpoint, { form: data });
  let text = "";
  try {
    text = await r.text();
  } catch (e) {
    text = "";
  }
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch (e) {
      json = null;
    }
  }
  return { status: r.status, json, text };
}

module.exports = {
  getOrderConfig,
  categoryByKey,
  findCategoryForOperator,
  submitOrder,
  CATEGORY_ORDER,
};
