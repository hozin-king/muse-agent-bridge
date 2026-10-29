// Muse Bridge Web — WhatsApp gateway (Baileys, Fase 2).
// JALAN DI TERMUX HP PEMILIK, BUKAN di Cloudflare Workers (butuh WebSocket persisten).
// Jalur TIDAK RESMI: pakai nomor kedua/khusus bot, JANGAN nomor utama (risiko pembatasan WA).
// Fungsi: (1) notifikasi tugas Bridge baru ke owner, (2) perintah sederhana dari owner:
//   "bridge status" -> ringkasan tugas open/claimed/done
//   "bridge tugas"  -> daftar tugas open (maks 10)
//   "bridge buat <judul>" -> buat tugas di Bridge (butuh GATEWAY_TOKEN)
//   "bridge bantu"  -> daftar perintah
// Keamanan: hanya OWNER_JID yang dilayani. Pesan dari orang lain / grup diabaikan.
// Token & JID HANYA dari file .env lokal, TIDAK PERNAH di-commit (lihat .gitignore).
import makeWASocket, { DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import fs from 'node:fs';

const BRIDGE_URL = (process.env.BRIDGE_URL || 'https://bridge.hozinking.my.id').replace(/\/$/, '');
const TOKEN = process.env.GATEWAY_TOKEN || '';
const OWNER_JID = process.env.OWNER_JID || ''; // contoh: 6281234567890@s.whatsapp.net
const POLL_SECONDS = Number(process.env.POLL_SECONDS || 60);
const SEEN_FILE = './seen.json';
const QUEUE_FILE = './queue.json';

function loadJson(path, fallback) { try { return JSON.parse(fs.readFileSync(path, 'utf8')); } catch { return fallback; } }
function saveJson(path, data) { fs.writeFileSync(path, JSON.stringify(data, null, 2)); }
let seen = loadJson(SEEN_FILE, {});
let queue = loadJson(QUEUE_FILE, []);
let sock = null;

async function bridge(path, method = 'GET', body = null) {
  if (!TOKEN) throw new Error('GATEWAY_TOKEN belum di-set di .env');
  const res = await fetch(BRIDGE_URL + path, {
    method,
    headers: { 'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error('Bridge ' + res.status + ' ' + await res.text().then(t => t.slice(0, 200)));
  return res.json();
}
async function sendSafe(jid, text) {
  if (!sock) { queue.push({ jid, text, at: new Date().toISOString() }); saveJson(QUEUE_FILE, queue); return; }
  try { await sock.sendMessage(jid, { text }); }
  catch (e) { console.log('Kirim gagal, masuk antrean:', e.message); queue.push({ jid, text, at: new Date().toISOString() }); saveJson(QUEUE_FILE, queue); }
}
async function flushQueue() {
  if (!queue.length || !sock) return;
  const pending = queue; queue = [];
  for (const item of pending) { try { await sock.sendMessage(item.jid, { text: item.text }); } catch { queue.push(item); } }
  saveJson(QUEUE_FILE, queue);
}
async function pollTasks() {
  if (!OWNER_JID) return;
  try {
    const tasks = await bridge('/api/tasks?status=open');
    const list = Array.isArray(tasks) ? tasks : (tasks.tasks || []);
    const fresh = list.filter(t => !seen[t.id]);
    for (const t of fresh) {
      seen[t.id] = true;
      await sendSafe(OWNER_JID, `Bridge: tugas baru\n${t.title}\nID: ${t.id}`);
    }
    if (fresh.length) saveJson(SEEN_FILE, seen);
    await flushQueue();
  } catch (e) { console.log('Poll gagal (dicoba lagi siklus berikut):', e.message); }
}
async function handleOwnerText(jid, text) {
  const cmd = text.trim();
  if (cmd === 'bridge bantu' || cmd === 'bridge help') {
    await sendSafe(jid, 'Perintah Bridge:\n- bridge status\n- bridge tugas\n- bridge buat <judul>\n- bridge bantu');
    return;
  }
  if (cmd === 'bridge status') {
    try {
      const [open, claimed, done] = await Promise.all([
        bridge('/api/tasks?status=open'), bridge('/api/tasks?status=claimed'), bridge('/api/tasks?status=done'),
      ]);
      const n = x => Array.isArray(x) ? x.length : (x.tasks || []).length;
      await sendSafe(jid, `Bridge status: open ${n(open)}, claimed ${n(claimed)}, done ${n(done)}`);
    } catch (e) { await sendSafe(jid, 'Bridge status gagal: ' + e.message); }
    return;
  }
  if (cmd === 'bridge tugas') {
    try {
      const tasks = await bridge('/api/tasks?status=open');
      const list = Array.isArray(tasks) ? tasks : (tasks.tasks || []);
      if (!list.length) { await sendSafe(jid, 'Tidak ada tugas open.'); return; }
      await sendSafe(jid, 'Tugas open:\n' + list.slice(0, 10).map(t => `- ${t.title} (${t.id})`).join('\n'));
    } catch (e) { await sendSafe(jid, 'Gagal ambil tugas: ' + e.message); }
    return;
  }
  if (cmd.startsWith('bridge buat ')) {
    const title = cmd.slice('bridge buat '.length).trim();
    if (!title) { await sendSafe(jid, 'Judul kosong. Contoh: bridge buat Riset library X'); return; }
    try {
      const created = await bridge('/api/tasks', 'POST', { title, body: 'Dibuat lewat gateway WA.' });
      await sendSafe(jid, `Tugas dibuat: ${created.title || title} (${created.id || '?'})`);
    } catch (e) { await sendSafe(jid, 'Gagal buat tugas: ' + e.message); }
    return;
  }
  // Pesan lain dari owner: jangan dibalas otomatis (hindari spam / loop).
}
async function start() {
  if (!OWNER_JID) console.log('PERINGATAN: OWNER_JID kosong — gateway hanya akan pairing, tidak membalas siapa pun sampai .env diisi.');
  if (!TOKEN) console.log('PERINGATAN: GATEWAY_TOKEN kosong — perintah Bridge akan gagal sampai token agen gateway dibuat di Bridge dan diisi di .env.');
  const { state, saveCreds } = await useMultiFileAuthState('./auth');
  const { version } = await fetchLatestBaileysVersion();
  sock = makeWASocket({ version, auth: state, printQRInTerminal: false, logger: pino({ level: 'silent' }) });
  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', (u) => {
    const { connection, lastDisconnect, qr } = u;
    if (qr) { console.log('SCAN QR INI DENGAN WHATSAPP (Perangkat Tertaut) — pakai nomor kedua:'); qrcode.generate(qr, { small: true }); }
    if (connection === 'open') { console.log('Baileys tersambung.'); pollTasks(); setInterval(pollTasks, POLL_SECONDS * 1000); }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      console.log('Koneksi tertutup, kode:', code);
      if (code !== DisconnectReason.loggedOut) { console.log('Mencoba sambung ulang dalam 5 detik...'); setTimeout(start, 5000); }
      else console.log('Sesi logout — hapus folder ./auth lalu jalankan lagi untuk pairing baru.');
    }
  });
  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const m of messages) {
      if (m.key.fromMe || !m.message) continue;
      const jid = m.key.remoteJid || '';
      if (jid !== OWNER_JID) continue; // hanya owner, abaikan orang lain & grup
      const text = m.message.conversation || m.message.extendedTextMessage?.text || '';
      if (text.trim().startsWith('bridge ')) await handleOwnerText(jid, text);
    }
  });
}
start();
