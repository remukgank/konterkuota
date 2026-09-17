"use strict";

const { loadCatalog, searchProducts, formatHarga } = require("../src/harga");

(async () => {
  const cat = await loadCatalog();
  console.log("HTTP status:", cat.status);
  console.log("operator count:", Object.keys(cat.operators).length);
  console.log("voucher group count:", Object.keys(cat.vouchers).length);
  const total = Object.values(cat.vouchers).reduce((a, v) => a + v.length, 0);
  console.log("total voucher:", total);
  console.log("payment count:", Object.keys(cat.payments).length);
  console.log("csrf token:", cat.csrfToken ? cat.csrfToken.slice(0, 12) + "..." : "(kosong)");

  const arg = process.argv[2] || "axis 5";
  console.log("\nCari: '" + arg + "'");
  const res = searchProducts(cat, arg);
  console.log("hasil:", res.length);
  for (const p of res.slice(0, 10)) {
    console.log(
      `  [${p.operatorName}] ${p.nama} = ${formatHarga(p.harga)}  status=${p.status} op=${p.operatorId} vc=${p.voucherId}`
    );
  }
})().catch((e) => {
  console.error("ERR", e);
  process.exit(1);
});
