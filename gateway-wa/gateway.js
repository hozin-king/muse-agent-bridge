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
const PAIRING_NUMBER = (process.env.PAIRING_NUMBER || '').replace(/\D/g, ''); // nomor bot kedua, tanpa +, contoh: 6281234567890. Kalau diisi, gateway memakai pairing code, bukan QR.
const POLL_SECONDS = Number(process.env.POLL_SECONDS || 60);
const SEEN_FILE = './seen.json';
const QUEUE_FILE = './queue.json';

function loadJson(path, fallback) { try { return JSON.parse(fs.readFileSync(path, 'utf8')); } catch { return fallback; } }
function saveJson(path, data) { fs.writeFileSync(path, JSON.stringify(data, null, 2)); }
let seen = loadJson(SEEN_FILE, {});
let queue = loadJson(QUEUE_FILE, []);
let sock = null;
let pluginCommands = []; // { trigger, description, plugin, handler }

// Plugin: file di ./plugins/*.js, masing-masing export default:
//   { name: 'namaplugin', commands: [{ trigger: 'ping', description: '...',
//       handler: async (ctx) => ctx.reply('pong') }] }
// ctx: { sock, jid, text, args, reply, bridge, sendSafe }
// Plugin hanya dipanggil untuk OWNER_JID (filter sudah di messages.upsert).
// Plugin yang gagal dimuat / salah format dilewati dengan peringatan, gateway tetap jalan.
async function loadPlugins() {
  pluginCommands = [];
  let dir;
  try { dir = fs.readdirSync('./plugins'); } catch { return; }
  for (const file of dir.filter(f => f.endsWith('.js')).sort()) {
    try {
      const mod = await import('./plugins/' + file);
      const plugin = mod.default || mod;
      if (!plugin || !Array.isArray(plugin.commands)) { console.log('Plugin dilewati (format salah): ' + file); continue; }
      for (const c of plugin.commands) {
        if (c && c.trigger && typeof c.handler === 'function') {
          pluginCommands.push({ trigger: String(c.trigger), description: c.description || '', plugin: plugin.name || file, handler: c.handler });
        }
      }
      console.log('Plugin dimuat: ' + (plugin.name || file) + ' (' + plugin.commands.map(c => c.trigger).join(', ') + ')');
    } catch (e) { console.log('Plugin gagal dimuat, dilewati: ' + file + ' — ' + e.message); }
  }
}

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
    let msg = 'Perintah Bridge:\n- bridge status\n- bridge tugas\n- bridge buat <judul>\n- bridge bantu';
    if (pluginCommands.length) msg += '\nPlugin:\n' + pluginCommands.map(c => `- ${c.trigger} — ${c.description}`).join('\n');
    await sendSafe(jid, msg);
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
  // Pesan lain dari owner: coba plugin dulu (trigger = kata pertama, mis. "ping").
  // Plugin tidak perlu prefix "bridge ". Kalau tidak ada plugin yang cocok, diam saja (hindari spam / loop).
  const firstWord = cmd.split(/\s+/)[0];
  const pluginCmd = pluginCommands.find(c => c.trigger === firstWord);
  if (pluginCmd) {
    try {
      await pluginCmd.handler({
        sock, jid, text: cmd, args: cmd.slice(firstWord.length).trim(),
        reply: (t) => sendSafe(jid, t), bridge, sendSafe,
      });
    } catch (e) { await sendSafe(jid, 'Plugin ' + pluginCmd.plugin + ' gagal: ' + e.message); }
    return;
  }
}
async function start() {
  await loadPlugins();
  if (!OWNER_JID) console.log('PERINGATAN: OWNER_JID kosong — gateway hanya akan pairing, tidak membalas siapa pun sampai .env diisi.');
  if (!TOKEN) console.log('PERINGATAN: GATEWAY_TOKEN kosong — perintah Bridge akan gagal sampai token agen gateway dibuat di Bridge dan diisi di .env.');
  const { state, saveCreds } = await useMultiFileAuthState('./auth');
  const { version } = await fetchLatestBaileysVersion();
  sock = makeWASocket({ version, auth: state, printQRInTerminal: false, logger: pino({ level: 'silent' }) });
  // Pairing code (alternatif QR): hanya saat belum terdaftar & PAIRING_NUMBER diisi.
  // Kode 8 karakter ini dimasukkan di WA nomor bot: Perangkat Tertaut > Tautkan dengan nomor telepon.
  if (PAIRING_NUMBER && !state.creds.registered) {
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(PAIRING_NUMBER);
        console.log('PAIRING CODE (masukkan di WhatsApp nomor bot, berlaku sebentar): ' + code);
      } catch (e) { console.log('Pairing code gagal, fallback ke QR:', e.message); }
    }, 3000);
  }
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
