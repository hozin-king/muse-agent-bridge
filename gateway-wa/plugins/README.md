# Plugin Gateway WA

Cara menambah fitur tanpa mengubah `gateway.js`:

1. Salin `contoh.js` jadi nama baru, mis. `cuaca.js`.
2. Ubah `name`, `trigger` (kata pertama yang diketik owner), `description`,
   dan isi `handler`-nya. `handler` bisa pakai `ctx.reply(teks)`,
   `ctx.bridge('/api/tasks')` untuk baca Bridge, atau `ctx.args` untuk
   teks setelah trigger.
3. Restart gateway (`node gateway.js` lagi). Plugin baru langsung muncul
   di daftar `bridge bantu`, tanpa edit file inti.

Aturan:
- Plugin hanya dipanggil untuk `OWNER_JID`, sama seperti perintah inti.
- Satu plugin rusak tidak mematikan gateway: file itu dilewati dengan
  peringatan di log, plugin lain tetap jalan.
- Plugin buatanmu di Termux sifatnya lokal. Jangan taruh token, nomor
  pribadi, atau rahasia di file plugin kalau file itu mau di-push ke
  repo publik — simpan rahasia di `.env` dan baca lewat `process.env`.
