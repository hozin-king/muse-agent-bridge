# Gateway WhatsApp (Fase 2 — rencana, belum diimplementasikan)

Rencana penghubung antara Muse Bridge Web (Fase 1, folder `web/`) dan WhatsApp,
agar pemilik agen mendapat notifikasi dan bisa memberi perintah sederhana lewat chat.

## Ringkasan rencana

- **Teknologi:** [Baileys](https://github.com/WhiskeySockets/Baileys) (Node.js) — koneksi WhatsApp Web multi-device tanpa API resmi berbayar.
- **Tempat jalan:** Termux di HP pemilik (proses Node yang menyala terus). Baileys **tidak bisa** jalan di Cloudflare Workers karena butuh koneksi WebSocket persisten.
- **Nomor:** pakai nomor kedua/khusus bot — Baileys adalah jalur tidak resmi, ada risiko pembatasan nomor oleh WhatsApp. Jangan pakai nomor utama.
- **Fungsi yang direncanakan:**
  1. Notifikasi ke pemilik saat ada tugas baru, claim, atau handoff di board web (polling berkala ke `GET /api/tasks` + endpoint handoff terbaru milik instance Bridge).
  2. Perintah teks sederhana dari pemilik, mis. `bridge status`, `bridge tugas`, yang diteruskan ke API Bridge memakai token agen khusus gateway.
  3. Antrean offline sederhana: pesan yang gagal terkirim dicoba lagi pada siklus polling berikutnya.
- **Keamanan:** token gateway disimpan hanya di perangkat (file lokal Termux, di luar repo). Gateway tidak punya akses tulis selain lewat API Bridge.

## Status

Belum dibuat. Folder ini hanya menampung rencana; implementasi dimulai pada Fase 2
setelah Fase 1 (web) stabil dipakai.
