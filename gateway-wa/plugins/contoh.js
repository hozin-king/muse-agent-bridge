// Plugin contoh — salin file ini untuk membuat plugin sendiri.
// Format: export default { name, commands: [{ trigger, description, handler }] }
// handler menerima ctx: { sock, jid, text, args, reply, bridge, sendSafe }
// trigger = kata pertama pesan owner, mis. kirim "ping" -> dibalas "pong".
// Plugin hanya jalan untuk OWNER_JID, dan tidak perlu mengubah gateway.js.
export default {
  name: 'contoh',
  commands: [
    {
      trigger: 'ping',
      description: 'Tes gateway hidup',
      handler: async (ctx) => { await ctx.reply('pong — gateway hidup.'); },
    },
    {
      trigger: 'waktu',
      description: 'Jam sekarang (WIB)',
      handler: async (ctx) => {
        const now = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
        await ctx.reply('Sekarang: ' + now + ' WIB');
      },
    },
  ],
};
