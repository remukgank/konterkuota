"use strict";

const akun = require("../src/akun");

(async () => {
  console.log("== PROFIL ==");
  const p = await akun.getProfil();
  console.log("status:", p.status);
  console.log("nama:", p.nama, "| user:", p.pengguna);
  console.log("noHp:", p.noHp, "| jenis:", p.jenisAkun, "| statusAkun:", p.statusAkun);
  console.log("saldo:", p.saldo);
  console.log("saldoQris:", p.saldoQris);
  console.log("totalTransaksi:", p.totalTransaksi);

  console.log("\n== RIWAYAT (3) ==");
  const h = await akun.getHistory(3);
  console.log("status:", h.status);
  for (const r of h.rows) {
    console.log(`#${r.no} [${r.id}] ${r.tanggal} | ${r.provider} | ${r.voucher} | ${r.harga} | ${r.pembayaran} | ${r.status}`);
  }

  console.log("\n== DETAIL TRX (dari id teratas) ==");
  if (h.rows.length) {
    const d = await akun.getHistoryDetail(h.rows[0].id);
    console.log(JSON.stringify(d, null, 2));
  }

  console.log("\n== MUTASI (3) ==");
  const m = await akun.getMutasi(3);
  console.log("status:", m.status);
  for (const r of m.rows) {
    console.log(`${r.tanggal} | ${r.jumlah} | saldo akhir ${r.saldoAkhir} | ${r.keterangan}`);
  }
})().catch((e) => {
  console.error("ERR", e);
  process.exit(1);
});
