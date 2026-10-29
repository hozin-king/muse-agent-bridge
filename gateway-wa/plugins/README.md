# Plugin Gateway WA

Cara menambah fitur tanpa mengubah `gateway.js`:

## Cara 1 — file lokal (Termux)

1. Salin `contoh.js` jadi nama baru, mis. `cuaca.js`.
2. Ubah `name`, `trigger` (kata pertama yang diketik owner), `description`,
   dan isi `handler`-nya. `handler` bisa pakai `ctx.reply(teks)`,
   `ctx.bridge('/api/tasks')` untuk baca Bridge, atau `ctx.args` untuk
   teks setelah trigger.
3. Restart gateway (`node gateway.js` lagi) atau kirim `plugin reload`.
   Plugin baru langsung muncul di daftar `bridge bantu`, tanpa edit file inti.

## Cara 2 — upload lewat WhatsApp (tanpa edit file di Termux)

Dari nomor owner atau nomor admin (`ADMIN_JIDS` di `.env`):

1. Kirim file `.js` sebagai **dokumen** ke nomor bot (bukan sebagai teks).
2. Gateway menyimpan file itu ke `plugins/`, memuat ulang tanpa restart,
   dan membalas sukses / gagal. Kalau format salah, file dihapus lagi
   dan gateway tetap jalan.
3. Kelola dari chat: `plugin list`, `plugin reload`, `plugin hapus <nama>`.

Aturan:
- Plugin hanya dipanggil untuk `OWNER_JID` + `ADMIN_JIDS`, sama seperti perintah inti.
- Nama file hanya boleh huruf, angka, `_`, `-`, dan harus `.js`; ukuran maks 100 KB.
- Satu plugin rusak tidak mematikan gateway: file itu dilewati dengan
  peringatan di log, plugin lain tetap jalan.
- **Peringatan keamanan:** kode plugin jalan dengan hak penuh proses Node
  (bisa baca file dan `.env`). Hanya upload plugin yang kamu tulis sendiri
  atau dari sumber yang kamu percayai penuh. Jangan upload plugin kiriman
  orang asing.
- Plugin buatanmu di Termux sifatnya lokal. Jangan taruh token, nomor
  pribadi, atau rahasia di file plugin kalau file itu mau di-push ke
  repo publik — simpan rahasia di `.env` dan baca lewat `process.env`.
