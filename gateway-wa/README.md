# Gateway WhatsApp (Fase 2 — terimplementasi, pairing menunggu pemilik)

Penghubung antara Muse Bridge Web (Fase 1, folder `web/`) dan WhatsApp,
agar pemilik agen mendapat notifikasi dan bisa memberi perintah sederhana lewat chat.

> **Batasan jujur:** gateway ini BUKAN chat utama dengan Muse. Ia adalah bot
> Bridge: notifikasi tugas + perintah `bridge ...` ke papan Bridge. Chat
> dengan Muse utama lewat WhatsApp tetap lewat sambungan resmi Muse
> (side chat WhatsApp di aplikasi Muse), bukan lewat Baileys ini.

## Ringkasan

- **Teknologi:** [Baileys](https://github.com/WhiskeySockets/Baileys) (Node.js) — koneksi WhatsApp Web multi-device tanpa API resmi berbayar.
- **Tempat jalan:** Termux di HP pemilik (proses Node yang menyala terus). Baileys **tidak bisa** jalan di Cloudflare Workers karena butuh koneksi WebSocket persisten.
- **Nomor:** pakai nomor kedua/khusus bot — Baileys adalah jalur tidak resmi, ada risiko pembatasan nomor oleh WhatsApp. Jangan pakai nomor utama.
- **Keamanan (repo publik):** JANGAN commit token, JID pribadi, atau folder `./auth`. Semua rahasia hanya di `.env` lokal Termux (sudah di `.gitignore` via `.env*`). Gateway hanya membalas `OWNER_JID`; pesan orang lain dan grup diabaikan.

## Fungsi (file `gateway.js`)

1. Notifikasi ke pemilik saat ada tugas baru di board web (polling berkala ke `GET /api/tasks?status=open`, ID yang sudah diberitahu dicatat di `seen.json`).
2. Perintah teks dari pemilik (hanya dari `OWNER_JID`):
   - `bridge status` — ringkasan open/claimed/done
   - `bridge tugas` — daftar tugas open (maks 10)
   - `bridge buat <judul>` — buat tugas di Bridge (butuh `GATEWAY_TOKEN`)
   - `bridge bantu` — daftar perintah
3. Antrean offline sederhana: pesan yang gagal terkirim masuk `queue.json`, dicoba lagi pada siklus polling berikutnya.

## Cara pakai di Termux

```bash
# 1. Di Bridge web, buat agen gateway dan salin token-nya (token mentah, jangan dibagikan)
# 2. Di Termux:
pkg install nodejs -y
cd gateway-wa
cp .env.example .env
# isi .env: BRIDGE_URL, GATEWAY_TOKEN, OWNER_JID (format 628xx@s.whatsapp.net), POLL_SECONDS
npm install
node gateway.js
# 3a. Cara QR: scan QR yang muncul di terminal dengan WhatsApp nomor kedua:
#     WhatsApp > Perangkat Tertaut > Tautkan Perangkat
# 3b. Cara pairing code (alternatif QR, tanpa scan kamera):
#     isi PAIRING_NUMBER di .env dengan nomor bot kedua (tanpa +),
#     jalankan node gateway.js, salin kode 8 karakter yang muncul di terminal,
#     lalu di WA nomor bot: Perangkat Tertaut > Tautkan dengan nomor telepon > masukkan kode itu.
#     Kode berlaku sebentar — kalau kedaluwarsa, jalankan ulang gateway untuk kode baru.
# 4. Dari nomor owner, kirim: bridge bantu
```

Sesi login tersimpan di folder `./auth` (jangan dibagikan / di-commit).
Kalau sesi logout, hapus `./auth` lalu jalankan lagi untuk pairing baru.

## Status

- Kode gateway: `gateway.js`, `package.json`, `.env.example` — terimplementasi 29 Okt 2026.
- Uji di VM: `node --check gateway.js` lolos; start gateway jalan dan loop
  reconnect bekerja (kode 408, tanpa crash setelah perbaikan logger pino).
  QR tidak muncul di VM karena koneksi WebSocket langsung ke WhatsApp
  terhalang proxy egress VM — QR diharapkan muncul saat dijalankan di
  Termux HP dengan internet langsung, dan pairing wajib di-scan dari HP pemilik.
- Pairing nomor kedua + token gateway: menunggu pemilik (langkah di atas).
