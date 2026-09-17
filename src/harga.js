"use strict";

const { getHTML } = require("./konterApi");

function extractVar(html, varName) {
  const key = "var " + varName + " = ";
  const start = html.indexOf(key);
  if (start === -1) return null;
  const bodyStart = start + key.length;
  const open = html[bodyStart];
  const close = open === "{" ? "}" : open === "[" ? "]" : null;
  if (!close) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = bodyStart; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) {
        const raw = html.slice(bodyStart, i + 1);
        try {
          return JSON.parse(raw);
        } catch (e) {
          return null;
        }
      }
    }
  }
  return null;
}

function extractSelectOptions(fragment, name) {
  const re = new RegExp(
    "<select[^>]*name=\"" + name + "\"[^>]*>([\\s\\S]*?)</select>",
    "gi"
  );
  const map = {};
  let m;
  while ((m = re.exec(fragment))) {
    const inner = m[1];
    const optRe = /<option[^>]*value="([^"]*)"[^>]*>([\s\S]*?)<\/option>/gi;
    let o;
    while ((o = optRe.exec(inner))) {
      const val = o[1];
      let label = o[2].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
      if (val !== "" && label !== "") map[val] = label;
    }
  }
  return map;
}

function parseCatalog(html) {
  const vouchers = extractVar(html, "vouchers");
  const payments = extractVar(html, "payments");
  const operators = {};
  if (html) {
    Object.assign(operators, extractSelectOptions(html, "operator"));
  }
  return { vouchers: vouchers || {}, payments: payments || {}, operators };
}

async function loadCatalog() {
  const r = await getHTML("/");
  const catalog = parseCatalog(r.text);
  catalog.csrfToken = extractCsrfFromHtml(r.text);
  catalog.status = r.status;
  return catalog;
}

function extractCsrfFromHtml(html) {
  const m = html.match(/name="csrf_token" value="([^"]+)"/);
  return m ? m[1] : "";
}

function searchProducts(catalog, query) {
  const q = query.trim().toLowerCase();
  const out = [];
  for (const opId of Object.keys(catalog.vouchers)) {
    const opName = catalog.operators[opId] || ("Operator " + opId);
    for (const v of catalog.vouchers[opId]) {
      const nama = (v.nama || "").toLowerCase();
      if (nama.includes(q)) {
        out.push({
          operatorId: opId,
          operatorName: opName,
          voucherId: v.id,
          nama: v.nama,
          harga: v.harga,
          status: v.status,
        });
      }
    }
  }
  return out;
}

function formatHarga(harga) {
  const n = parseInt(harga, 10);
  if (isNaN(n)) return "Rp -";
  return "Rp " + n.toLocaleString("id-ID");
}

module.exports = { loadCatalog, parseCatalog, searchProducts, formatHarga, extractCsrfFromHtml, extractSelectOptions };
