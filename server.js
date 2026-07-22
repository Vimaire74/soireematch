'use strict';
/*
 * Soirée Match — serveur tout-en-un (site + inscriptions + admin)
 * Aucune dépendance npm : Node >= 22.5 uniquement (SQLite intégré).
 * Lancer :  node server.js
 * Config   :  copier config.example.json -> config.json et éditer.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

// ---------- Configuration ----------
const ROOT = __dirname;
// Config : variables d'environnement d'abord (Coolify), puis config.json si présent (optionnel).
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')); } catch { /* pas de config.json = on lit les variables d'environnement */ }
const PORT = process.env.PORT || cfg.port || 8090;
const ADMIN_USER = process.env.ADMIN_USER || cfg.adminUser || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || cfg.adminPass || '';
const SECRET = process.env.SESSION_SECRET || cfg.sessionSecret || crypto.randomBytes(32).toString('hex');
const REPORT_TOKEN = process.env.REPORT_TOKEN || cfg.reportToken || '';
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
if (!ADMIN_PASS) console.warn('⚠  ADMIN_PASS non défini : la page /admin restera inaccessible tant que le mot de passe n\'est pas réglé (le site et les inscriptions fonctionnent normalement).');

// ---------- Base de données ----------
const db = new DatabaseSync(path.join(DATA_DIR, 'soireematch.db'));
db.exec(`CREATE TABLE IF NOT EXISTS inscriptions(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  prenom TEXT, nom TEXT, email TEXT, tel TEXT, annee INTEGER,
  genre TEXT, recherche TEXT, consent INTEGER,
  ip TEXT, ua TEXT
)`);

// ---------- Utilitaires ----------
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function sign(value) {
  const h = crypto.createHmac('sha256', SECRET).update(value).digest('base64url');
  return value + '.' + h;
}
function unsign(signed) {
  if (!signed || signed.indexOf('.') < 0) return null;
  const i = signed.lastIndexOf('.');
  const value = signed.slice(0, i), sig = signed.slice(i + 1);
  const good = crypto.createHmac('sha256', SECRET).update(value).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(good);
  if (a.length === b.length && crypto.timingSafeEqual(a, b)) return value;
  return null;
}
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((c) => {
    const i = c.indexOf('=');
    if (i > 0) out[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim());
  });
  return out;
}
function isAuth(req) {
  const raw = parseCookies(req).sid;
  const val = unsign(raw);
  if (!val) return false;
  try {
    const s = JSON.parse(Buffer.from(val, 'base64url').toString('utf8'));
    return s.u === ADMIN_USER && s.exp > Date.now();
  } catch { return false; }
}
function makeSession() {
  const payload = Buffer.from(JSON.stringify({ u: ADMIN_USER, exp: Date.now() + 7 * 864e5 }), 'utf8').toString('base64url');
  return sign(payload);
}
function readBody(req, limit = 1e5) {
  return new Promise((resolve) => {
    let data = '', tooBig = false;
    req.on('data', (c) => { data += c; if (data.length > limit) { tooBig = true; req.destroy(); } });
    req.on('end', () => resolve(tooBig ? null : data));
    req.on('error', () => resolve(null));
  });
}
function parseForm(body) {
  const out = {};
  if (!body) return out;
  const ct = body.trim().startsWith('{') ? 'json' : 'form';
  if (ct === 'json') { try { return JSON.parse(body); } catch { return {}; } }
  new URLSearchParams(body).forEach((v, k) => {
    if (out[k] === undefined) out[k] = v;
    else if (Array.isArray(out[k])) out[k].push(v);
    else out[k] = [out[k], v];
  });
  return out;
}
function send(res, code, body, headers = {}) {
  res.writeHead(code, Object.assign({ 'Content-Type': 'text/html; charset=utf-8' }, headers));
  res.end(body);
}
function json(res, code, obj) {
  send(res, code, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8' });
}

// ---------- Anti-spam : limite par IP ----------
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < 60000);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > 6; // > 6 inscriptions / minute / IP
}

// ---------- Statistiques ----------
function stats() {
  const total = db.prepare('SELECT COUNT(*) n FROM inscriptions').get().n;
  const weekAgo = new Date(Date.now() - 7 * 864e5).toISOString();
  const semaine = db.prepare('SELECT COUNT(*) n FROM inscriptions WHERE created_at >= ?').get(weekAgo).n;
  const byGenre = db.prepare('SELECT genre, COUNT(*) n FROM inscriptions GROUP BY genre').all();
  const byRech = db.prepare('SELECT recherche, COUNT(*) n FROM inscriptions GROUP BY recherche').all();
  return { total, semaine, byGenre, byRech };
}

// ---------- Static ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
function serveStatic(res, urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.normalize(path.join(ROOT, 'public', rel));
  if (!file.startsWith(path.join(ROOT, 'public'))) return send(res, 403, 'Forbidden');
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'Introuvable');
    send(res, 200, buf, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  });
}

// ---------- Pages admin ----------
const CSS = `
  :root{--ink:#1e2f30;--muted:#566b6a;--accent:#2f7d8a;--line:#d3e5e2;--bg:#ecf4f3}
  *{box-sizing:border-box}body{font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;margin:0;background:var(--bg);color:var(--ink)}
  header{background:#161b24;color:#fff;padding:14px 20px;display:flex;justify-content:space-between;align-items:center}
  header b{letter-spacing:.05em}header a{color:#fff;opacity:.8;font-size:.9rem}
  .wrap{max-width:1100px;margin:0 auto;padding:20px}
  .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:20px}
  .card{background:#fff;border:1px solid var(--line);border-radius:12px;padding:16px;text-align:center}
  .card .n{font-size:1.7rem;font-weight:700;color:var(--accent)}
  .card .l{font-size:.78rem;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}
  form.filters{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px}
  input,select,button{font:inherit;padding:9px 12px;border:1px solid var(--line);border-radius:8px;background:#fff}
  button{background:var(--accent);color:#fff;border:0;cursor:pointer;font-weight:600}
  button.sec{background:#fff;color:var(--ink);border:1px solid var(--line)}
  button.danger{background:#c0392b}
  table{width:100%;border-collapse:collapse;background:#fff;border-radius:12px;overflow:hidden}
  th,td{padding:9px 10px;border-bottom:1px solid var(--line);text-align:left;font-size:.9rem}
  th{background:#f2f8f7;font-size:.75rem;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}
  .bar{display:flex;gap:8px;flex-wrap:wrap;margin:14px 0}
  .empty{padding:40px;text-align:center;color:var(--muted)}
  @media(max-width:640px){td,th{padding:7px 6px;font-size:.8rem}}
`;

function loginPage(err) {
  return `<!doctype html><html lang=fr><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
  <title>Admin — Soirée Match</title><style>${CSS}
  .box{max-width:340px;margin:12vh auto;background:#fff;border:1px solid var(--line);border-radius:14px;padding:26px}
  .box h1{font-size:1.2rem;margin:0 0 16px}.box input{width:100%;margin-bottom:10px}.box button{width:100%}
  .err{color:#c0392b;font-size:.85rem;margin-bottom:10px}</style>
  <div class=box><h1>Soirée Match — Admin</h1>
  ${err ? `<div class=err>${esc(err)}</div>` : ''}
  <form method=post action=/admin/login>
    <input name=user placeholder=Identifiant autocomplete=username required>
    <input name=pass type=password placeholder="Mot de passe" autocomplete=current-password required>
    <button>Se connecter</button>
  </form></div></html>`;
}

function adminPage(query) {
  const q = (query.q || '').trim();
  const fg = query.genre || '', fr = query.recherche || '';
  let sql = 'SELECT * FROM inscriptions WHERE 1=1', args = [];
  if (q) { sql += ' AND (prenom LIKE ? OR nom LIKE ? OR email LIKE ?)'; const l = `%${q}%`; args.push(l, l, l); }
  if (fg) { sql += ' AND genre = ?'; args.push(fg); }
  if (fr) { sql += ' AND recherche = ?'; args.push(fr); }
  sql += ' ORDER BY id DESC';
  const rows = db.prepare(sql).all(...args);
  const s = stats();
  const opt = (v, cur) => `<option${v === cur ? ' selected' : ''}>${esc(v)}</option>`;
  const genreCards = s.byGenre.map((g) => `<div class=card><div class=n>${g.n}</div><div class=l>${esc(g.genre || '—')}</div></div>`).join('');

  const trs = rows.map((r) => `<tr>
    <td><input type=checkbox name=ids value=${r.id} form=act></td>
    <td>${esc(r.created_at.slice(0, 10))}</td>
    <td>${esc(r.prenom)}</td><td>${esc(r.nom)}</td>
    <td><a href="mailto:${esc(r.email)}">${esc(r.email)}</a></td>
    <td>${esc(r.tel)}</td><td>${esc(r.annee)}</td>
    <td>${esc(r.genre)}</td><td>${esc(r.recherche)}</td>
  </tr>`).join('');

  return `<!doctype html><html lang=fr><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
  <title>Inscriptions — Soirée Match</title><style>${CSS}</style>
  <header><b>Soirée Match — Inscriptions</b><a href=/admin/logout>Déconnexion</a></header>
  <div class=wrap>
    <div class=cards>
      <div class=card><div class=n>${s.total}</div><div class=l>Total</div></div>
      <div class=card><div class=n>${s.semaine}</div><div class=l>Cette semaine</div></div>
      ${genreCards}
    </div>

    <form class=filters method=get action=/admin>
      <input name=q value="${esc(q)}" placeholder="Rechercher nom / e-mail…">
      <select name=genre><option value="">Tous genres</option>${['Femme', 'Homme', 'Non binaire'].map((v) => opt(v, fg)).join('')}</select>
      <select name=recherche><option value="">Toutes recherches</option>${['Des hommes', 'Des femmes', 'Les deux'].map((v) => opt(v, fr)).join('')}</select>
      <button>Filtrer</button>
      <a href=/admin><button type=button class=sec>Réinitialiser</button></a>
    </form>

    <form id=act method=post></form>
    <div class=bar>
      <button form=act formaction=/admin/export>⬇ Exporter la sélection (CSV)</button>
      <a href="/admin/export?all=1${q || fg || fr ? '&q=' + encodeURIComponent(q) + '&genre=' + encodeURIComponent(fg) + '&recherche=' + encodeURIComponent(fr) : ''}"><button type=button class=sec>⬇ Exporter tout (filtré)</button></a>
      <button form=act formaction=/admin/delete class=danger onclick="return confirm('Supprimer les inscriptions sélectionnées ?')">🗑 Supprimer la sélection</button>
    </div>

    ${rows.length ? `<table>
      <tr><th><input type=checkbox onclick="document.querySelectorAll('input[name=ids]').forEach(c=>c.checked=this.checked)"></th>
      <th>Date</th><th>Prénom</th><th>Nom</th><th>E-mail</th><th>Tél</th><th>Année</th><th>Genre</th><th>Recherche</th></tr>
      ${trs}
    </table>` : `<div class=empty>Aucune inscription pour l'instant.</div>`}
  </div></html>`;
}

function toCSV(rows) {
  const cols = ['id', 'created_at', 'prenom', 'nom', 'email', 'tel', 'annee', 'genre', 'recherche'];
  const q = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const lines = [cols.join(',')];
  rows.forEach((r) => lines.push(cols.map((c) => q(r[c])).join(',')));
  return '﻿' + lines.join('\r\n'); // BOM pour Excel
}

// ---------- Serveur ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

  // API publique : inscription
  if (p === '/api/inscription' && req.method === 'POST') {
    const d = parseForm(await readBody(req));
    if (d.website) return json(res, 200, { ok: true });          // honeypot rempli = bot
    if (rateLimited(ip)) return json(res, 429, { ok: false, error: 'Trop de tentatives, réessayez dans une minute.' });
    const prenom = (d.prenom || '').trim(), nom = (d.nom || '').trim(), email = (d.email || '').trim();
    const tel = (d.tel || '').trim(), annee = parseInt(d.annee, 10);
    const genre = (d.genre || '').trim(), recherche = (d.recherche || '').trim();
    const consent = (d.consent === 'on' || d.consent === true || d.consent === '1') ? 1 : 0;
    if (!prenom || !nom || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !tel ||
        !(annee >= 1930 && annee <= new Date().getFullYear()) || !genre || !recherche || !consent) {
      return json(res, 400, { ok: false, error: 'Merci de remplir tous les champs correctement (et de cocher le consentement).' });
    }
    db.prepare(`INSERT INTO inscriptions(created_at,prenom,nom,email,tel,annee,genre,recherche,consent,ip,ua)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(new Date().toISOString(), prenom, nom, email, tel, annee, genre, recherche, consent, ip, (req.headers['user-agent'] || '').slice(0, 300));
    return json(res, 200, { ok: true });
  }

  // Rapport (pour tâche automatique) : /api/stats?token=XXX
  if (p === '/api/stats' && req.method === 'GET') {
    if (!REPORT_TOKEN || url.searchParams.get('token') !== REPORT_TOKEN) return json(res, 401, { ok: false });
    return json(res, 200, stats());
  }

  // Admin — login
  if (p === '/admin/login' && req.method === 'GET') return send(res, 200, loginPage());
  if (p === '/admin/login' && req.method === 'POST') {
    const d = parseForm(await readBody(req));
    const ok = d.user === ADMIN_USER && ADMIN_PASS && crypto.timingSafeEqual(
      Buffer.from(String(d.pass || '').padEnd(64).slice(0, 64)), Buffer.from(String(ADMIN_PASS).padEnd(64).slice(0, 64)));
    if (!ok) return send(res, 401, loginPage('Identifiant ou mot de passe incorrect.'));
    return send(res, 302, '', { 'Set-Cookie': `sid=${encodeURIComponent(makeSession())}; HttpOnly; Path=/; Max-Age=604800; SameSite=Lax`, Location: '/admin' });
  }
  if (p === '/admin/logout') {
    return send(res, 302, '', { 'Set-Cookie': 'sid=; HttpOnly; Path=/; Max-Age=0', Location: '/admin/login' });
  }

  // Admin — protégé
  if (p.startsWith('/admin')) {
    if (!isAuth(req)) return send(res, 302, '', { Location: '/admin/login' });

    if (p === '/admin' && req.method === 'GET') {
      return send(res, 200, adminPage(Object.fromEntries(url.searchParams)));
    }
    if (p === '/admin/export') {
      let rows;
      if (url.searchParams.get('all')) {
        const q = url.searchParams.get('q') || '', fg = url.searchParams.get('genre') || '', fr = url.searchParams.get('recherche') || '';
        let sql = 'SELECT * FROM inscriptions WHERE 1=1', args = [];
        if (q) { sql += ' AND (prenom LIKE ? OR nom LIKE ? OR email LIKE ?)'; const l = `%${q}%`; args.push(l, l, l); }
        if (fg) { sql += ' AND genre=?'; args.push(fg); }
        if (fr) { sql += ' AND recherche=?'; args.push(fr); }
        sql += ' ORDER BY id DESC';
        rows = db.prepare(sql).all(...args);
      } else {
        const d = parseForm(await readBody(req));
        let ids = d.ids || [];
        if (!Array.isArray(ids)) ids = [ids];
        ids = ids.map(Number).filter(Boolean);
        if (!ids.length) return send(res, 302, '', { Location: '/admin' });
        rows = db.prepare(`SELECT * FROM inscriptions WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY id DESC`).all(...ids);
      }
      return send(res, 200, toCSV(rows), {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="soireematch-contacts-${new Date().toISOString().slice(0, 10)}.csv"`,
      });
    }
    if (p === '/admin/delete' && req.method === 'POST') {
      const d = parseForm(await readBody(req));
      let ids = d.ids || [];
      if (!Array.isArray(ids)) ids = [ids];
      ids = ids.map(Number).filter(Boolean);
      if (ids.length) db.prepare(`DELETE FROM inscriptions WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
      return send(res, 302, '', { Location: '/admin' });
    }
    return send(res, 404, 'Introuvable');
  }

  // Site statique
  if (req.method === 'GET') return serveStatic(res, req.url);
  send(res, 405, 'Méthode non autorisée');
});

server.listen(PORT, () => console.log(`Soirée Match en écoute sur http://127.0.0.1:${PORT}`));
