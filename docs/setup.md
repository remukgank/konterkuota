# Setup Bot KonterKuota

## 1. Persiapkan token bot Telegram

1. Buka [@BotFather](https://t.me/BotFather) di Telegram.
2. Kirim `/newbot`, ikuti petunjuk untuk membuat bot baru.
3. Salin **token** (format `123456:ABC-DEF...`).

## 2. Persiapkan cookie session konterkuota

Cookie ini memberi akses atas nama akun Anda, jadi jaga kerahasiaannya.

1. Login ke situs konter lewat browser.
2. Buka DevTools (F12) → tab **Network** → muat ulang halaman.
3. Klik request ke situs → buka **Headers** → salin seluruh nilai header **Cookie**.
   Contoh:
   ```
   save_browser=xxx; user_id=xxx; user_key=xxx; csrf_cookie=xxx; sid=xxx
   ```

## 3. Atur konfigurasi

Ada dua cara:

### a) Menggunakan Replit Secrets (disarankan di Replit)
Buka tab **Secrets** di Replit, tambahkan:
- `TELEGRAM_BOT_TOKEN` = token bot
- `KONTER_COOKIE` = cookie session
- `ALLOWED_CHAT_IDS` = chat id Anda (opsional, lihat bawah)

### b) Menggunakan file `.env`
Salin `.env.example` menjadi `.env`, lalu isi nilainya:
```
TELEGRAM_BOT_TOKEN=123456:ABC...
KONTER_COOKIE=save_browser=...; user_id=...; user_key=...; csrf_cookie=...; sid=...
ALLOWED_CHAT_IDS=
KONTER_BASE_URL=
```
> `.env` masuk `.gitignore` — pastikan tidak ter-commit / ter-upload publik.

## 4. Ambil chat id Anda (untuk ALLOWED_CHAT_IDS)

Chat `@userinfobot` di Telegram, atau start bot lalu lihat `msg.chat.id` di log.
Isi `ALLOWED_CHAT_IDS` dengan angka tersebut. Jika MULTIPLE, pisahkan dengan koma.
Kosongkan `ALLOWED_CHAT_IDS` = semua pengguna boleh (tidak disarankan untuk order).

## 5. Install dependency & jalankan

```bash
cd konter-bot
npm install
npm start
```

> Catatan: bila registry default diblokir (mis. di sandbox), pakai:
> `npm install --registry=https://registry.npmjs.org`

Bot akan mulai polling perintah Telegram. Di Replit, pastikan proses tetap hidup
(Always On / uptime monitor).

## 6. Uji parser / endpoint tanpa Telegram (opsional)

```bash
node scripts/test-harga.js "axis 5"   # cari produk (tanpa login)
node scripts/test-akun.js             # profil, riwayat, mutasi (butuh cookie)
node scripts/test-order.js            # config order + captcha (butuh cookie)
```

> Skrip uji order TIDAK melakukan transaksi sungguhan — hanya memuat config & captcha.

## Keamanan setelah selesai

Karena cookie pernah dibagikan di chat, disarankan **logout & login ulang**
konterkuota setelah bot stabil, lalu perbarui `KONTER_COOKIE` — supaya session lama
yang mungkin bocor tidak lagi valid.
