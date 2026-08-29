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
const nodemailer = require('nodemailer');

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
  genre TEXT, recherche TEXT, langues TEXT, consent INTEGER,
  ip TEXT, ua TEXT
)`);

db.exec(`CREATE TABLE IF NOT EXISTS pageviews(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  day TEXT NOT NULL,
  ref TEXT, lang TEXT, vhash TEXT
)`);

// ---------- E-mail (OVH Zimbra SMTP) ----------
const MAIL_USER = process.env.MAIL_USER || '';
const MAIL_PASS = process.env.MAIL_PASS || '';
const MAIL_FROM = process.env.MAIL_FROM || (MAIL_USER ? `Soirée Match <${MAIL_USER}>` : '');
const NOTIFY_TO = process.env.NOTIFY_TO || '';   // ton adresse, pour être prévenu de chaque inscription (optionnel)
let transporter = null;
if (MAIL_USER && MAIL_PASS) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'ssl0.ovh.net',
    port: Number(process.env.SMTP_PORT || 465),
    secure: (process.env.SMTP_SECURE || 'true') !== 'false',   // 465 = SSL ; mettre SMTP_SECURE=false + SMTP_PORT=587 pour STARTTLS
    auth: { user: MAIL_USER, pass: MAIL_PASS },
  });
  console.log('✉  Envoi d\'e-mails activé (' + MAIL_USER + ')');
} else {
  console.warn('✉  Envoi d\'e-mails désactivé (MAIL_USER / MAIL_PASS non définis) — les inscriptions sont quand même enregistrées.');
}

function sendConfirmation(i) {
  if (!transporter) return;
  const prenom = (i.prenom || '').trim() || 'à toi';
  transporter.sendMail({
    from: MAIL_FROM,
    to: i.email,
    subject: 'Ton inscription à la Soirée Match est confirmée 🎉',
    text:
`Bonjour ${prenom},

Merci ! Ton inscription à la Soirée Match est bien enregistrée.

On te recontacte très vite avec la date, le lieu exact à Lausanne et les détails pour régler ton entrée (20 CHF). En attendant, prépare-toi à faire de vraies rencontres — sans applis, sans swipe.

À très vite,
L'équipe Soirée Match

Une question ? Réponds simplement à cet e-mail.`,
    html:
`<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:520px;margin:auto;color:#1e2f30">
  <div style="background:linear-gradient(135deg,#2f7d8a,#6fc0c0);color:#fff;padding:28px 24px;border-radius:14px 14px 0 0">
    <h1 style="margin:0;font-size:1.5rem">Soirée Match</h1>
    <p style="margin:6px 0 0;opacity:.95">Ton inscription est confirmée 🎉</p>
  </div>
  <div style="border:1px solid #d3e5e2;border-top:0;border-radius:0 0 14px 14px;padding:24px">
    <p>Bonjour ${prenom},</p>
    <p>Merci&nbsp;! Ton inscription à la <b>Soirée Match</b> est bien enregistrée.</p>
    <p>On te recontacte très vite avec la <b>date</b>, le <b>lieu exact à Lausanne</b> et les détails pour régler ton entrée (20&nbsp;CHF). En attendant, prépare-toi à faire de vraies rencontres — sans applis, sans swipe.</p>
    <p style="margin-top:22px">À très vite,<br><b>L'équipe Soirée Match</b></p>
    <p style="color:#6f7f7e;font-size:.85rem;margin-top:22px">Une question&nbsp;? Réponds simplement à cet e-mail.</p>
  </div>
</div>`,
  }).catch((e) => console.error('Envoi e-mail confirmation échoué:', e.message));

  if (NOTIFY_TO) {
    transporter.sendMail({
      from: MAIL_FROM, to: NOTIFY_TO,
      subject: `Nouvelle inscription : ${i.prenom} ${i.nom}`,
      text: `${i.prenom} ${i.nom}\n${i.email} — ${i.tel}\nNé(e) en ${i.annee} · ${i.genre} · cherche : ${i.recherche}\nLangues : ${i.langues || '—'}`,
    }).catch((e) => console.error('Notif organisateur échouée:', e.message));
  }
}

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

// ---------- Désinscription + campagnes e-mail ----------
try { db.exec('ALTER TABLE inscriptions ADD COLUMN unsubscribed INTEGER DEFAULT 0'); } catch { /* colonne déjà présente */ }
try { db.exec('ALTER TABLE inscriptions ADD COLUMN langues TEXT'); } catch { /* colonne déjà présente */ }

const SITE_URL = (process.env.SITE_URL || cfg.siteUrl || 'https://soireematch.com').replace(/\/+$/, '');
const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WH_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const PAY_ON = !!STRIPE_SECRET;
const unsubToken = (email) => crypto.createHmac('sha256', SECRET).update('unsub:' + String(email).toLowerCase()).digest('base64url');
const unsubLink = (email) => `${SITE_URL}/unsub?e=${encodeURIComponent(email)}&t=${unsubToken(email)}`;

// ---------- Soirées + réservations ----------
db.exec(`CREATE TABLE IF NOT EXISTS soirees(
  id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE NOT NULL,
  date_texte TEXT, lieu TEXT, prix TEXT, actif INTEGER DEFAULT 1, created_at TEXT)`);
db.exec(`CREATE TABLE IF NOT EXISTS reservations(
  id INTEGER PRIMARY KEY AUTOINCREMENT, soiree_id INTEGER,
  prenom TEXT, nom TEXT, email TEXT, tel TEXT, annee INTEGER, genre TEXT, recherche TEXT,
  created_at TEXT, paid INTEGER DEFAULT 0)`);
try { db.exec('ALTER TABLE soirees ADD COLUMN tranche TEXT'); } catch { /* déjà là */ }
try { db.exec('ALTER TABLE soirees ADD COLUMN type TEXT'); } catch { /* déjà là */ }
try { db.exec('ALTER TABLE reservations ADD COLUMN stripe_session TEXT'); } catch { /* déjà là */ }
try { db.exec('ALTER TABLE reservations ADD COLUMN amount INTEGER'); } catch { /* déjà là */ }

const getSoiree = (code) => db.prepare('SELECT * FROM soirees WHERE code=?').get(code);
const getSoireeById = (id) => db.prepare('SELECT * FROM soirees WHERE id=?').get(id);
const soireeLink = (code) => `${SITE_URL}/soiree/${encodeURIComponent(code)}`;

// ---------- Routage : lien de réservation personnalisé + correspondance profil → soirées ----------
const TYPES = ['Hétéro', 'Gay hommes', 'Gay femmes'];
const TRANCHES = ['30-40', '40-50', '50-60'];
const resaToken = (email) => crypto.createHmac('sha256', SECRET).update('resa:' + String(email).toLowerCase()).digest('base64url');
const resaLink = (email) => `${SITE_URL}/reserver?e=${encodeURIComponent(email)}&t=${resaToken(email)}`;

// ---------- Paiement Stripe (actif uniquement si STRIPE_SECRET_KEY est défini) ----------
function priceRappen(so) {
  const m = String((so && so.prix) || '').replace(',', '.').match(/(\d+(?:\.\d+)?)/);
  const chf = m ? parseFloat(m[1]) : 20;
  return Math.round((chf > 0 ? chf : 20) * 100);
}
function stripeApi(method, apiPath, params) {
  return new Promise((resolve, reject) => {
    const body = params ? new URLSearchParams(params).toString() : '';
    const rq = require('node:https').request({
      hostname: 'api.stripe.com', path: apiPath, method,
      headers: { Authorization: 'Bearer ' + STRIPE_SECRET, 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
    }, (resp) => {
      let data = '';
      resp.on('data', (c) => { data += c; });
      resp.on('end', () => {
        let j = null; try { j = JSON.parse(data); } catch {}
        if (resp.statusCode >= 400) reject(new Error((j && j.error && j.error.message) || ('Stripe ' + resp.statusCode)));
        else resolve(j);
      });
    });
    rq.on('error', reject);
    if (body) rq.write(body);
    rq.end();
  });
}
async function createCheckout(resaId, so, email) {
  const amount = priceRappen(so);
  const params = {
    mode: 'payment',
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': 'chf',
    'line_items[0][price_data][unit_amount]': String(amount),
    'line_items[0][price_data][product_data][name]': `Soirée Match — ${so.date_texte || so.code}`,
    customer_email: email,
    locale: 'fr',
    client_reference_id: String(resaId),
    'metadata[rid]': String(resaId),
    'metadata[soiree]': so.code,
    success_url: `${SITE_URL}/paiement/ok?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${SITE_URL}/paiement/annule?rid=${resaId}`,
  };
  const sess = await stripeApi('POST', '/v1/checkout/sessions', params);
  db.prepare('UPDATE reservations SET stripe_session=?, amount=? WHERE id=?').run(sess.id, amount, resaId);
  return sess.url;
}
function markPaidAndConfirm(resa) {
  if (!resa || resa.paid) return;
  db.prepare('UPDATE reservations SET paid=1 WHERE id=?').run(resa.id);
  const so = getSoireeById(resa.soiree_id);
  if (so) sendReservationMail(so, { prenom: resa.prenom, nom: resa.nom, email: resa.email });
}
function verifyStripeSig(payload, header, secret) {
  try {
    const parts = {}; String(header || '').split(',').forEach((kv) => { const i = kv.indexOf('='); if (i > 0) parts[kv.slice(0, i)] = kv.slice(i + 1); });
    if (!parts.t || !parts.v1) return false;
    const expected = crypto.createHmac('sha256', secret).update(parts.t + '.' + payload).digest('hex');
    return parts.v1.length === expected.length && crypto.timingSafeEqual(Buffer.from(parts.v1), Buffer.from(expected));
  } catch { return false; }
}
async function startReservation(res, so, person) {
  const email = person.email;
  const paidDup = db.prepare('SELECT id FROM reservations WHERE soiree_id=? AND lower(email)=lower(?) AND paid=1').get(so.id, email);
  if (paidDup) return send(res, 200, pubMsg('Déjà réservé', 'Ta place pour cette soirée est déjà confirmée. À très vite ! 💛'));
  if (!PAY_ON) {
    const dup = db.prepare('SELECT id FROM reservations WHERE soiree_id=? AND lower(email)=lower(?)').get(so.id, email);
    if (!dup) {
      db.prepare(`INSERT INTO reservations(soiree_id,prenom,nom,email,tel,annee,genre,recherche,created_at) VALUES(?,?,?,?,?,?,?,?,?)`)
        .run(so.id, person.prenom, person.nom, email, person.tel, person.annee, person.genre, person.recherche, new Date().toISOString());
      sendReservationMail(so, person);
    }
    return send(res, 200, soireeOkPage(so));
  }
  let resa = db.prepare('SELECT * FROM reservations WHERE soiree_id=? AND lower(email)=lower(?) AND COALESCE(paid,0)=0').get(so.id, email);
  if (!resa) {
    const info = db.prepare(`INSERT INTO reservations(soiree_id,prenom,nom,email,tel,annee,genre,recherche,created_at,paid) VALUES(?,?,?,?,?,?,?,?,?,0)`)
      .run(so.id, person.prenom, person.nom, email, person.tel, person.annee, person.genre, person.recherche, new Date().toISOString());
    resa = { id: Number(info.lastInsertRowid) };
  }
  try {
    const link = await createCheckout(resa.id, so, email);
    return send(res, 302, '', { Location: link });
  } catch (e) {
    console.error('Stripe checkout échoué:', e.message);
    return send(res, 200, pubMsg('Paiement momentanément indisponible', 'Réessaie dans un instant, ou écris-nous à contact@soireematch.com.'));
  }
}
const ageOf = (annee) => new Date().getFullYear() - Number(annee);

function allowedTypes(genre, recherche) {
  // Bisexuel·le → uniquement la soirée gay de son genre (exclu des soirées hétéro)
  if (recherche === 'Les deux') {
    if (genre === 'Homme') return ['Gay hommes'];
    if (genre === 'Femme') return ['Gay femmes'];
    return [];   // non binaire + les deux : pas de soirée dédiée pour l'instant
  }
  // Strictement hétéro
  if (genre === 'Femme' && recherche === 'Des hommes') return ['Hétéro'];
  if (genre === 'Homme' && recherche === 'Des femmes') return ['Hétéro'];
  // Gay (gays + bi via la branche ci-dessus)
  if (genre === 'Homme' && recherche === 'Des hommes') return ['Gay hommes'];
  if (genre === 'Femme' && recherche === 'Des femmes') return ['Gay femmes'];
  // Non binaire (et cas non couverts) : exclu des hétéro, pas de soirée dédiée pour l'instant
  return [];
}
function trancheOk(tranche, age) {
  if (!tranche || !Number.isFinite(age)) return true;   // soirée sans tranche = visible par tous
  const m = String(tranche).match(/(\d+)\s*[-–]\s*(\d+)/);
  if (!m) return true;
  return age >= (+m[1] - 3) && age <= (+m[2] + 3);       // souplesse ±3 ans
}
function matchingSoirees(person) {
  const types = allowedTypes(person.genre, person.recherche);
  if (!types.length) return [];   // profil sans soirée dédiée (non binaire / bi non binaire)
  const age = ageOf(person.annee);
  return db.prepare('SELECT * FROM soirees WHERE actif=1 ORDER BY id DESC').all()
    .filter((s) => (!s.type || types.includes(s.type)) && trancheOk(s.tranche, age));
}

function sendReservationMail(so, i) {
  if (!transporter) return;
  const prenom = (i.prenom || '').trim() || 'à toi';
  const quand = so.date_texte ? ` du ${so.date_texte}` : '';
  transporter.sendMail({
    from: MAIL_FROM, to: i.email,
    subject: `Ta réservation Soirée Match${so.date_texte ? ` — ${so.date_texte}` : ''} est confirmée 🎉`,
    text: `Bonjour ${prenom},\n\nTa place pour la Soirée Match${quand} est bien réservée !\n${so.lieu ? `\nLieu : ${so.lieu}` : ''}${so.prix ? `\nEntrée : ${so.prix}` : ''}\n\nUn petit mot qui compte : la salle nous est offerte par le bar, alors pense à consommer un verre ou deux pour les remercier.\n\nOn a hâte de te voir. À très vite !\nTa team Soirée Match 💛`,
  }).catch((e) => console.error('Mail réservation échoué:', e.message));
  if (NOTIFY_TO) transporter.sendMail({ from: MAIL_FROM, to: NOTIFY_TO, subject: `Réservation « ${so.code} » : ${i.prenom || ''} ${i.nom || ''}`, text: `Nouvelle réservation pour ${so.code} (${so.date_texte || ''})\n${i.prenom || ''} ${i.nom || ''} — ${i.email || ''}` }).catch(() => {});
}
function resaCSV(rows) {
  const cols = ['id', 'created_at', 'prenom', 'nom', 'email', 'tel', 'annee', 'genre', 'recherche'];
  const q = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  return '﻿' + [cols.join(','), ...rows.map((r) => cols.map((c) => q(r[c])).join(','))].join('\r\n');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastCampaign = null; // { at, total, sent, failed, running, subject }

async function runCampaign(recipients, subject, body, linkUrl = SITE_URL, so = null) {
  lastCampaign = { at: new Date().toISOString(), total: recipients.length, sent: 0, failed: 0, running: true, subject };
  const dateTxt = (so && so.date_texte) ? so.date_texte : '';
  const lieuTxt = (so && so.lieu) ? so.lieu : '';
  for (const r of recipients) {
    const prenom = (r.prenom || '').trim() || 'à toi';
    const unsub = unsubLink(r.email);
    const resa = resaLink(r.email);
    const rep = (s) => s.replace(/\{pr[ée]nom\}/gi, prenom).replace(/\{lien\}/gi, linkUrl).replace(/\{reserver\}/gi, resa).replace(/\{date\}/gi, dateTxt).replace(/\{lieu\}/gi, lieuTxt);
    const subj = rep(subject);
    const txt = rep(body) + `\n\n—\nPour ne plus recevoir ces e-mails : ${unsub}`;
    const btn = `<a href="${resa}" style="display:inline-block;background:#2f7d8a;color:#fff;text-decoration:none;padding:12px 24px;border-radius:30px;font-weight:600">Je réserve ma place</a>`;
    const htmlBody = esc(body).replace(/\{pr[ée]nom\}/gi, esc(prenom))
      .replace(/\{lien\}/gi, `<a href="${linkUrl}" style="color:#2f7d8a">${esc(linkUrl)}</a>`)
      .replace(/\{reserver\}/gi, btn)
      .replace(/\{date\}/gi, esc(dateTxt)).replace(/\{lieu\}/gi, esc(lieuTxt))
      .replace(/\n/g, '<br>');
    const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:540px;margin:auto;color:#1e2f30;font-size:15px;line-height:1.55">`
      + htmlBody
      + `<hr style="border:none;border-top:1px solid #e0e0e0;margin:22px 0">`
      + `<p style="font-size:12px;color:#8a9a99">Tu reçois cet e-mail car tu t'es inscrit(e) à la Soirée Match. <a href="${unsub}" style="color:#8a9a99">Se désinscrire</a>.</p></div>`;
    try {
      await transporter.sendMail({ from: MAIL_FROM, to: r.email, subject: subj, text: txt, html });
      lastCampaign.sent++;
    } catch (e) { lastCampaign.failed++; console.error('Campagne — échec', r.email, e.message); }
    await sleep(300);
  }
  lastCampaign.running = false;
  console.log(`Campagne « ${subject} » : ${lastCampaign.sent}/${lastCampaign.total} envoyés, ${lastCampaign.failed} échecs.`);
}

// Destinataires (exclut les désinscrits) selon genre / recherche / "tous"
function recipientsFor({ genre, recherche, tranche }) {
  let sql = 'SELECT prenom, email FROM inscriptions WHERE COALESCE(unsubscribed,0)=0', args = [];
  if (genre) { sql += ' AND genre=?'; args.push(genre); }
  if (recherche) { sql += ' AND recherche=?'; args.push(recherche); }
  if (tranche && /^\d+-\d+$/.test(tranche)) {
    const [lo, hi] = tranche.split('-').map(Number);
    const age = "(CAST(strftime('%Y','now') AS INTEGER) - annee)";
    sql += ` AND annee IS NOT NULL AND ${age} >= ? AND ${age} < ?`;
    args.push(lo, hi);
  }
  return db.prepare(sql).all(...args);
}

// ---------- Statistiques ----------
function stats() {
  const total = db.prepare('SELECT COUNT(*) n FROM inscriptions').get().n;
  const weekAgo = new Date(Date.now() - 7 * 864e5).toISOString();
  const semaine = db.prepare('SELECT COUNT(*) n FROM inscriptions WHERE created_at >= ?').get(weekAgo).n;
  const desinscrits = db.prepare('SELECT COUNT(*) n FROM inscriptions WHERE COALESCE(unsubscribed,0)=1').get().n;
  const byGenre = db.prepare('SELECT genre, COUNT(*) n FROM inscriptions GROUP BY genre').all();
  const byRech = db.prepare('SELECT recherche, COUNT(*) n FROM inscriptions GROUP BY recherche').all();
  return { total, semaine, desinscrits, byGenre, byRech };
}

// ---------- Compteur de visites (sans cookies, IP anonymisée) ----------
const BOT_RE = /bot|crawl|spider|slurp|bing|googlebot|yandex|baidu|duckduck|facebookexternalhit|embedly|quora|pinterest|preview|monitor|curl|wget|python-requests|axios|headless|lighthouse|uptime|semrush|ahrefs/i;
function refCategory(referer) {
  if (!referer) return 'Direct / QR';
  try {
    const h = new URL(referer).hostname.replace(/^www\./, '');
    if (h.includes('soireematch')) return 'Direct / QR';
    if (h.includes('google')) return 'Google';
    if (h.includes('instagram')) return 'Instagram';
    if (h.includes('facebook') || h.includes('fb.')) return 'Facebook';
    if (h.includes('bing')) return 'Bing';
    return h;
  } catch { return 'Autre'; }
}
function langCategory(al) {
  if (!al) return '—';
  const c = al.split(',')[0].trim().slice(0, 2).toLowerCase();
  return ({ fr: 'Français', en: 'Anglais', de: 'Allemand', it: 'Italien', es: 'Espagnol' })[c] || (c ? c.toUpperCase() : '—');
}
function trackVisit(req, ip) {
  try {
    const ua = req.headers['user-agent'] || '';
    if (!ua || BOT_RE.test(ua)) return;
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    const salt = day + (process.env.SESSION_SECRET || 'sm');
    const vhash = crypto.createHash('sha256').update(ip + '|' + ua + '|' + salt).digest('hex').slice(0, 16);
    const ref = refCategory(req.headers['referer'] || req.headers['referrer'] || '');
    const lang = langCategory(req.headers['accept-language'] || '');
    db.prepare('INSERT INTO pageviews(created_at,day,ref,lang,vhash) VALUES(?,?,?,?,?)').run(now.toISOString(), day, ref, lang, vhash);
  } catch (e) { /* ne jamais casser la page pour une stat */ }
}
function visitStats() {
  const one = (sql, ...a) => db.prepare(sql).get(...a).n;
  const total = one('SELECT COUNT(*) n FROM pageviews');
  const uniques = one('SELECT COUNT(DISTINCT vhash) n FROM pageviews');
  const weekAgo = new Date(Date.now() - 7 * 864e5).toISOString();
  const vues7 = one('SELECT COUNT(*) n FROM pageviews WHERE created_at>=?', weekAgo);
  const uniq7 = one('SELECT COUNT(DISTINCT vhash) n FROM pageviews WHERE created_at>=?', weekAgo);
  const since = new Date(Date.now() - 13 * 864e5).toISOString().slice(0, 10);
  const perDay = db.prepare('SELECT day, COUNT(*) v, COUNT(DISTINCT vhash) u FROM pageviews WHERE day>=? GROUP BY day').all(since);
  const byRef = db.prepare('SELECT ref, COUNT(*) n FROM pageviews GROUP BY ref ORDER BY n DESC').all();
  const byLang = db.prepare('SELECT lang, COUNT(*) n FROM pageviews GROUP BY lang ORDER BY n DESC').all();
  return { total, uniques, vues7, uniq7, perDay, byRef, byLang };
}
function buildVisitsPanel(v) {
  const map = {}; v.perDay.forEach((r) => { map[r.day] = r; });
  const days = [];
  for (let i = 13; i >= 0; i--) days.push(new Date(Date.now() - i * 864e5).toISOString().slice(0, 10));
  const maxv = Math.max(1, ...days.map((d) => (map[d] ? map[d].v : 0)));
  const bw = 22, gap = 6, h = 70;
  const bars = days.map((d, i) => {
    const val = map[d] ? map[d].v : 0;
    const bh = Math.round((val / maxv) * (h - 14));
    const x = i * (bw + gap);
    return `<g><rect x="${x}" y="${h - bh}" width="${bw}" height="${bh}" rx="3" fill="var(--accent)"></rect>`
      + (val ? `<text x="${x + bw / 2}" y="${h - bh - 3}" text-anchor="middle" font-size="9" fill="#666">${val}</text>` : '')
      + `<text x="${x + bw / 2}" y="${h + 11}" text-anchor="middle" font-size="8" fill="#999">${d.slice(8)}</text></g>`;
  }).join('');
  const chart = `<svg width="100%" viewBox="0 0 ${days.length * (bw + gap)} ${h + 16}" style="max-width:430px;display:block">${bars}</svg>`;
  const li = (label, n) => `<div style="display:flex;justify-content:space-between;gap:16px;font-size:.85rem;padding:3px 0"><span>${esc(label)}</span><b>${n}</b></div>`;
  const refTable = v.byRef.map((r) => li(r.ref || 'Autre', r.n)).join('') || '<div style="color:#999">—</div>';
  const langTable = v.byLang.map((r) => li(r.lang || '—', r.n)).join('') || '<div style="color:#999">—</div>';
  return `<div style="background:#fff;border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin-bottom:14px">
    <div style="font-weight:700;margin-bottom:10px">📊 Visites du site <span style="font-weight:400;color:#999;font-size:.8rem">— hors robots, sans cookies</span></div>
    <div class=cards style="margin-bottom:10px">
      <div class=card><div class=n>${v.total}</div><div class=l>Vues totales</div></div>
      <div class=card><div class=n>${v.uniques}</div><div class=l>Visiteurs uniques</div></div>
      <div class=card><div class=n>${v.vues7}</div><div class=l>Vues (7 j)</div></div>
      <div class=card><div class=n>${v.uniq7}</div><div class=l>Uniques (7 j)</div></div>
    </div>
    <div style="font-size:.8rem;color:#666;margin-bottom:4px">Vues par jour (14 derniers jours)</div>
    ${chart}
    <div style="display:flex;gap:32px;flex-wrap:wrap;margin-top:12px">
      <div style="min-width:180px"><div style="font-weight:600;font-size:.85rem;margin-bottom:4px;border-bottom:1px solid var(--line);padding-bottom:3px">Provenance</div>${refTable}</div>
      <div style="min-width:180px"><div style="font-weight:600;font-size:.85rem;margin-bottom:4px;border-bottom:1px solid var(--line);padding-bottom:3px">Langue du navigateur</div>${langTable}</div>
    </div>
  </div>`;
}

// ---------- Static ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml; charset=utf-8', '.webmanifest': 'application/manifest+json' };
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
  label{display:block;margin:14px 0 5px;font-weight:600;font-size:.9rem}
  textarea{font:inherit;width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:8px}
  a.back{display:inline-block;margin-bottom:8px;color:var(--accent);text-decoration:none}
  .panel{background:#fff;border:1px solid var(--line);border-radius:12px;padding:22px;max-width:620px}
  .hint{font-size:.82rem;color:var(--muted)}
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
  const fg = query.genre || '', fr = query.recherche || '', fl = query.langue || '', ft = query.tranche || '';
  let sql = 'SELECT * FROM inscriptions WHERE 1=1', args = [];
  if (q) { sql += ' AND (prenom LIKE ? OR nom LIKE ? OR email LIKE ?)'; const l = `%${q}%`; args.push(l, l, l); }
  if (fg) { sql += ' AND genre = ?'; args.push(fg); }
  if (fr) { sql += ' AND recherche = ?'; args.push(fr); }
  if (fl) { sql += ' AND langues LIKE ?'; args.push(`%${fl}%`); }
  if (/^\d+-\d+$/.test(ft)) { const [lo, hi] = ft.split('-').map(Number); const age = "(CAST(strftime('%Y','now') AS INTEGER) - annee)"; sql += ` AND annee IS NOT NULL AND ${age} >= ? AND ${age} < ?`; args.push(lo, hi); }
  sql += ' ORDER BY id DESC';
  const rows = db.prepare(sql).all(...args);
  const s = stats();
  const opt = (v, cur) => `<option${v === cur ? ' selected' : ''}>${esc(v)}</option>`;
  const genreCards = s.byGenre.map((g) => `<div class=card><div class=n>${g.n}</div><div class=l>${esc(g.genre || '—')}</div></div>`).join('');
  const camp = lastCampaign ? `<div style="background:#fff;border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin-bottom:14px;font-size:.9rem">✉ Dernier envoi « ${esc(lastCampaign.subject)} » — ${lastCampaign.sent}/${lastCampaign.total} envoyés${lastCampaign.failed ? `, ${lastCampaign.failed} échec(s)` : ''}${lastCampaign.running ? ' <b>(en cours…)</b>' : ''}.</div>` : '';

  const trs = rows.map((r) => `<tr>
    <td><input type=checkbox name=ids value=${r.id} form=act></td>
    <td>${esc(r.created_at.slice(0, 10))}</td>
    <td>${esc(r.prenom)}</td><td>${esc(r.nom)}</td>
    <td><a href="mailto:${esc(r.email)}">${esc(r.email)}</a>${r.unsubscribed ? ' <span title="Désinscrit" style="color:#c0392b">🚫</span>' : ''}</td>
    <td>${esc(r.tel)}</td><td>${esc(r.annee)}</td>
    <td>${esc(r.genre)}</td><td>${esc(r.recherche)}</td>
    <td>${esc(r.langues || '')}</td>
    <td><a href="/admin/edit?id=${r.id}">Éditer</a></td>
  </tr>`).join('');

  return `<!doctype html><html lang=fr><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
  <title>Inscriptions — Soirée Match</title><style>${CSS}</style>
  <header><b>Soirée Match — Inscriptions</b><span><a href=/admin/soirees>Soirées</a> &nbsp;·&nbsp; <a href=/admin/logout>Déconnexion</a></span></header>
  <div class=wrap>
    <div class=cards>
      <div class=card><div class=n>${s.total}</div><div class=l>Total</div></div>
      <div class=card><div class=n>${s.semaine}</div><div class=l>Cette semaine</div></div>
      ${genreCards}
      <div class=card><div class=n>${s.desinscrits}</div><div class=l>Désinscrits</div></div>
    </div>
    ${buildVisitsPanel(visitStats())}
    ${camp}

    <form class=filters method=get action=/admin>
      <input name=q value="${esc(q)}" placeholder="Rechercher nom / e-mail…">
      <select name=genre><option value="">Tous genres</option>${['Femme', 'Homme', 'Non binaire'].map((v) => opt(v, fg)).join('')}</select>
      <select name=recherche><option value="">Toutes recherches</option>${['Des hommes', 'Des femmes', 'Les deux'].map((v) => opt(v, fr)).join('')}</select>
      <select name=langue><option value="">Toutes langues</option>${['Français', 'Anglais', 'Espagnol', 'Allemand', 'Italien'].map((v) => opt(v, fl)).join('')}</select>
      <select name=tranche><option value="">Tous âges</option>${['20-30', '30-40', '40-50', '50-60'].map((v) => `<option value="${v}"${v === ft ? ' selected' : ''}>${v} ans</option>`).join('')}</select>
      <button>Filtrer</button>
      <a href=/admin><button type=button class=sec>Réinitialiser</button></a>
    </form>

    <form id=act method=post></form>
    <div class=bar>
      <a href="/admin/compose"><button type=button>✉ Écrire aux inscrits</button></a>
      <button form=act formaction=/admin/export>⬇ Exporter la sélection (CSV)</button>
      <a href="/admin/export?all=1${q || fg || fr || fl || ft ? '&q=' + encodeURIComponent(q) + '&genre=' + encodeURIComponent(fg) + '&recherche=' + encodeURIComponent(fr) + '&langue=' + encodeURIComponent(fl) + '&tranche=' + encodeURIComponent(ft) : ''}"><button type=button class=sec>⬇ Exporter tout (filtré)</button></a>
      <button form=act formaction=/admin/delete class=danger onclick="return confirm('Supprimer les inscriptions sélectionnées ?')">🗑 Supprimer la sélection</button>
    </div>

    ${rows.length ? `<table>
      <tr><th><input type=checkbox onclick="document.querySelectorAll('input[name=ids]').forEach(c=>c.checked=this.checked)"></th>
      <th>Date</th><th>Prénom</th><th>Nom</th><th>E-mail</th><th>Tél</th><th>Année</th><th>Genre</th><th>Recherche</th><th>Langues</th><th>Actions</th></tr>
      ${trs}
    </table>` : `<div class=empty>Aucune inscription pour l'instant.</div>`}
  </div></html>`;
}

function toCSV(rows) {
  const cols = ['id', 'created_at', 'prenom', 'nom', 'email', 'tel', 'annee', 'genre', 'recherche', 'langues'];
  const q = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const lines = [cols.join(',')];
  rows.forEach((r) => lines.push(cols.map((c) => q(r[c])).join(',')));
  return '﻿' + lines.join('\r\n'); // BOM pour Excel
}

const pageHead = (title) => `<!doctype html><html lang=fr><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>${title}</title><style>${CSS}</style><header><b>Soirée Match — Admin</b><span><a href=/admin>Inscriptions</a> &nbsp;·&nbsp; <a href=/admin/soirees>Soirées</a> &nbsp;·&nbsp; <a href=/admin/logout>Déconnexion</a></span></header>`;

// Pages publiques (réservation, désinscription)
const PUB_CSS = `body{font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;margin:0;background:#ecf4f3;color:#1e2f30;line-height:1.6}
.box{max-width:540px;margin:6vh auto;background:#fff;border:1px solid #d3e5e2;border-radius:16px;padding:28px}
.box h1{margin:0 0 4px;font-size:1.5rem}.muted{color:#566b6a}
label{display:block;font-weight:600;font-size:.9rem;margin:14px 0 5px}
input,select{width:100%;padding:12px 14px;border:1px solid #d3e5e2;border-radius:10px;font:inherit;background:#fff;color:#1e2f30}
.btn{display:block;width:100%;margin-top:22px;background:#2f7d8a;color:#fff;border:0;border-radius:40px;padding:15px;font-weight:600;font-size:1.05rem;cursor:pointer}
.facts{display:flex;gap:20px;flex-wrap:wrap;margin:16px 0;padding:14px 0;border-top:1px solid #eee;border-bottom:1px solid #eee}
.facts b{display:block;font-size:1.05rem;color:#2f7d8a}.facts span{font-size:.8rem;color:#566b6a}
.consent{display:flex;gap:9px;align-items:flex-start;font-size:.85rem;color:#566b6a;margin-top:16px}
.consent input{width:auto}
.soi{display:flex;justify-content:space-between;align-items:center;gap:14px;border:1px solid #d3e5e2;border-radius:14px;padding:16px 18px;margin-top:14px;flex-wrap:wrap}
.soi .info b{font-size:1.1rem}
.tag{display:inline-block;background:#eef5f3;color:#2f7d8a;border-radius:20px;padding:2px 10px;font-size:.75rem;font-weight:600;margin-left:6px}
.soi form{margin:0}
.soi .btn{width:auto;margin:0;padding:12px 22px;white-space:nowrap}
a{color:#2f7d8a}`;
const siteHead = (title) => `<!doctype html><html lang=fr><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>${title}</title><style>${PUB_CSS}</style>`;
const pubMsg = (title, html) => `${siteHead(title)}<div class=box><h1>${esc(title)}</h1><p>${html}</p></div></html>`;

function soireePage(so, err) {
  const opt = (v) => `<option>${esc(v)}</option>`;
  return `${siteHead('Réserver — Soirée Match')}
  <div class=box>
    <h1>Soirée Match 💛</h1>
    <p class=muted>Réserve ta place pour la prochaine soirée</p>
    <div class=facts>
      ${so.date_texte ? `<div><b>${esc(so.date_texte)}</b><span>Quand</span></div>` : ''}
      ${so.lieu ? `<div><b>${esc(so.lieu)}</b><span>Où</span></div>` : ''}
      ${so.prix ? `<div><b>${esc(so.prix)}</b><span>Entrée</span></div>` : ''}
    </div>
    ${err ? `<p style="color:#c0392b">${esc(err)}</p>` : ''}
    <form method=post action="/soiree/${esc(so.code)}">
      <label>Prénom</label><input name=prenom required>
      <label>Nom</label><input name=nom required>
      <label>E-mail</label><input type=email name=email required>
      <label>Téléphone mobile</label><input name=tel required>
      <label>Année de naissance</label><input name=annee type=number min=1930 max=2010 placeholder="ex. 1990" required>
      <label>Je suis</label><select name=genre required><option value="">—</option>${['Femme', 'Homme'].map(opt).join('')}</select>
      <label>Je m'intéresse à</label><select name=recherche required><option value="">—</option><option>Des hommes</option><option>Des femmes</option></select>
      <div style="position:absolute;left:-9999px" aria-hidden=true><input name=website tabindex=-1 autocomplete=off></div>
      <label class=consent><input type=checkbox name=consent required> J'accepte que mes données soient conservées pour gérer ma réservation et m'informer des prochaines soirées.</label>
      <button class=btn>Je réserve ma place</button>
    </form>
  </div></html>`;
}
function soireeOkPage(so) {
  return `${siteHead('Réservation confirmée')}<div class=box><h1>C'est réservé ✓</h1><p>Ta place pour la Soirée Match${so.date_texte ? ` du ${esc(so.date_texte)}` : ''} est bien enregistrée. Tu vas recevoir un e-mail de confirmation. On a hâte de te voir&nbsp;! 💛</p></div></html>`;
}

function choisirPage(person) {
  const prenom = (person.prenom || '').trim() || 'à toi';
  const tok = resaToken(person.email);
  const soirees = matchingSoirees(person);
  const cards = soirees.map((s) => `
    <div class=soi>
      <div class=info>
        <b>${esc(s.date_texte || s.code)}</b>${s.type ? `<span class=tag>${esc(s.type)}</span>` : ''}${s.tranche ? `<span class=tag>${esc(s.tranche)} ans</span>` : ''}
        ${s.lieu ? `<div class=muted>${esc(s.lieu)}</div>` : ''}${s.prix ? `<div class=muted>Entrée : ${esc(s.prix)}</div>` : ''}
      </div>
      <form method=post action=/reserver/confirm>
        <input type=hidden name=e value="${esc(person.email)}">
        <input type=hidden name=t value="${esc(tok)}">
        <input type=hidden name=soiree value="${s.id}">
        <button class=btn>Je réserve ma place</button>
      </form>
    </div>`).join('');
  return `${siteHead('Choisis ta soirée — Soirée Match')}
  <div class=box>
    <h1>Bonjour ${esc(prenom)} 👋</h1>
    <p class=muted>Voici les soirées qui te correspondent. Clique pour réserver ta place — rien à retaper.</p>
    ${soirees.length ? cards : '<p style="margin-top:16px">Pas encore de soirée ouverte pour ton profil — on te préviendra dès qu\'une date est fixée&nbsp;! 💛</p>'}
  </div></html>`;
}

function soireesPage() {
  const list = db.prepare('SELECT s.*, (SELECT COUNT(*) FROM reservations r WHERE r.soiree_id=s.id) resa FROM soirees s ORDER BY s.id DESC').all();
  const rows = list.map((s) => `<tr>
    <td><b>${esc(s.code)}</b></td><td>${esc(s.date_texte)}</td><td>${esc(s.lieu)}</td><td>${esc(s.prix)}</td><td>${esc(s.type || '—')}</td><td>${esc(s.tranche || '—')}</td>
    <td>${s.actif ? '✅' : '—'}</td><td>${s.resa}</td>
    <td><a href="${soireeLink(s.code)}" target=_blank>Lien</a> · <a href="/admin/soirees/reservations?id=${s.id}">Réservations</a> · <a href="/admin/soirees/edit?id=${s.id}">Éditer</a></td>
  </tr>`).join('');
  return `${pageHead('Soirées')}
  <div class=wrap>
    <a class=back href="/admin">← Retour aux inscriptions</a>
    <h2>Soirées</h2>
    <form class=panel method=post action=/admin/soirees>
      <div style="display:flex;gap:12px;flex-wrap:wrap">
        <span style="flex:1;min-width:150px"><label>Code (court, sans espace)</label><input name=code required placeholder="ex. aout10" style="width:100%"></span>
        <span style="flex:2;min-width:200px"><label>Date (texte libre)</label><input name=date_texte placeholder="ex. 10 août à 20h30" style="width:100%"></span>
      </div>
      <label>Lieu</label><input name=lieu placeholder="ex. Bar Le Dancing, Bd des Roches 19, 1006 Lausanne" style="width:100%">
      <label>Prix</label><input name=prix placeholder="ex. 20 CHF" style="width:100%">
      <div style="display:flex;gap:12px;flex-wrap:wrap">
        <span style="flex:1;min-width:150px"><label>Type</label><select name=type style="width:100%"><option value="">—</option>${TYPES.map((v) => `<option>${v}</option>`).join('')}</select></span>
        <span style="flex:1;min-width:150px"><label>Tranche d'âge</label><select name=tranche style="width:100%"><option value="">—</option>${TRANCHES.map((v) => `<option>${v}</option>`).join('')}</select></span>
      </div>
      <p class=hint>Type + tranche d'âge servent au routage : chaque inscrit ne verra que les soirées qui le concernent.</p>
      <label style="display:flex;gap:8px;align-items:center;margin-top:12px"><input type=checkbox name=actif checked style="width:auto"> Active (réservations ouvertes)</label>
      <div style="margin-top:14px"><button>Créer la soirée</button></div>
    </form>
    ${list.length ? `<table style="margin-top:18px">
      <tr><th>Code</th><th>Date</th><th>Lieu</th><th>Prix</th><th>Type</th><th>Âge</th><th>Active</th><th>Résa</th><th>Actions</th></tr>${rows}</table>`
      : `<div class=empty>Aucune soirée. Crée la première ci-dessus, puis mets son <b>{lien}</b> dans un e-mail.</div>`}
  </div></html>`;
}
function soireeEditPage(s) {
  return `${pageHead('Éditer la soirée')}
  <div class=wrap>
    <a class=back href="/admin/soirees">← Retour aux soirées</a>
    <h2>Éditer la soirée</h2>
    <form class=panel method=post action=/admin/soirees/edit>
      <input type=hidden name=id value=${s.id}>
      <label>Code</label><input name=code value="${esc(s.code)}" required style="width:100%">
      <label>Date</label><input name=date_texte value="${esc(s.date_texte)}" style="width:100%">
      <label>Lieu</label><input name=lieu value="${esc(s.lieu)}" style="width:100%">
      <label>Prix</label><input name=prix value="${esc(s.prix)}" style="width:100%">
      <label>Type</label><select name=type style="width:100%"><option value="">—</option>${TYPES.map((v) => `<option${v === s.type ? ' selected' : ''}>${v}</option>`).join('')}</select>
      <label>Tranche d'âge</label><select name=tranche style="width:100%"><option value="">—</option>${TRANCHES.map((v) => `<option${v === s.tranche ? ' selected' : ''}>${v}</option>`).join('')}</select>
      <label style="display:flex;gap:8px;align-items:center;margin-top:12px"><input type=checkbox name=actif ${s.actif ? 'checked' : ''} style="width:auto"> Active</label>
      <div style="margin-top:14px"><button>Enregistrer</button> <a href="/admin/soirees"><button type=button class=sec>Annuler</button></a></div>
    </form>
    <form class=panel method=post action=/admin/soirees/delete onsubmit="return confirm('Supprimer cette soirée ET ses réservations ?')" style="margin-top:14px;border-color:#e0b4b0">
      <input type=hidden name=id value=${s.id}>
      <button class=danger>🗑 Supprimer la soirée</button>
      <span class=hint>&nbsp;Supprime aussi ses réservations.</span>
    </form>
  </div></html>`;
}
function reservationsPage(s) {
  const list = db.prepare('SELECT * FROM reservations WHERE soiree_id=? ORDER BY id DESC').all(s.id);
  const g = {}; list.forEach((r) => { g[r.genre] = (g[r.genre] || 0) + 1; });
  const rows = list.map((r) => `<tr><td>${esc(r.created_at.slice(0, 10))}</td><td>${esc(r.prenom)}</td><td>${esc(r.nom)}</td><td><a href="mailto:${esc(r.email)}">${esc(r.email)}</a></td><td>${esc(r.tel)}</td><td>${esc(r.annee)}</td><td>${esc(r.genre)}</td><td>${esc(r.recherche)}</td><td style="text-align:center">${!PAY_ON ? '—' : (r.paid ? '✅' : '⏳')}</td></tr>`).join('');
  return `${pageHead('Réservations')}
  <div class=wrap>
    <a class=back href="/admin/soirees">← Retour aux soirées</a>
    <h2>Réservations — ${esc(s.date_texte || s.code)}</h2>
    <div class=cards>
      <div class=card><div class=n>${list.length}</div><div class=l>Total</div></div>${PAY_ON ? `<div class=card><div class=n>${list.filter((r) => r.paid).length}</div><div class=l>Payées</div></div>` : ''}
      <div class=card><div class=n>${g['Femme'] || 0}</div><div class=l>Femmes</div></div>
      <div class=card><div class=n>${g['Homme'] || 0}</div><div class=l>Hommes</div></div>
      <div class=card><div class=n>${g['Non binaire'] || 0}</div><div class=l>Non binaire</div></div>
    </div>
    <div class=bar><a href="/admin/soirees/reservations/export?id=${s.id}"><button type=button>⬇ Exporter (CSV)</button></a></div>
    ${list.length ? `<table><tr><th>Date</th><th>Prénom</th><th>Nom</th><th>E-mail</th><th>Tél</th><th>Année</th><th>Genre</th><th>Recherche</th><th>Payé</th></tr>${rows}</table>`
      : `<div class=empty>Aucune réservation pour l'instant.</div>`}
  </div></html>`;
}

// ---------- Modèles d'e-mails ----------
const PRATIQUE = `📍 {lieu}
🎟️ Entrée : 20 CHF

Un petit mot qui compte : la salle nous est gentiment offerte par le bar. Alors on compte sur toi pour commander un verre ou deux et leur faire honneur — c'est aussi excellent pour le courage 😉. Les consommations sont à ta charge.

Au programme : des jeux intelligents pour se découvrir, se comprendre vraiment et briser la glace, de la musique, quelques fous rires, et surtout de vraies rencontres humaines autour d'un verre — sans applis, sans rejet, sans faux-semblants.

👉 {reserver}`;

const SIGNOFF = `On a hâte de te (re)voir. Belle semaine à toi !

Ta team Soirée Match 💛`;

const TEMPLATES = [
  {
    name: 'Général — prochaine soirée (tous)',
    subject: '💛 La prochaine Soirée Match, c\'est le {date} — tu viens ?',
    body: `Bonjour {prenom},

Bonne nouvelle : la date de la prochaine Soirée Match est tombée ! On t'attend le {date}.

${PRATIQUE}

${SIGNOFF}`,
  },
  {
    name: 'Hommes → cherchent une femme',
    subject: '{prenom}, et si c\'était le {date} ?',
    body: `Bonjour {prenom},

La prochaine Soirée Match approche, et c'est l'occasion rêvée de faire de belles rencontres en vrai. Des femmes intéressantes et bienveillantes seront présentes le {date} — laisse les applis de côté et viens tenter ta chance. Pas besoin d'être un grand séducteur : nos jeux s'occupent de briser la glace pour toi, tu n'as qu'à venir avec le sourire.

${PRATIQUE}

${SIGNOFF}`,
  },
  {
    name: 'Femmes → cherchent un homme',
    subject: '{prenom}, une soirée pensée pour de vraies rencontres — le {date}',
    body: `Bonjour {prenom},

On aimerait beaucoup te voir à la prochaine Soirée Match, le {date}. On met un point d'honneur à créer un cadre respectueux et bienveillant, avec des hommes venus pour de vraies rencontres — et une soirée animée par un thérapeute pour que chacune se sente à l'aise. Tu viens comme tu es, on s'occupe du reste.

${PRATIQUE}

${SIGNOFF}`,
  },
  {
    name: 'Rencontres gay — entre hommes',
    subject: '{prenom}, Soirée Match entre hommes : rendez-vous le {date}',
    body: `Bonjour {prenom},

La prochaine Soirée Match dédiée aux rencontres entre hommes arrive : le {date}. Une soirée décontractée pour se rencontrer en vrai, rire et créer des liens — loin des applis et de leurs déceptions.

${PRATIQUE}

${SIGNOFF}`,
  },
  {
    name: 'Rencontres gay — entre femmes',
    subject: '{prenom}, Soirée Match entre femmes : rendez-vous le {date}',
    body: `Bonjour {prenom},

La prochaine Soirée Match dédiée aux rencontres entre femmes arrive : le {date}. Une soirée chaleureuse et bienveillante pour se rencontrer en vrai, échanger et faire de belles rencontres — sans applis, sans faux-semblants.

${PRATIQUE}

${SIGNOFF}`,
  },
];

function composePage() {
  const s = stats();
  const byG = Object.fromEntries(s.byGenre.map((g) => [g.genre, g.n]));
  const byR = Object.fromEntries(s.byRech.map((r) => [r.recherche, r.n]));
  const opt = (v) => `<option>${esc(v)}</option>`;
  const off = !transporter;
  const soirees = db.prepare('SELECT code,date_texte FROM soirees WHERE actif=1 ORDER BY id DESC').all();
  return `${pageHead('Écrire aux inscrits')}
  <div class=wrap>
    <a class=back href="/admin">← Retour aux inscriptions</a>
    <h2>Écrire aux inscrits</h2>
    ${off ? '<div class=panel style="border-color:#e0b4b0;color:#c0392b">⚠ L\'envoi d\'e-mails est désactivé (MAIL_USER / MAIL_PASS non définis dans Coolify).</div>' : ''}
    <form class=panel method=post action=/admin/send onsubmit="return confirm('Envoyer cet e-mail au segment choisi ?')">
      <label>Modèle</label>
      <select id=tpl><option value="-1">— Partir d'un modèle… —</option>${TEMPLATES.map((t, i) => `<option value=${i}>${esc(t.name)}</option>`).join('')}</select>
      <p class=hint>Choisis un modèle pour pré-remplir l'objet et le message ci-dessous ; tu pourras ensuite l'ajuster (date, lieu…).</p>

      <label>À qui ?</label>
      <div style="display:flex;gap:10px;flex-wrap:wrap">
        <span>Genre <select name=genre><option value="">Tous</option>${['Femme', 'Homme', 'Non binaire'].map(opt).join('')}</select></span>
        <span>Intéressé(e) par <select name=recherche><option value="">Peu importe</option>${['Des hommes', 'Des femmes', 'Les deux'].map(opt).join('')}</select></span>
        <span>Tranche d'âge <select name=tranche><option value="">Toutes</option>${['20-30', '30-40', '40-50', '50-60'].map((v) => `<option value="${v}">${v} ans</option>`).join('')}</select></span>
      </div>
      <p class=hint>Laisse « Tous » + « Peu importe » pour écrire à <b>tout le monde</b>. Repères : Femmes ${byG['Femme'] || 0} · Hommes ${byG['Homme'] || 0} · Non binaire ${byG['Non binaire'] || 0} — cherche : hommes ${byR['Des hommes'] || 0}, femmes ${byR['Des femmes'] || 0}, les deux ${byR['Les deux'] || 0}. (Les désinscrits sont exclus automatiquement.)</p>

      <label>Soirée liée <span class=hint>(le {lien} du message pointera vers sa page de réservation)</span></label>
      <select name=soiree><option value="">— Aucune (le lien mène au site ${esc(SITE_URL)}) —</option>${soirees.map((s) => `<option value="${esc(s.code)}">${esc(s.date_texte || s.code)} (${esc(s.code)})</option>`).join('')}</select>

      <label>Objet</label>
      <input id=subject name=subject required style="width:100%" placeholder="Ex. La prochaine Soirée Match approche !">
      <label>Message</label>
      <textarea id=body name=body rows=14 required placeholder="Bonjour {prenom},&#10;&#10;…"></textarea>
      <p class=hint>Repères : <b>{prenom}</b> = le prénom de chacun · <b>{reserver}</b> = bouton personnalisé « Je réserve ma place » (chaque personne arrive sur une page qui lui montre <b>automatiquement les soirées qui la concernent</b> selon son âge, son sexe et qui elle cherche — réservation en un clic). <b>{lien}</b> = un lien fixe vers la soirée liée ci-dessus, ou le site. <b>{date}</b> et <b>{lieu}</b> = la date et le lieu de la soirée liée (se remplissent tout seuls). Un lien de désinscription est ajouté automatiquement en bas.</p>
      <div style="margin-top:14px"><button ${off ? 'disabled' : ''}>Envoyer</button></div>
    </form>
  </div>
  <script>
    const TPL = ${JSON.stringify(TEMPLATES)};
    document.getElementById('tpl').addEventListener('change', function(e){
      const i = +e.target.value; if (i < 0) return;
      const subj = document.getElementById('subject'), body = document.getElementById('body');
      if ((subj.value || body.value) && !confirm('Remplacer l\\'objet et le message par ce modèle ?')) { e.target.value = '-1'; return; }
      subj.value = TPL[i].subject; body.value = TPL[i].body;
    });
  </script></html>`;
}

function editPage(r) {
  const opt = (v, cur) => `<option${v === cur ? ' selected' : ''}>${esc(v)}</option>`;
  return `${pageHead('Éditer une inscription')}
  <div class=wrap>
    <a class=back href="/admin">← Retour aux inscriptions</a>
    <h2>Éditer une inscription</h2>
    <form class=panel method=post action=/admin/edit>
      <input type=hidden name=id value=${r.id}>
      <label>Prénom</label><input name=prenom value="${esc(r.prenom)}" style="width:100%">
      <label>Nom</label><input name=nom value="${esc(r.nom)}" style="width:100%">
      <label>E-mail</label><input name=email value="${esc(r.email)}" style="width:100%">
      <label>Téléphone</label><input name=tel value="${esc(r.tel)}" style="width:100%">
      <label>Année de naissance</label><input name=annee value="${esc(r.annee)}" style="width:100%">
      <label>Genre</label><select name=genre>${['Femme', 'Homme', 'Non binaire'].map((v) => opt(v, r.genre)).join('')}</select>
      <label>Intéressé(e) par</label><select name=recherche>${['Des hommes', 'Des femmes', 'Les deux'].map((v) => opt(v, r.recherche)).join('')}</select>
      <label style="display:flex;gap:8px;align-items:center"><input type=checkbox name=unsub ${r.unsubscribed ? 'checked' : ''} style="width:auto"> Désinscrit (ne plus lui envoyer d'e-mails)</label>
      <div style="margin-top:16px"><button>Enregistrer</button> <a href="/admin"><button type=button class=sec>Annuler</button></a></div>
    </form>
  </div></html>`;
}

function unsubPage(ok) {
  return ok
    ? pubMsg('C\'est fait ✓', 'Tu ne recevras plus d\'e-mails de la Soirée Match. Si c\'était une erreur, écris-nous à contact@soireematch.com.')
    : pubMsg('Lien invalide', 'Ce lien de désinscription n\'est pas valide. Écris-nous à contact@soireematch.com et on s\'en occupe.');
}

// ---------- Serveur ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (req.method === 'GET' && (p === '/' || p === '/index.html')) trackVisit(req, ip);

  // API publique : inscription
  if (p === '/api/inscription' && req.method === 'POST') {
    const d = parseForm(await readBody(req));
    if (d.website) return json(res, 200, { ok: true });          // honeypot rempli = bot
    if (rateLimited(ip)) return json(res, 429, { ok: false, error: 'Trop de tentatives, réessayez dans une minute.' });
    const prenom = (d.prenom || '').trim(), nom = (d.nom || '').trim(), email = (d.email || '').trim();
    const tel = (d.tel || '').trim(), annee = parseInt(d.annee, 10);
    const genre = (d.genre || '').trim(), recherche = (d.recherche || '').trim();
    const langues = (d.langues || '').trim();
    const consent = (d.consent === 'on' || d.consent === true || d.consent === '1') ? 1 : 0;
    if (!prenom || !nom || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !tel ||
        !(annee >= 1930 && annee <= new Date().getFullYear()) || !genre || !recherche || !consent) {
      return json(res, 400, { ok: false, error: 'Merci de remplir tous les champs correctement (et de cocher le consentement).' });
    }
    db.prepare(`INSERT INTO inscriptions(created_at,prenom,nom,email,tel,annee,genre,recherche,langues,consent,ip,ua)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(new Date().toISOString(), prenom, nom, email, tel, annee, genre, recherche, langues, consent, ip, (req.headers['user-agent'] || '').slice(0, 300));
    sendConfirmation({ prenom, nom, email, tel, annee, genre, recherche, langues });   // envoi non bloquant
    return json(res, 200, { ok: true });
  }

  // Rapport (pour tâche automatique) : /api/stats?token=XXX
  if (p === '/api/stats' && req.method === 'GET') {
    if (!REPORT_TOKEN || url.searchParams.get('token') !== REPORT_TOKEN) return json(res, 401, { ok: false });
    return json(res, 200, stats());
  }

  // Désinscription (lien public dans les e-mails)
  if (p === '/unsub' && req.method === 'GET') {
    const email = url.searchParams.get('e') || '';
    const t = url.searchParams.get('t') || '';
    const good = email ? unsubToken(email) : '';
    const valid = !!good && t.length === good.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(good));
    if (valid) db.prepare('UPDATE inscriptions SET unsubscribed=1 WHERE lower(email)=lower(?)').run(email);
    return send(res, 200, unsubPage(valid));
  }

  // Page de réservation publique : /soiree/CODE
  if (p.startsWith('/soiree/')) {
    const code = decodeURIComponent(p.slice('/soiree/'.length)).replace(/\/.*$/, '').trim();
    const so = getSoiree(code);
    if (req.method === 'GET') {
      if (!so) return send(res, 404, pubMsg('Soirée introuvable', 'Ce lien de réservation n\'existe pas ou plus. Écris-nous à contact@soireematch.com.'));
      if (!so.actif) return send(res, 200, pubMsg('Réservations fermées', 'Les réservations pour cette soirée ne sont pas ouvertes pour le moment.'));
      return send(res, 200, soireePage(so));
    }
    if (req.method === 'POST') {
      if (!so || !so.actif) return send(res, 404, pubMsg('Soirée indisponible', 'Ce lien n\'est plus valable.'));
      const d = parseForm(await readBody(req));
      if (d.website) return send(res, 200, soireeOkPage(so));   // honeypot
      if (rateLimited(ip)) return send(res, 429, soireePage(so, 'Trop de tentatives, réessaie dans une minute.'));
      const prenom = (d.prenom || '').trim(), nom = (d.nom || '').trim(), email = (d.email || '').trim();
      const tel = (d.tel || '').trim(), annee = parseInt(d.annee, 10);
      const genre = (d.genre || '').trim(), recherche = (d.recherche || '').trim();
      const consent = (d.consent === 'on' || d.consent === true || d.consent === '1');
      if (!prenom || !nom || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !tel ||
          !(annee >= 1930 && annee <= new Date().getFullYear()) || !genre || !recherche || !consent) {
        return send(res, 200, soireePage(so, 'Merci de remplir tous les champs correctement et de cocher le consentement.'));
      }
      return startReservation(res, so, { prenom, nom, email, tel, annee, genre, recherche });
    }
  }

  // Réservation personnalisée depuis l'e-mail : page « choisis ta soirée » + 1 clic
  if (p === '/reserver' && req.method === 'GET') {
    const email = url.searchParams.get('e') || '';
    const t = url.searchParams.get('t') || '';
    const good = email ? resaToken(email) : '';
    const valid = !!good && t.length === good.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(good));
    const person = valid ? db.prepare('SELECT * FROM inscriptions WHERE lower(email)=lower(?)').get(email) : null;
    if (!person) return send(res, 200, pubMsg('Lien invalide', 'Ce lien de réservation n\'est plus valide. Inscris-toi sur soireematch.com.'));
    return send(res, 200, choisirPage(person));
  }
  if (p === '/reserver/confirm' && req.method === 'POST') {
    const d = parseForm(await readBody(req));
    const email = (d.e || '').trim(), t = String(d.t || '');
    const good = email ? resaToken(email) : '';
    const valid = !!good && t.length === good.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(good));
    const person = valid ? db.prepare('SELECT * FROM inscriptions WHERE lower(email)=lower(?)').get(email) : null;
    const so = getSoireeById(Number(d.soiree));
    if (!person || !so) return send(res, 200, pubMsg('Oups', 'Réservation impossible. Réessaie depuis le lien de ton e-mail.'));
    return startReservation(res, so, { prenom: person.prenom, nom: person.nom, email: person.email, tel: person.tel, annee: person.annee, genre: person.genre, recherche: person.recherche });
  }

  // Paiement Stripe — retour succès / annulation + webhook
  if (p === '/paiement/ok' && req.method === 'GET') {
    const sid = url.searchParams.get('session_id') || '';
    if (sid && PAY_ON) {
      try {
        const sess = await stripeApi('GET', '/v1/checkout/sessions/' + encodeURIComponent(sid), null);
        if (sess && sess.payment_status === 'paid') {
          const resa = db.prepare('SELECT * FROM reservations WHERE stripe_session=?').get(sid);
          if (resa) { markPaidAndConfirm(resa); return send(res, 200, soireeOkPage(getSoireeById(resa.soiree_id) || {})); }
        }
      } catch (e) { console.error('Vérif paiement échouée:', e.message); }
    }
    return send(res, 200, pubMsg('Paiement en cours de confirmation', 'Merci ! Ton paiement est en cours de validation. Tu recevras un e-mail dès que ta place est confirmée.'));
  }
  if (p === '/paiement/annule' && req.method === 'GET') {
    return send(res, 200, pubMsg('Paiement annulé', 'Ta place n\'a pas été confirmée (paiement annulé). Tu peux réessayer depuis le lien de ton e-mail.'));
  }
  if (p === '/api/stripe/webhook' && req.method === 'POST') {
    const raw = await readBody(req);
    if (STRIPE_WH_SECRET && !verifyStripeSig(raw, req.headers['stripe-signature'] || '', STRIPE_WH_SECRET)) return send(res, 400, 'signature invalide');
    let ev = null; try { ev = JSON.parse(raw); } catch {}
    if (ev && ev.type === 'checkout.session.completed') {
      const sid = ev.data && ev.data.object && ev.data.object.id;
      const resa = sid ? db.prepare('SELECT * FROM reservations WHERE stripe_session=?').get(sid) : null;
      if (resa) markPaidAndConfirm(resa);
    }
    return send(res, 200, 'ok');
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
        const q = url.searchParams.get('q') || '', fg = url.searchParams.get('genre') || '', fr = url.searchParams.get('recherche') || '', fl = url.searchParams.get('langue') || '', ft = url.searchParams.get('tranche') || '';
        let sql = 'SELECT * FROM inscriptions WHERE 1=1', args = [];
        if (q) { sql += ' AND (prenom LIKE ? OR nom LIKE ? OR email LIKE ?)'; const l = `%${q}%`; args.push(l, l, l); }
        if (fg) { sql += ' AND genre=?'; args.push(fg); }
        if (fr) { sql += ' AND recherche=?'; args.push(fr); }
        if (fl) { sql += ' AND langues LIKE ?'; args.push(`%${fl}%`); }
        if (/^\d+-\d+$/.test(ft)) { const [lo, hi] = ft.split('-').map(Number); const age = "(CAST(strftime('%Y','now') AS INTEGER) - annee)"; sql += ` AND annee IS NOT NULL AND ${age} >= ? AND ${age} < ?`; args.push(lo, hi); }
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

    // Composer / envoyer un e-mail groupé
    if (p === '/admin/compose' && req.method === 'GET') return send(res, 200, composePage());
    if (p === '/admin/send' && req.method === 'POST') {
      const d = parseForm(await readBody(req));
      const subject = (d.subject || '').trim(), body = (d.body || '').trim();
      const genre = (d.genre || '').trim(), recherche = (d.recherche || '').trim(), tranche = (d.tranche || '').trim();
      if (!transporter || !subject || !body) return send(res, 302, '', { Location: '/admin/compose' });
      const so = (d.soiree || '').trim() ? getSoiree((d.soiree || '').trim()) : null;
      const linkUrl = so ? soireeLink(so.code) : SITE_URL;
      const recips = recipientsFor({ genre, recherche, tranche });
      runCampaign(recips, subject, body, linkUrl, so);   // en arrière-plan (non bloquant)
      return send(res, 302, '', { Location: '/admin' });
    }

    // Gestion des soirées
    if (p === '/admin/soirees' && req.method === 'GET') return send(res, 200, soireesPage());
    if (p === '/admin/soirees' && req.method === 'POST') {
      const d = parseForm(await readBody(req));
      const code = (d.code || '').trim().replace(/\s+/g, '').toLowerCase();
      if (code) {
        try {
          db.prepare('INSERT INTO soirees(code,date_texte,lieu,prix,actif,created_at,type,tranche) VALUES(?,?,?,?,?,?,?,?)')
            .run(code, (d.date_texte || '').trim(), (d.lieu || '').trim(), (d.prix || '').trim(), d.actif ? 1 : 0, new Date().toISOString(), (d.type || '').trim(), (d.tranche || '').trim());
        } catch { /* code déjà utilisé */ }
      }
      return send(res, 302, '', { Location: '/admin/soirees' });
    }
    if (p === '/admin/soirees/edit' && req.method === 'GET') {
      const s = getSoireeById(Number(url.searchParams.get('id')));
      if (!s) return send(res, 302, '', { Location: '/admin/soirees' });
      return send(res, 200, soireeEditPage(s));
    }
    if (p === '/admin/soirees/edit' && req.method === 'POST') {
      const d = parseForm(await readBody(req));
      const id = Number(d.id);
      if (id) try {
        db.prepare('UPDATE soirees SET code=?,date_texte=?,lieu=?,prix=?,actif=?,type=?,tranche=? WHERE id=?')
          .run((d.code || '').trim().replace(/\s+/g, '').toLowerCase(), (d.date_texte || '').trim(), (d.lieu || '').trim(), (d.prix || '').trim(), d.actif ? 1 : 0, (d.type || '').trim(), (d.tranche || '').trim(), id);
      } catch { /* code en conflit */ }
      return send(res, 302, '', { Location: '/admin/soirees' });
    }
    if (p === '/admin/soirees/delete' && req.method === 'POST') {
      const id = Number(parseForm(await readBody(req)).id);
      if (id) { db.prepare('DELETE FROM reservations WHERE soiree_id=?').run(id); db.prepare('DELETE FROM soirees WHERE id=?').run(id); }
      return send(res, 302, '', { Location: '/admin/soirees' });
    }
    if (p === '/admin/soirees/reservations' && req.method === 'GET') {
      const s = getSoireeById(Number(url.searchParams.get('id')));
      if (!s) return send(res, 302, '', { Location: '/admin/soirees' });
      return send(res, 200, reservationsPage(s));
    }
    if (p === '/admin/soirees/reservations/export' && req.method === 'GET') {
      const s = getSoireeById(Number(url.searchParams.get('id')));
      if (!s) return send(res, 302, '', { Location: '/admin/soirees' });
      const rows = db.prepare('SELECT * FROM reservations WHERE soiree_id=? ORDER BY id DESC').all(s.id);
      return send(res, 200, resaCSV(rows), { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="resa-${s.code}.csv"` });
    }

    // Éditer une fiche
    if (p === '/admin/edit' && req.method === 'GET') {
      const id = Number(url.searchParams.get('id'));
      const r = id && db.prepare('SELECT * FROM inscriptions WHERE id=?').get(id);
      if (!r) return send(res, 302, '', { Location: '/admin' });
      return send(res, 200, editPage(r));
    }
    if (p === '/admin/edit' && req.method === 'POST') {
      const d = parseForm(await readBody(req));
      const id = Number(d.id);
      if (id) db.prepare('UPDATE inscriptions SET prenom=?,nom=?,email=?,tel=?,annee=?,genre=?,recherche=?,unsubscribed=? WHERE id=?')
        .run((d.prenom || '').trim(), (d.nom || '').trim(), (d.email || '').trim(), (d.tel || '').trim(),
             parseInt(d.annee, 10) || null, (d.genre || '').trim(), (d.recherche || '').trim(), d.unsub ? 1 : 0, id);
      return send(res, 302, '', { Location: '/admin' });
    }

    return send(res, 404, 'Introuvable');
  }

  // Site statique
  if (req.method === 'GET') return serveStatic(res, req.url);
  send(res, 405, 'Méthode non autorisée');
});

server.listen(PORT, () => console.log(`Soirée Match en écoute sur http://127.0.0.1:${PORT}`));
