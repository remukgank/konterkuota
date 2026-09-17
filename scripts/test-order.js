"use strict";

const order = require("../src/order");
const { getBuffer } = require("../src/konterApi");

(async () => {
  console.log("== getOrderConfig ==");
  const cfg = await order.getOrderConfig();
  console.log("status:", cfg.status);
  console.log("categories:", cfg.categories.length);
  for (const c of cfg.categories.slice(0, 8)) {
    const opCount = Object.keys(c.operators || {}).length;
    console.log(`  ${c.key.padEnd(20)} field=${c.field}  opPerKategori=${opCount}  label=${c.label.trim()}`);
  }
  console.log("operator (global):", Object.keys(cfg.operators).length);
  console.log("total voucher group:", Object.keys(cfg.vouchers).length);
  console.log("csrf token:", cfg.csrfToken ? cfg.csrfToken.slice(0, 12) + "..." : "(kosong)");

  // sample popular category: pulsa operator 5 telkomsel voucher count
  const tel = (cfg.vouchers["5"] || []).length;
  console.log("operator 5 (Telkomsel) voucher count:", tel);

  console.log("\n== captcha buffer ==");
  const cap = await getBuffer("/captcha?r=" + Date.now());
  console.log("status:", cap.status, "| bytes:", cap.buffer ? cap.buffer.length : 0, "| type:", cap.contentType);
})().catch((e) => {
  console.error("ERR", e);
  process.exit(1);
});
