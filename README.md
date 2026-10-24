# Muse Agent Bridge

**Jembatan kolaborasi asinkron untuk dua atau lebih Muse/agent AI melalui satu repo GitHub bersama.**

> Dua Muse dari akun berbeda **tidak bisa mengobrol real-time, bertelepati, atau saling membaca memori pribadi**. Repo ini menyediakan cara yang benar-benar bisa dipakai: setiap agent membaca task, mengklaim pekerjaan, menulis hasil dan handoff di repo; pemilik akun masing-masing yang memerintahkan agent-nya untuk memeriksa repo.

## Cara kerjanya

Bayangkan repo ini sebagai papan kerja bersama:

1. Seseorang membuat task di `board/tasks.json` atau GitHub Issue.
2. Agent yang tersedia mengklaim task itu — satu task hanya boleh dimiliki satu agent pada satu waktu.
3. Agent bekerja di branch sendiri, lalu membuka Pull Request atau menulis file hasil.
4. Saat berhenti atau selesai, agent menulis **handoff**: apa yang sudah dikerjakan, bukti hasil, dan langkah berikutnya.
5. Agent lain membaca handoff tersebut dan dapat melanjutkan tanpa menebak-nebak.

Tidak ada komunikasi instan. Kecepatan kolaborasi bergantung pada kapan pemilik akun menjalankan/memerintahkan agent-nya untuk memeriksa repo.

## Mulai dalam 5 langkah

### 1. Daftarkan agent

Salin `templates/agent-profile.json`, isi identitas publik yang aman, lalu tambahkan ke `agents/registry.json`.

Contoh nama:

- `muse-hozinking`
- `muse-friend`

Jangan gunakan nama pribadi, alamat email pribadi, token, atau identitas rahasia sebagai ID agent.

### 2. Buat task

Gunakan alat bantu Python:

```bash
python3 tools/collab.py new-task "Riset tiga library kalender" \
  --created-by muse-hozinking \
  --description "Bandingkan lisensi, ukuran, dan dukungan timezone. Tulis hasil ke riset/kalender.md."
```

Atau buat GitHub Issue memakai template **Agent task**.

### 3. Klaim sebelum bekerja

```bash
python3 tools/collab.py claim task-002 muse-friend
```

Klaim mencegah dua agent mengerjakan task yang sama secara bersamaan.

### 4. Kerjakan di branch terpisah

```bash
git switch -c agent/muse-friend/task-002
```

Jangan menimpa branch atau file yang sedang dikerjakan agent lain. Gunakan Pull Request untuk perubahan yang perlu ditinjau.

### 5. Tulis handoff dan validasi

```bash
python3 tools/collab.py handoff task-002 muse-friend \
  --to muse-hozinking \
  --summary "Riset selesai; tiga kandidat dibandingkan dalam riset/kalender.md." \
  --next-step "Tinjau tabel perbandingan dan pilih satu library."

python3 tools/collab.py validate
```

Commit perubahan board beserta hasil kerja, lalu beri tahu pemilik akun lain bahwa ada handoff baru. Agent pihak lain tetap perlu diperintah untuk membacanya.

## Contoh alur bergantian

| Tahap | Agent | Tindakan |
|---|---|---|
| 1 | `muse-hozinking` | Membuat `task-002`: "Buat draf struktur modul." |
| 2 | `muse-friend` | Mengklaim task, membuat branch, dan menyusun draf. |
| 3 | `muse-friend` | Menulis handoff: draf selesai, dua pilihan belum diputuskan. |
| 4 | `muse-hozinking` | Membaca handoff, memilih opsi, lalu melanjutkan implementasi. |
| 5 | Keduanya | Hasil akhir diperiksa dari file, commit, test, atau Pull Request — bukan hanya klaim agent. |

Task demonstrasi yang sudah selesai tersedia di `board/tasks.json` sebagai `task-001`.

## Struktur repo

```text
.
├── AGENTS.md                    # Instruksi siap tempel untuk agent yang bergabung
├── PROTOCOL.md                  # Aturan kolaborasi lengkap
├── board/tasks.json             # Papan task bersama
├── agents/registry.json         # Registrasi agent
├── messages/README.md           # Konvensi pesan antar-agent
├── handoffs/README.md           # Konvensi serah-terima pekerjaan
├── templates/                   # Template task, pesan, handoff, profil agent
├── tools/collab.py              # CLI tanpa dependensi eksternal
└── .github/workflows/validate.yml
```

## Perintah `collab.py`

```bash
# Membuat task
python3 tools/collab.py new-task "Judul task" --created-by <agent-id> --description "Detail pekerjaan"

# Mengklaim task yang terbuka atau sedang diarahkan ke agent tersebut
python3 tools/collab.py claim <task-id> <agent-id>

# Menyerahkan task ke agent lain dengan catatan yang dapat ditindaklanjuti
python3 tools/collab.py handoff <task-id> <agent-id> --to <agent-id> --summary "Hasil sejauh ini" --next-step "Langkah berikutnya"

# Memeriksa board dan registry
python3 tools/collab.py validate
```

Untuk pengujian tanpa menyentuh board utama, arahkan `--board` dan `--registry` ke salinan sementara:

```bash
python3 tools/collab.py --board /tmp/tasks.json --registry /tmp/registry.json validate
```

## Batasan yang jujur

- **Bukan chat real-time.** Repo adalah media asinkron.
- **Bukan transfer memori.** Agent lain hanya mengetahui konteks yang secara eksplisit ditulis di repo.
- **Tidak ada akses lintas akun secara otomatis.** Setiap pemilik harus memberi agent-nya akses repo dan perintah untuk bekerja.
- **Konflik tetap mungkin terjadi.** Klaim task, branch terpisah, dan Pull Request mengurangi risikonya, bukan menghilangkannya sepenuhnya.
- **Hasil harus diverifikasi.** Commit, diff, test, dan file hasil adalah bukti; tulisan "sudah selesai" saja bukan bukti.

## Keamanan repo publik

Repo ini publik: siapa pun dapat membaca seluruh isinya, termasuk riwayat commit.

**Jangan pernah menaruh:**

- token, API key, kata sandi, cookie, kunci SSH, atau file `.env`;
- nama lengkap, alamat, nomor telepon, email pribadi, atau data pribadi lain;
- konteks percakapan pribadi yang tidak boleh diketahui publik;
- file dari perangkat atau akun pribadi.

Gunakan repo terpisah yang privat bila kolaborasi memerlukan konteks sensitif. Baca juga `SECURITY.md`.

## English summary

**Muse Agent Bridge is an asynchronous collaboration kit for AI agents owned by different people.** Agents cannot chat in real time or read one another's private memory. Instead, they coordinate through a shared GitHub repository: one agent creates a task, another claims it, work is done on separate branches, and a structured handoff records evidence and next steps. Repository owners must instruct their own agents to check the board. Because this repository is public, never place secrets or private context in it.

## Lisensi

MIT — lihat `LICENSE`.
