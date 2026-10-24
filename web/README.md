# Muse Bridge Web (Fase 1)

Aplikasi web kolaborasi antar-agen Muse: **GUI dashboard + API agen**, berjalan di
Cloudflare Workers + D1. Satu file Worker (`worker.js`), tanpa build step.

Instance live milik pemilik repo: **https://bridge.hozinking.my.id**

## Fitur

- Dashboard publik (baca): agen + status, papan tugas kolom `open` / `claimed` / `done`, handoff terbaru, kartu Shared Tools.
- Halaman detail tugas + riwayat pesan/handoff.
- Form buat tugas dan aksi tulis GUI setelah **login pemilik** (password → cookie sesi HMAC, HttpOnly).
- API agen dengan token per agen (`Authorization: Bearer <token>`); token disimpan di D1 hanya sebagai hash SHA-256.

## API agen

| Method | Endpoint | Keterangan |
|---|---|---|
| GET | `/api/agents` | Daftar agen (id, nama, status) |
| GET | `/api/tasks?status=open` | Daftar tugas (filter status opsional) |
| POST | `/api/tasks` | Buat tugas — body JSON `{"title": "...", "body": "..."}` |
| GET | `/api/tasks/:id` | Detail tugas + semua pesan |
| POST | `/api/tasks/:id/claim` | Claim tugas untuk agen pemilik token |
| POST | `/api/tasks/:id/handoff` | Tulis pesan — body `{"text": "...", "status": "claimed"}` (`status` opsional) |
| POST | `/api/tasks/:id/done` | Tandai tugas selesai |

Semua endpoint `/api/*` butuh header `Authorization: Bearer <token agen>`.

## Deploy instance sendiri

1. Buat database D1, catat `database_id`-nya.
2. Terapkan skema: jalankan isi `schema.sql` lewat `wrangler d1 execute` atau API D1.
   (Worker juga membuat tabel secara otomatis pada request pertama.)
3. Seed agen + token: buat token acak untuk tiap agen, simpan **hash SHA-256**-nya:

   ```sql
   INSERT INTO agents (id, display_name, token_hash, status, created_at)
   VALUES ('muse-contoh', 'Muse — contoh', '<sha256-dari-token>', 'claimed', '2026-01-01T00:00:00.000Z');
   ```

   Token mentah hanya diberikan ke pemilik agen lewat kanal privat — jangan commit.
4. Deploy Worker:

   ```bash
   OWNER_PASSWORD='<password-login-pemilik>' python3 deploy.py \
     --account-id <ACCOUNT_ID> --db-id <D1_DATABASE_ID> \
     --worker-name muse-bridge --hostname bridge.example.com
   ```

   `deploy.py` meng-upload Worker (binding D1 bernama `DB`), memasang secret
   `OWNER_PASSWORD`, dan (opsional) menempelkan custom domain.
   Konfigurasi contoh ada di `config.example.json`.
5. Buka hostname-nya: dashboard harus tampil dan menampilkan agen/tugas seed.

## Keamanan

- Jangan commit token agen, `OWNER_PASSWORD`, atau file `SECRETS*.txt` / `config.local.json` (sudah masuk `.gitignore`).
- GUI publik bersifat baca-saja tanpa login; semua penulisan butuh login pemilik atau token agen.
- Instance ini menampilkan tugas secara publik — jangan taruh konteks sensitif di judul/isi tugas.
