// Muse Bridge Web — Worker (Cloudflare Workers + D1)
//
// Satu file, tanpa build step. Deploy: lihat web/README.md dan web/deploy.py.
//
// Binding yang dibutuhkan:
//   DB             -> D1 database (tabel: agents, tasks, messages — web/schema.sql)
//   OWNER_PASSWORD -> secret, password login pemilik untuk aksi tulis di GUI
//
// Autentikasi:
//   - API agen : header "Authorization: Bearer <token agen>" (token disimpan sebagai SHA-256 hash di D1)
//   - GUI tulis: login pemilik (password -> cookie sesi bertanda tangan HMAC)
//   - Baca GUI publik: tanpa login.

const SESSION_TTL_MS = 7 * 24 * 3600 * 1000; // 7 hari

let schemaReady = null;

async function ensureSchema(env) {
  if (!schemaReady) {
    schemaReady = (async () => {
      await env.DB.batch([
        env.DB.prepare(`CREATE TABLE IF NOT EXISTS agents (
          id TEXT PRIMARY KEY, display_name TEXT NOT NULL, token_hash TEXT,
          status TEXT NOT NULL DEFAULT 'unclaimed', created_at TEXT NOT NULL)`),
        env.DB.prepare(`CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'open', created_by TEXT NOT NULL,
          claimed_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`),
        env.DB.prepare(`CREATE TABLE IF NOT EXISTS messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL,
          from_agent TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL)`),
        env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)`),
        env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_messages_task ON messages(task_id, id)`),
      ]);
    })();
  }
  return schemaReady;
}

// ---------- util ----------

const nowIso = () => new Date().toISOString();

function newTaskId() {
  const rand = Math.random().toString(36).slice(2, 6);
  return "t-" + Date.now().toString(36) + rand;
}

function esc(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function fmtTime(iso) {
  try {
    return new Date(iso).toLocaleString("id-ID", {
      timeZone: "Asia/Jakarta",
      day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
    }) + " WIB";
  } catch {
    return esc(iso);
  }
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmacHex(key, text) {
  const k = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(text));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function html(body, status = 200, extraHeaders = {}) {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", ...extraHeaders },
  });
}

function redirect(location, extraHeaders = {}) {
  return new Response(null, { status: 303, headers: { location, ...extraHeaders } });
}

// ---------- auth ----------

async function agentFromRequest(request, env) {
  const auth = request.headers.get("authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const hash = await sha256Hex(m[1].trim());
  const row = await env.DB.prepare(
    "SELECT id, display_name, status FROM agents WHERE token_hash = ?"
  ).bind(hash).first();
  return row || null;
}

async function makeSessionCookie(env) {
  const exp = String(Date.now() + SESSION_TTL_MS);
  const sig = await hmacHex(env.OWNER_PASSWORD, exp);
  return `mb_session=${exp}.${sig}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}`;
}

async function isOwner(request, env) {
  if (!env.OWNER_PASSWORD) return false;
  const cookie = request.headers.get("cookie") || "";
  const m = cookie.match(/mb_session=([0-9]+)\.([0-9a-f]+)/);
  if (!m) return false;
  if (Number(m[1]) < Date.now()) return false;
  const expect = await hmacHex(env.OWNER_PASSWORD, m[1]);
  return expect === m[2];
}

// ---------- data ----------

async function listAgents(env) {
  const { results } = await env.DB.prepare(
    "SELECT id, display_name, status, created_at FROM agents ORDER BY id"
  ).all();
  return results;
}

async function listTasks(env, status = null) {
  const q = status
    ? env.DB.prepare("SELECT * FROM tasks WHERE status = ? ORDER BY updated_at DESC").bind(status)
    : env.DB.prepare("SELECT * FROM tasks ORDER BY updated_at DESC");
  const { results } = await q.all();
  return results;
}

async function getTask(env, id) {
  return env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(id).first();
}

async function listMessages(env, taskId, limit = 100) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM messages WHERE task_id = ? ORDER BY id ASC LIMIT ?"
  ).bind(taskId, limit).all();
  return results;
}

async function recentMessages(env, limit = 10) {
  const { results } = await env.DB.prepare(
    `SELECT m.*, t.title AS task_title FROM messages m
     JOIN tasks t ON t.id = m.task_id ORDER BY m.id DESC LIMIT ?`
  ).bind(limit).all();
  return results;
}

async function addMessage(env, taskId, fromAgent, text) {
  await env.DB.prepare(
    "INSERT INTO messages (task_id, from_agent, text, created_at) VALUES (?, ?, ?, ?)"
  ).bind(taskId, fromAgent, text, nowIso()).run();
}

async function createTask(env, { title, body, createdBy }) {
  const id = newTaskId();
  const ts = nowIso();
  await env.DB.prepare(
    `INSERT INTO tasks (id, title, body, status, created_by, claimed_by, created_at, updated_at)
     VALUES (?, ?, ?, 'open', ?, NULL, ?, ?)`
  ).bind(id, title, body || "", createdBy, ts, ts).run();
  return getTask(env, id);
}

async function claimTask(env, task, agentId) {
  if (task.status === "done") return { error: "Tugas sudah selesai (done)." };
  if (task.claimed_by && task.claimed_by !== agentId) {
    return { error: `Tugas sudah di-claim oleh ${task.claimed_by}.` };
  }
  await env.DB.prepare(
    "UPDATE tasks SET status = 'claimed', claimed_by = ?, updated_at = ? WHERE id = ?"
  ).bind(agentId, nowIso(), task.id).run();
  return { task: await getTask(env, task.id) };
}

async function doneTask(env, task) {
  await env.DB.prepare(
    "UPDATE tasks SET status = 'done', updated_at = ? WHERE id = ?"
  ).bind(nowIso(), task.id).run();
  return getTask(env, task.id);
}

async function setTaskStatus(env, task, status) {
  if (!["open", "claimed", "done"].includes(status)) return null;
  await env.DB.prepare(
    "UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?"
  ).bind(status, nowIso(), task.id).run();
  return getTask(env, task.id);
}

// ---------- GUI ----------

const CSS = `
:root{--bg:#0f1420;--card:#1a2233;--line:#2b3852;--txt:#e8edf6;--mut:#93a2bd;--acc:#4f8cff;--ok:#3fb96f;--warn:#e0a83e}
*{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;background:var(--bg);color:var(--txt)}
a{color:var(--acc);text-decoration:none}a:hover{text-decoration:underline}
header{display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid var(--line)}
header h1{font-size:18px;margin:0}
main{max-width:980px;margin:0 auto;padding:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px;margin-bottom:14px}
.mut{color:var(--mut);font-size:13px}
.badge{display:inline-block;padding:1px 8px;border-radius:99px;font-size:12px;border:1px solid var(--line)}
.b-open{color:var(--warn)}.b-claimed{color:var(--acc)}.b-done{color:var(--ok)}
.cols{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
@media(max-width:760px){.cols{grid-template-columns:1fr}}
.task{display:block;padding:10px;border:1px solid var(--line);border-radius:10px;margin-bottom:8px;color:var(--txt)}
.task b{display:block;margin-bottom:2px}
input,textarea,select{width:100%;padding:10px;border-radius:8px;border:1px solid var(--line);background:#0d1220;color:var(--txt);margin:4px 0 10px}
button,.btn{display:inline-block;background:var(--acc);color:#fff;border:0;padding:9px 14px;border-radius:8px;cursor:pointer;font-size:14px}
button.ghost,.btn.ghost{background:transparent;border:1px solid var(--line);color:var(--txt)}
.msg{border-left:3px solid var(--acc);padding:6px 10px;margin:8px 0;background:#141b2c;border-radius:0 8px 8px 0}
pre{white-space:pre-wrap;word-break:break-word}
footer{padding:18px 16px;text-align:center}
`;

function layout(title, content, owner) {
  return `<!doctype html>
<html lang="id"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — Muse Bridge</title><style>${CSS}</style></head>
<body>
<header>
  <h1>🌉 <a href="/" style="color:inherit">Muse Bridge</a></h1>
  <nav>
    <a href="/">Dashboard</a> · <a href="/new">Tugas baru</a> ·
    ${owner
      ? `<form method="post" action="/logout" style="display:inline"><button class="ghost" type="submit">Keluar (pemilik)</button></form>`
      : `<a href="/login">Login pemilik</a>`}
  </nav>
</header>
<main>${content}</main>
<footer class="mut">Muse Agent Bridge — kolaborasi asinkron antar-agen Muse. Kode sumber terbuka di GitHub (hozin-king/muse-agent-bridge).</footer>
</body></html>`;
}

function taskCard(t) {
  return `<a class="task" href="/tasks/${esc(t.id)}">
    <b>${esc(t.title)}</b>
    <span class="mut">oleh ${esc(t.created_by)}${t.claimed_by ? " · dipegang " + esc(t.claimed_by) : ""}<br>${fmtTime(t.updated_at)}</span>
  </a>`;
}

async function pageDashboard(env, owner) {
  const [agents, tasks, recent] = await Promise.all([
    listAgents(env), listTasks(env), recentMessages(env, 10),
  ]);
  const col = (st, label) => `
    <div class="card"><h3 style="margin-top:0">${label} <span class="badge b-${st}">${tasks.filter((t) => t.status === st).length}</span></h3>
    ${tasks.filter((t) => t.status === st).map(taskCard).join("") || '<p class="mut">Kosong.</p>'}</div>`;
  const content = `
  <div class="card"><h3 style="margin-top:0">Agen</h3>
    ${agents.map((a) => `<div>🤖 <b>${esc(a.display_name)}</b> <span class="mut">(${esc(a.id)})</span> — <span class="badge ${a.status === "claimed" ? "b-done" : "b-open"}">${esc(a.status)}</span></div>`).join("") || '<p class="mut">Belum ada agen.</p>'}
  </div>
  <div class="card"><h3 style="margin-top:0">🧰 Shared Tools</h3>
    <div>🔍 <b>Agent-Reach</b> — CLI baca/cari lintas platform (Twitter/X, Reddit, YouTube, GitHub, Bilibili, Xiaohongshu, Facebook, Instagram, LinkedIn, dll) tanpa API berbayar.
    Tersedia untuk semua agen; jalankan di mesin masing-masing, lampirkan hasil pencarian sebagai handoff di tugas terkait.<br>
    <a href="https://github.com/hozin-king/Agent-Reach" target="_blank" rel="noopener">github.com/hozin-king/Agent-Reach</a></div>
  </div>
  <div class="cols">${col("open", "📥 Open")}${col("claimed", "🔧 Claimed")}${col("done", "✅ Done")}</div>
  <div class="card"><h3 style="margin-top:0">Handoff terbaru</h3>
    ${recent.map((m) => `<div class="msg"><b>${esc(m.from_agent)}</b> di <a href="/tasks/${esc(m.task_id)}">${esc(m.task_title)}</a> <span class="mut">${fmtTime(m.created_at)}</span><br>${esc(m.text)}</div>`).join("") || '<p class="mut">Belum ada handoff.</p>'}
  </div>`;
  return layout("Dashboard", content, owner);
}

async function pageTaskDetail(env, id, owner) {
  const task = await getTask(env, id);
  if (!task) return null;
  const msgs = await listMessages(env, id);
  const agents = await listAgents(env);
  const agentOptions = agents.map((a) => `<option value="${esc(a.id)}">${esc(a.id)}</option>`).join("");
  const ownerForms = owner ? `
  <div class="card"><h3 style="margin-top:0">Aksi pemilik</h3>
    <form method="post" action="/tasks/${esc(task.id)}/message">
      <label>Tulis handoff / pesan (sebagai owner)</label>
      <textarea name="text" rows="3" required></textarea>
      <button type="submit">Kirim pesan</button>
    </form>
    <form method="post" action="/tasks/${esc(task.id)}/claim" style="margin-top:12px">
      <label>Claim atas nama agen</label>
      <select name="agent_id">${agentOptions}</select>
      <button type="submit">Claim</button>
    </form>
    <form method="post" action="/tasks/${esc(task.id)}/done" style="margin-top:12px">
      <button type="submit">Tandai selesai (done)</button>
    </form>
  </div>` : `<div class="card"><p class="mut">Aksi tulis butuh <a href="/login">login pemilik</a>. Agen memakai API dengan token (lihat README repo).</p></div>`;
  const content = `
  <div class="card">
    <h2 style="margin:0 0 6px">${esc(task.title)}</h2>
    <div class="mut">Status <span class="badge b-${esc(task.status)}">${esc(task.status)}</span> ·
    dibuat oleh ${esc(task.created_by)} · ${fmtTime(task.created_at)} ·
    terakhir diubah ${fmtTime(task.updated_at)}${task.claimed_by ? " · dipegang " + esc(task.claimed_by) : ""}</div>
    <pre>${esc(task.body)}</pre>
  </div>
  <div class="card"><h3 style="margin-top:0">Handoff &amp; pesan (${msgs.length})</h3>
    ${msgs.map((m) => `<div class="msg"><b>${esc(m.from_agent)}</b> <span class="mut">${fmtTime(m.created_at)}</span><br>${esc(m.text)}</div>`).join("") || '<p class="mut">Belum ada pesan.</p>'}
  </div>
  ${ownerForms}`;
  return layout(task.title, content, owner);
}

function pageNew(owner) {
  const content = owner ? `
  <div class="card"><h3 style="margin-top:0">Buat tugas baru</h3>
    <form method="post" action="/tasks">
      <label>Judul</label><input name="title" required maxlength="200">
      <label>Isi / deskripsi</label><textarea name="body" rows="6"></textarea>
      <button type="submit">Buat tugas</button>
    </form></div>`
    : `<div class="card"><p>Membuat tugas dari GUI butuh <a href="/login">login pemilik</a>.</p></div>`;
  return layout("Tugas baru", content, owner);
}

function pageLogin(error = "") {
  const content = `
  <div class="card"><h3 style="margin-top:0">Login pemilik</h3>
    ${error ? `<p style="color:#e06c5d">${esc(error)}</p>` : ""}
    <form method="post" action="/login">
      <label>Password pemilik</label>
      <input name="password" type="password" required autocomplete="current-password">
      <button type="submit">Masuk</button>
    </form>
    <p class="mut">Login hanya untuk aksi tulis dari GUI. Membaca dashboard bersifat publik; agen memakai token API.</p>
  </div>`;
  return layout("Login", content, false);
}

// ---------- router ----------

async function parseBody(request) {
  const ct = request.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    try { return await request.json(); } catch { return {}; }
  }
  const form = await request.formData();
  const out = {};
  for (const [k, v] of form.entries()) out[k] = v;
  return out;
}

async function handleApi(request, env, url) {
  const agent = await agentFromRequest(request, env);
  if (!agent) return json({ error: "Token agen tidak valid atau tidak ada." }, 401);

  const path = url.pathname;
  const method = request.method;

  if (path === "/api/agents" && method === "GET") {
    return json({ agents: await listAgents(env) });
  }

  if (path === "/api/tasks" && method === "GET") {
    const status = url.searchParams.get("status");
    return json({ tasks: await listTasks(env, status) });
  }

  if (path === "/api/tasks" && method === "POST") {
    const b = await parseBody(request);
    if (!b.title) return json({ error: "Field 'title' wajib." }, 400);
    const task = await createTask(env, { title: String(b.title).slice(0, 200), body: String(b.body || ""), createdBy: agent.id });
    return json({ task }, 201);
  }

  const m = path.match(/^\/api\/tasks\/([A-Za-z0-9-]+)(\/(claim|handoff|done))?$/);
  if (m) {
    const task = await getTask(env, m[1]);
    if (!task) return json({ error: "Tugas tidak ditemukan." }, 404);
    const action = m[3];

    if (!action && method === "GET") {
      return json({ task, messages: await listMessages(env, task.id) });
    }
    if (action === "claim" && method === "POST") {
      const r = await claimTask(env, task, agent.id);
      if (r.error) return json({ error: r.error }, 409);
      return json({ task: r.task });
    }
    if (action === "handoff" && method === "POST") {
      const b = await parseBody(request);
      if (!b.text) return json({ error: "Field 'text' wajib." }, 400);
      await addMessage(env, task.id, agent.id, String(b.text));
      let updated = task;
      if (b.status) {
        updated = (await setTaskStatus(env, task, String(b.status))) || task;
      } else {
        await env.DB.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").bind(nowIso(), task.id).run();
        updated = await getTask(env, task.id);
      }
      return json({ task: updated, messages: await listMessages(env, task.id) });
    }
    if (action === "done" && method === "POST") {
      return json({ task: await doneTask(env, task) });
    }
  }

  return json({ error: "Endpoint tidak ditemukan." }, 404);
}

async function handleGui(request, env, url) {
  const path = url.pathname;
  const method = request.method;
  const owner = await isOwner(request, env);

  if (path === "/" && method === "GET") return html(await pageDashboard(env, owner));
  if (path === "/new" && method === "GET") return html(pageNew(owner));

  if (path === "/login" && method === "GET") {
    return owner ? redirect("/") : html(pageLogin());
  }
  if (path === "/login" && method === "POST") {
    const b = await parseBody(request);
    if (env.OWNER_PASSWORD && b.password === env.OWNER_PASSWORD) {
      return redirect("/", { "set-cookie": await makeSessionCookie(env) });
    }
    return html(pageLogin("Password salah."), 401);
  }
  if (path === "/logout" && method === "POST") {
    return redirect("/", { "set-cookie": "mb_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0" });
  }

  const detail = path.match(/^\/tasks\/([A-Za-z0-9-]+)$/);
  if (detail && method === "GET") {
    const page = await pageTaskDetail(env, detail[1], owner);
    return page ? html(page) : html(layout("Tidak ditemukan", '<div class="card">Tugas tidak ditemukan.</div>', owner), 404);
  }

  // Aksi tulis GUI — wajib login pemilik.
  if (path === "/tasks" && method === "POST") {
    if (!owner) return redirect("/login");
    const b = await parseBody(request);
    if (!b.title) return html(pageNew(owner), 400);
    const task = await createTask(env, { title: String(b.title).slice(0, 200), body: String(b.body || ""), createdBy: "owner" });
    return redirect(`/tasks/${task.id}`);
  }

  const act = path.match(/^\/tasks\/([A-Za-z0-9-]+)\/(message|claim|done)$/);
  if (act && method === "POST") {
    if (!owner) return redirect("/login");
    const task = await getTask(env, act[1]);
    if (!task) return html(layout("Tidak ditemukan", '<div class="card">Tugas tidak ditemukan.</div>', owner), 404);
    const b = await parseBody(request);
    if (act[2] === "message") {
      if (b.text) await addMessage(env, task.id, "owner", String(b.text));
    } else if (act[2] === "claim") {
      if (b.agent_id) await claimTask(env, task, String(b.agent_id));
    } else if (act[2] === "done") {
      await doneTask(env, task);
    }
    return redirect(`/tasks/${task.id}`);
  }

  return html(layout("Tidak ditemukan", '<div class="card">Halaman tidak ditemukan.</div>', owner), 404);
}

export default {
  async fetch(request, env) {
    try {
      await ensureSchema(env);
      const url = new URL(request.url);
      if (url.pathname.startsWith("/api/")) return await handleApi(request, env, url);
      return await handleGui(request, env, url);
    } catch (err) {
      return json({ error: "Kesalahan server: " + (err && err.message ? err.message : String(err)) }, 500);
    }
  },
};
