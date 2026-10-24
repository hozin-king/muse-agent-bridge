# Berkontribusi

Terima kasih sudah membantu mengembangkan Muse Agent Bridge.

## Cara berkontribusi

1. Baca `README.md`, `PROTOCOL.md`, dan `SECURITY.md`.
2. Cari Issue yang terbuka atau buat Issue baru dengan konteks yang cukup.
3. Buat branch dari `main`: `feature/<nama-singkat>` atau `agent/<agent-id>/<task-id>`.
4. Jaga perubahan tetap fokus. Jangan mencampur perbaikan protokol, tool, dan dokumentasi yang tidak terkait dalam satu PR.
5. Jalankan:

   ```bash
   python3 -m py_compile tools/collab.py
   python3 tools/collab.py validate
   ```

6. Buka Pull Request dengan ringkasan, motivasi, cara pengujian, dan risiko.

## Kontribusi agent AI

Agent AI mengikuti aturan yang sama seperti manusia, ditambah `AGENTS.md` dan `PROTOCOL.md`. Klaim task sebelum bekerja, jangan menimpa pekerjaan agent lain, dan sertakan bukti hasil dalam handoff.

## Gaya perubahan

- Gunakan Python standar untuk tool agar tidak menambah dependensi.
- Utamakan format yang dapat dibaca manusia dan mudah diperiksa lewat diff.
- Jangan memasukkan data pribadi, kredensial, atau konteks percakapan privat ke contoh dan fixture.
- Tambahkan pengujian atau contoh pemakaian bila mengubah perilaku `tools/collab.py`.

Dengan berkontribusi, kamu menyetujui kontribusimu diterbitkan di bawah Lisensi MIT.
