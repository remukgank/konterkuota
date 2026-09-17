# Arsitektur Bot KonterKuota

Bot Telegram ini berinteraksi langsung dengan situs konter (via HTTP)
tanpa API khusus. Semua komunikasi meniru perilaku situs (fetch HTML + POST form).

## Alur umum

```
Telegram (pengguna)
   │  (polling grammY)
   ▼
src/index.js  ── perintah/menu interaktif ──►  src/order.js  /  src/akun.js  /  src/harga.js
                                                        │
                                                        ▼
                                               src/konterApi.js  (client HTTP dengan cookie)
                                                        │
                                                        ▼
                                              situs konter (HTTPS)
```

## Struktur folder

| File | Peran |
|---|---|
| `src/index.js` | Entry point; daftarkan semua handler perintah & alur interaktif order |
| `src/config.js` | Baca konfigurasi dari env / `.env` / Replit Secrets |
| `src/konterApi.js` | Client HTTP: request dengan cookie, refresh `csrf_cookie` dari `Set-Cookie`, ambil buffer (captcha) |
| `src/harga.js` | Baca katalog harga (public) & cari produk (tanpa login) |
| `src/akun.js` | Profil/saldo, riwayat transaksi, detail trx, mutasi saldo (butuh login) |
| `src/order.js` | Config order (kategori/operator/voucher/pembayaran) & submit order |
| `bot/telegram.js` | Wrapper `grammY` (adapter) + whitelist chat id |
| `scripts/test-*.js` | Skrip uji parsers/endpoint (tanpa Telegram) |
| `docs/*.md` | Dokumentasi |

## Endpoint yang dipakai (hasil analisa & verifikasi)

| Fungsi | Method & Path | Butuh login | Data dikirim |
|---|---|---|---|
| Katalog harga & produk | `GET /` | Tidak | — |
| Cek profil & saldo | `GET /akun/profil` | Ya | — |
| Riwayat transaksi | `GET /history` | Ya | — |
| Detail transaksi | `GET /history/view/{id}` | Ya | — |
| Mutasi saldo | `GET /akun/riwayat-saldo` | Ya | — |
| Gambar captcha | `GET /captcha?r={ts}` | Ya (per-session) | — |
| **Submit order** | `POST /{kategori}` | Ya | `csrf_token, operator, voucher, nomor_hp|id_plgn|barcode_voucher, pembayaran, captcha, json_format=1` |

## Kategori produk & field yang dibutuhkan

| Kategori | Endpoint | Field |
|---|---|---|
| `pulsa`, `kuota_*`, `nelpon_sms`, `voucher_*`, `indosat_gift`, `telkomsel_combo_sakti`, `paket_internet`, `dompet_digital`, `telkomsel_bulk` | `/pulsa`, dll | `nomor_hp` |
| `game`, `token_pln`, `pdam`, `tagihan`, `indosat_only4u`, `tv_prabayar`, `pbb` | sesuai kategori | `id_plgn` |
| `aktivasi_voucher` | `/aktivasi_voucher` | `barcode_voucher` + `nomor_hp` |

## Mekanisme CSRF & cookie

- Server (CodeIgniter) memakai CSRF: cookie `csrf_cookie` harus bernilai sama dengan
  field form `csrf_token`.
- `konterApi` selalu menyimpan cookie dari `Set-Cookie`, sehingga setelah satu kali
  `GET /`, cookie `csrf_cookie` dan token form tersinkron.
- Sebelum submit order, bot melakukan `GET /` segar untuk mengambil `csrf_token` yang
  cocok dengan cookie terbaru, lalu memakainya.

## Catatan penting order

- Setiap transaksi mewajibkan **captcha** yang dibangkitkan per-session. Bot mengunduh
  gambar captcha **dengan cookie yang sama** (`getBuffer`) lalu mengirim buffer-nya ke
  Telegram sebagai photo. User mengetik kode, bot submit dengan cookie yang sama.
  Ini penting: jika dikirim sebagai URL telanjang ke Telegram, Telegram men-download
  tanpa cookie sehingga captcha tidak cocok dengan session order.
- Pembayaran yang dipakai bot: **Saldo Akun** (`balance`) dan **QRIS** (`qris_livin_nt`).

## Keamanan

- Kredensial (cookie session) disimpan di `.env` / Replit Secrets, **tidak pernah di-commit**.
- Perintah sensitif (`/saldo`, `/riwayat`, `/mutasi`, `/order`) hanya jalan untuk
  `ALLOWED_CHAT_IDS`. Perintah `/harga` (read-only) bebas.
- Cookie session bisa kedaluwarsa; jika gagal, perbarui `KONTER_COOKIE` dari browser.
