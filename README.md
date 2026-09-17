# KonterKuota Bot 🛒

Bot Telegram untuk [konterkuota.com](https://konterkuota.com) — cek harga, saldo,
riwayat transaksi, mutasi, dan melakukan **order pulsa/kuota/game/token PLN/PPOB**
langsung dari chat Telegram.

Bot berinteraksi langsung dengan situs (fetch HTML + POST form) memakai cookie
session akun Anda — tanpa API khusus dari penyedia.

> **Peringatan:** nilai `KONTER_COOKIE` adalah akses penuh ke akun konter Anda.
> Simpan hanya di env/secrets, jangan pernah di-commit ke repository.

---

## Fitur

- **🔍 Cari Harga** — cari produk & harga kapan saja (tanpa login), langsung bisa order.
- **🛒 Order interaktif** — alur kategori → provider → paket → nomor → bayar → captcha.
  Pembayaran: **Saldo Akun** dan **QRIS** (QR + polling status + konfirmasi pembayaran).
- **💰 Saldo & Profil** — cek saldo dan info akun *(khusus admin)*.
- **📋 Riwayat Transaksi** — tabel native (rich message Telegram); ada tombol
  **Kirim QR** (order pending) dan **Detail** per transaksi.
- **🧾 Mutasi Saldo** — mutasi masuk/keluar *(khusus admin)*.
- **🗂 Ledger per-user** — catat order per chat id; admin bisa lihat semua user.
- **🖼️ Kirim QR** — `/kirimqr {id}` atau tombol, QR di-upscale 640×640 agar mudah discan.
- **Tabel rich message native** — riwayat & detail tampil sebagai tabel asli Telegram
  (Bot API 10.1+), dengan fallback teks bila tidak didukung.

## Perintah

| Perintah | Fungsi | Butuh login | Akses |
|---|---|---|---|
| `/start` `/help` | Bantuan + menu utama + reply keyboard | Tidak | Semua |
| `/menu` | Tampilkan menu utama | Tidak | Semua |
| `/harga <kata>` `/cari <kata>` | Cari produk & harga, langsung order | Tidak | Semua |
| `/saldo` `/profil` | Cek saldo & info akun | Ya | Admin |
| `/riwayat [n]` | Riwayat transaksi (tabel, default 5, maks 10) | Ya | Semua |
| `/mutasi [n]` | Mutasi saldo | Ya | Admin |
| `/order` | Transaksi interaktif | Ya | Semua |
| `/batal` | Batalkan proses order yang berjalan | — | Semua |
| `/kirimqr {id}` | Kirim ulang QR pembayaran | Ya | Admin |

> **Admin** = chat id yang terdaftar di `ALLOWED_CHAT_IDS`.

## Menu & tombol

- **Reply keyboard** muncul setelah `/start`: `🔍 Cari Harga`, `💰 Saldo Akun`,
  `📋 Riwayat`, `🧾 Mutasi`, `🛒 Order`, `❓ Bantuan`.
- **Menu inline**: Cari Harga, Saldo, Riwayat, Mutasi, Order, Bantuan — plus tombol
  `🖼️ Kirim QR #trx` & `👁 Detail #trx` pada riwayat, dan `✅ Konfirmasi Pembayaran`
  pada pesan QR.

## Kecepatan mulai (setup)

1. **Token bot**: buat via [@BotFather](https://t.me/BotFather) → `/newbot`.
2. **Cookie session**: login ke konterkuota.com di browser → DevTools (F12) →
   Network → salin header **Cookie** (berisi `save_browser`, `user_id`, `user_key`,
   `csrf_cookie`, `sid`).
3. **Konfigurasi**: isi `TELEGRAM_BOT_TOKEN`, `KONTER_COOKIE`, `ALLOWED_CHAT_IDS`
   di Replit Secrets atau file `.env` (salin dari `.env.example`).
4. **Install & jalankan**:

```bash
npm install            # kalau registry default diblokir:
# npm install --registry=https://registry.npmjs.org
npm start
```

Detail lengkap: [docs/setup.md](docs/setup.md).

## Variabel environment

| Variabel | Wajib | Deskripsi |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Ya | Token bot dari @BotFather |
| `KONTER_COOKIE` | Ya | Cookie session konterkuota (login browser) |
| `ALLOWED_CHAT_IDS` | Tidak | Daftar chat id admin, pisahkan koma. Kosong = semua boleh (tidak disarankan) |
| `KONTER_BASE_URL` | Tidak | URL situs, default `https://konterkuota.com` |

## Struktur proyek

| File | Peran |
|---|---|
| `src/index.js` | Entry point; handler perintah & alur order interaktif |
| `src/config.js` | Baca konfigurasi dari env/`.env`/Replit Secrets |
| `src/konterApi.js` | Client HTTP: request dengan cookie, refresh CSRF, ambil buffer |
| `src/harga.js` | Katalog harga (public) & pencarian produk |
| `src/akun.js` | Profil/saldo, riwayat transaksi, detail trx, mutasi, QR pembayaran |
| `src/order.js` | Config order (kategori/operator/voucher/pembayaran) & submit |
| `src/ledger.js` | Ledger per-user transaksi (`data/transaksi.json`) |
| `bot/telegram.js` | Wrapper grammY (adapter) + whitelist chat id + rich message |
| `scripts/test-*.js` | Skrip uji parser/endpoint (tanpa Telegram) |
| `docs/*.md` | Dokumentasi |

## Cara kerja (ringkas)

```
Telegram (pengguna)
   │  polling grammY
   ▼
src/index.js → src/{order,akun,harga}.js
                        │
                        ▼
               src/konterApi.js (HTTP + cookie + CSRF)
                        │
                        ▼
              konterkuota.com (HTTPS)
```

- Order mewajibkan **captcha** per-session; bot mengunduh gambar captcha memakai
  cookie yang sama lalu mengirim buffer-nya ke Telegram (bukan URL telanjang).
- Pembayaran memakai **Saldo Akun** (`balance`) dan **QRIS** (`qris_livin_nt`).
- Endpoint yang dipakai dan detail kategori: [docs/architecture.md](docs/architecture.md).

## Uji tanpa Telegram (opsional)

```bash
node scripts/test-harga.js "axis 5"      # cari produk (tanpa login)
node scripts/test-akun.js                # profil, riwayat, mutasi (butuh cookie)
node scripts/test-order.js               # config order + captcha (butuh cookie)
```

> Skrip uji order TIDAK melakukan transaksi sungguhan.

## Keamanan

- Kredensial hanya di `.env` / Replit Secrets — `.env` & `data/` masuk `.gitignore`.
- Perintah sensitif dibatasi `ALLOWED_CHAT_IDS`; `/harga` (read-only) bebas.
- Cookie bisa kedaluwarsa → perbarui `KONTER_COOKIE` dari browser.
- Setelah bot stabil, disarankan logout & login ulang konterkuota lalu ganti cookie
  (batch session yang mungkin bocor di chat).

## Dokumentasi lain

- [Setup lengkap](docs/setup.md)
- [Penggunaan](docs/usage.md)
- [Arsitektur & endpoint](docs/architecture.md)