// Muse Bridge Web — WhatsApp gateway (Baileys, Fase 2).
// JALAN DI TERMUX HP PEMILIK, BUKAN di Cloudflare Workers (butuh WebSocket persisten).
// Jalur TIDAK RESMI: pakai nomor kedua/khusus bot, JANGAN nomor utama (risiko pembatasan WA).
// Fungsi: (1) notifikasi tugas Bridge baru ke owner, (2) perintah sederhana dari owner:
//   "bridge status" -> ringkasan tugas open/claimed/done
//   "bridge tugas"  -> daftar tugas open (maks 10)
//   "bridge buat <judul>" -> buat tugas di Bridge (butuh GATEWAY_TOKEN)
//   "bridge bantu"  -> daftar perintah
// Keamanan: hanya OWNER_JID + ADMIN_JIDS yang dilayani. Pesan dari orang lain / grup diabaikan.
// PERINGATAN PLUGIN: kode plugin jalan dengan hak penuh proses Node (bisa baca file & .env).
// Hanya upload plugin yang kamu tulis sendiri / dari sumber yang kamu percayai penuh.
// Jangan pernah upload plugin kiriman orang asing, meski dikirim ke nomor owner sekalipun.
// Token & JID HANYA dari file .env lokal, TIDAK PERNAH di-commit (lihat .gitignore).
import makeWASocket, { DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion, downloadMediaMessage } from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import fs from 'node:fs';

const BRIDGE_URL = (process.env.BRIDGE_URL || 'https://bridge.hozinking.my.id').replace(/\/$/, '');
const TOKEN = process.env.GATEWAY_TOKEN || '';
const OWNER_JID = process.env.OWNER_JID || ''; // contoh: 6281234567890@s.whatsapp.net
const ADMIN_JIDS = (process.env.ADMIN_JIDS || '').split(',').map(s => s.trim()).filter(Boolean);
const isAuthorized = (jid) => jid === OWNER_JID || ADMIN_JIDS.includes(jid);
const MAX_PLUGIN_BYTES = 100 * 1024;
function safePluginName(raw) {
  const base = String(raw || '').split('/').pop().split('\\').pop();
  if (!/^[A-Za-z0-9_-]+\.js$/.test(base)) return null;
  return base;
}
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
let pluginFiles = new Set(); // file .js yang berhasil dimuat (punya minimal 1 perintah valid)

// Plugin: file di ./plugins/*.js, masing-masing export default:
//   { name: 'namaplugin', commands: [{ trigger: 'ping', description: '...',
//       handler: async (ctx) => ctx.reply('pong') }] }
// ctx: { sock, jid, text, args, reply, bridge, sendSafe }
// Plugin hanya dipanggil untuk OWNER_JID (filter sudah di messages.upsert).
// Plugin yang gagal dimuat / salah format dilewati dengan peringatan, gateway tetap jalan.
async function loadPlugins() {
  pluginCommands = [];
  pluginFiles = new Set();
  let dir;
  try { dir = fs.readdirSync('./plugins'); } catch { return; }
  for (const file of dir.filter(f => f.endsWith('.js')).sort()) {
    try {
      // ?t= memaksa import ulang (bypass cache) agar upload / reload plugin langsung pakai kode baru.
      const mod = await import('./plugins/' + file + '?t=' + Date.now());
      const plugin = mod.default || mod;
      if (!plugin || !Array.isArray(plugin.commands)) { console.log('Plugin dilewati (format salah): ' + file); continue; }
      for (const c of plugin.commands) {
        if (c && c.trigger && typeof c.handler === 'function') {
          pluginCommands.push({ trigger: String(c.trigger), description: c.description || '', plugin: plugin.name || file, handler: c.handler });
        }
      }
      if (plugin.commands.some(c => c && c.trigger && typeof c.handler === 'function')) pluginFiles.add(file);
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
// Upload plugin lewat WA: kirim file .js sebagai dokumen dari OWNER_JID / ADMIN_JIDS.
// File disimpan ke ./plugins/, lalu dimuat ulang tanpa restart. Kalau format salah,
// file dihapus lagi dan pengirim diberitahu — gateway tidak crash.
async function handlePluginUpload(jid, m) {
  const doc = m.message.documentMessage;
  const name = safePluginName(doc.fileName);
  if (!name) { await sendSafe(jid, 'Upload ditolak: file harus .js dengan nama aman (huruf, angka, _ , -).'); return; }
  if (doc.fileLength && Number(doc.fileLength) > MAX_PLUGIN_BYTES) { await sendSafe(jid, 'Upload ditolak: plugin maks 100 KB.'); return; }
  try {
    const buf = await downloadMediaMessage(m, 'buffer', {}, { logger: pino({ level: 'silent' }) });
    const code = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf || '');
    if (!code.trim() || Buffer.byteLength(code) > MAX_PLUGIN_BYTES) throw new Error('isi file kosong / terlalu besar');
    fs.mkdirSync('./plugins', { recursive: true });
    fs.writeFileSync('./plugins/' + name, code);
    await loadPlugins();
    if (!pluginFiles.has(name)) {
      try { fs.unlinkSync('./plugins/' + name); } catch {}
      await loadPlugins();
      await sendSafe(jid, 'Plugin gagal dimuat (format salah, file dihapus lagi): ' + name + '\nFormat benar: export default { name, commands: [{ trigger, description, handler }] }');
      return;
    }
    await sendSafe(jid, 'Plugin terpasang: ' + name + '\nPerintah aktif sekarang: ' + pluginCommands.map(c => c.trigger).join(', '));
  } catch (e) {
    try { fs.unlinkSync('./plugins/' + name); } catch {}
    await sendSafe(jid, 'Upload plugin gagal: ' + e.message);
  }
}
async function handleOwnerText(jid, text) {
  const cmd = text.trim();
  if (cmd === 'bridge bantu' || cmd === 'bridge help') {
    let msg = 'Perintah Bridge:\n- bridge status\n- bridge tugas\n- bridge buat <judul>\n- bridge bantu';
    msg += '\nPlugin:\n- plugin list\n- plugin reload\n- plugin hapus <nama>\n- kirim file .js sebagai dokumen untuk upload plugin baru';
    if (pluginCommands.length) msg += '\nPerintah plugin:\n' + pluginCommands.map(c => `- ${c.trigger} — ${c.description}`).join('\n');
    await sendSafe(jid, msg);
    return;
  }
  if (cmd === 'plugin list') {
    const files = (() => { try { return fs.readdirSync('./plugins').filter(f => f.endsWith('.js')).sort(); } catch { return []; } })();
    await sendSafe(jid, files.length ? 'Plugin terpasang:\n' + files.join('\n') : 'Belum ada plugin.');
    return;
  }
  if (cmd === 'plugin reload') {
    await loadPlugins();
    await sendSafe(jid, 'Plugin dimuat ulang: ' + (pluginCommands.length ? pluginCommands.map(c => c.trigger).join(', ') : '(tidak ada perintah)'));
    return;
  }
  if (cmd.startsWith('plugin hapus ')) {
    const name = safePluginName(cmd.slice('plugin hapus '.length).trim() + (cmd.slice('plugin hapus '.length).trim().endsWith('.js') ? '' : '.js'));
    if (!name) { await sendSafe(jid, 'Nama plugin tidak valid. Contoh: plugin hapus cuaca'); return; }
    try { fs.unlinkSync('./plugins/' + name); await loadPlugins(); await sendSafe(jid, 'Plugin dihapus: ' + name); }
    catch { await sendSafe(jid, 'Plugin tidak ditemukan: ' + name); }
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
      if (!isAuthorized(jid)) continue; // hanya owner + admin, abaikan orang lain & grup
      if (m.message.documentMessage) { await handlePluginUpload(jid, m); continue; }
      const text = m.message.conversation || m.message.extendedTextMessage?.text || '';
      if (text.trim()) await handleOwnerText(jid, text);
    }
  });
}
start();
