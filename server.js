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
// Parité / liste d'attente (Option A)
try { db.exec('ALTER TABLE soirees ADD COLUMN cap_sexe INTEGER DEFAULT 15'); } catch { /* déjà là */ }
try { db.exec('ALTER TABLE soirees ADD COLUMN min_sexe INTEGER DEFAULT 8'); } catch { /* déjà là */ }
try { db.exec('ALTER TABLE soirees ADD COLUMN cap_total INTEGER DEFAULT 30'); } catch { /* déjà là */ }
try { db.exec('ALTER TABLE soirees ADD COLUMN min_total INTEGER DEFAULT 10'); } catch { /* déjà là */ }
try { db.exec('ALTER TABLE soirees ADD COLUMN date_start TEXT'); } catch { /* déjà là */ }
try { db.exec('ALTER TABLE soirees ADD COLUMN annulee INTEGER DEFAULT 0'); } catch { /* déjà là */ }
try { db.exec('ALTER TABLE soirees ADD COLUMN alert72_sent INTEGER DEFAULT 0'); } catch { /* déjà là */ }
try { db.exec('ALTER TABLE soirees ADD COLUMN reconcile_done INTEGER DEFAULT 0'); } catch { /* déjà là */ }
try { db.exec('ALTER TABLE reservations ADD COLUMN status TEXT'); } catch { /* déjà là */ }
try { db.exec('ALTER TABLE reservations ADD COLUMN hold_expires TEXT'); } catch { /* déjà là */ }
try { db.exec('ALTER TABLE reservations ADD COLUMN priority INTEGER DEFAULT 0'); } catch { /* déjà là */ }
try { db.exec('ALTER TABLE reservations ADD COLUMN stripe_payment_intent TEXT'); } catch { /* déjà là */ }
try { db.exec("UPDATE reservations SET status = CASE WHEN COALESCE(paid,0)=1 THEN 'paid' ELSE 'expired' END WHERE status IS NULL"); } catch {}

const getSoiree = (code) => db.prepare('SELECT * FROM soirees WHERE code=?').get(code);
const getSoireeById = (id) => db.prepare('SELECT * FROM soirees WHERE id=?').get(id);
const soireeLink = (code) => `${SITE_URL}/soiree/${encodeURIComponent(code)}`;

// ---------- Routage : lien de réservation personnalisé + correspondance profil → soirées ----------
const TYPES = ['Hétéro', 'Gay hommes', 'Gay femmes'];
const TRANCHES = ['20-30', '30-40', '40-50', '50-60'];
const resaToken = (email) => crypto.createHmac('sha256', SECRET).update('resa:' + String(email).toLowerCase()).digest('base64url');
const resaLink = (email) => `${SITE_URL}/reserver?e=${encodeURIComponent(email)}&t=${resaToken(email)}`;
const resaLinkSoiree = (email, code) => `${SITE_URL}/reserver?e=${encodeURIComponent(email)}&t=${resaToken(email)}&s=${encodeURIComponent(code)}`;

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
function markPaidAndConfirm(resa, paymentIntent) {
  if (!resa) return;
  const fresh = db.prepare('SELECT * FROM reservations WHERE id=?').get(resa.id);
  if (!fresh || fresh.status === 'paid') return;
  const so = getSoireeById(fresh.soiree_id);
  db.prepare("UPDATE reservations SET status='paid', paid=1, stripe_payment_intent=? WHERE id=?").run(paymentIntent || fresh.stripe_payment_intent || null, fresh.id);
  if (!so) return;
  if (so.annulee || so.reconcile_done) {
    // soirée annulée ou déjà réconciliée : on ne peut plus garantir la place -> remboursement
    refundResa({ ...fresh, stripe_payment_intent: paymentIntent || fresh.stripe_payment_intent }, so, so.annulee ? 'annulation' : 'parite');
    return;
  }
  sendReservationMail(so, fresh);
  promote(so);
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
  const email = person.email, genre = person.genre;
  // déjà confirmé ?
  if (db.prepare("SELECT id FROM reservations WHERE soiree_id=? AND lower(email)=lower(?) AND status='paid'").get(so.id, email))
    return send(res, 200, pubMsg('Déjà réservé', 'Ta place pour cette soirée est déjà confirmée. À très vite ! 💛'));
  // un hold en cours ? -> on reprend le paiement
  const hold = db.prepare("SELECT * FROM reservations WHERE soiree_id=? AND lower(email)=lower(?) AND status='hold' AND hold_expires>?").get(so.id, email, nowIso());
  if (hold) {
    if (!PAY_ON) { markPaidAndConfirm(hold); return send(res, 200, soireeOkPage(so)); }
    try { return send(res, 302, '', { Location: await createCheckout(hold.id, so, email) }); }
    catch (e) { return send(res, 200, pubMsg('Paiement momentanément indisponible', 'Réessaie dans un instant.')); }
  }
  // déjà en liste d'attente ?
  if (db.prepare("SELECT id FROM reservations WHERE soiree_id=? AND lower(email)=lower(?) AND status='waiting'").get(so.id, email))
    return send(res, 200, waitlistPage(so));

  // place ouverte pour ce profil ?
  if (!slotOpen(so, genre)) {
    db.prepare("INSERT INTO reservations(soiree_id,prenom,nom,email,tel,annee,genre,recherche,created_at,status,priority,paid) VALUES(?,?,?,?,?,?,?,?,?,'waiting',0,0)")
      .run(so.id, person.prenom, person.nom, email, person.tel, person.annee, genre, person.recherche, nowIso());
    mailWaitlist(so, person);
    return send(res, 200, waitlistPage(so));
  }
  // mode gratuit (pas de Stripe) : on confirme direct
  if (!PAY_ON) {
    db.prepare("INSERT INTO reservations(soiree_id,prenom,nom,email,tel,annee,genre,recherche,created_at,status,priority,paid) VALUES(?,?,?,?,?,?,?,?,?,'paid',0,1)")
      .run(so.id, person.prenom, person.nom, email, person.tel, person.annee, genre, person.recherche, nowIso());
    sendReservationMail(so, person);
    promote(so);
    return send(res, 200, soireeOkPage(so));
  }
  // Stripe : on crée un hold (3h) puis on lance le paiement
  const info = db.prepare("INSERT INTO reservations(soiree_id,prenom,nom,email,tel,annee,genre,recherche,created_at,status,hold_expires,priority,paid) VALUES(?,?,?,?,?,?,?,?,?,'hold',?,0,0)")
    .run(so.id, person.prenom, person.nom, email, person.tel, person.annee, genre, person.recherche, nowIso(), new Date(nowMs() + HOLD_MS).toISOString());
  const rid = Number(info.lastInsertRowid);
  try {
    return send(res, 302, '', { Location: await createCheckout(rid, so, email) });
  } catch (e) {
    console.error('Stripe checkout échoué:', e.message);
    db.prepare("UPDATE reservations SET status='expired' WHERE id=?").run(rid);
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
function eligibleForSoiree(person, so) {
  const types = allowedTypes(person.genre, person.recherche);
  if (!types.length) return false;
  if (so.type && !types.includes(so.type)) return false;
  return trancheOk(so.tranche, ageOf(person.annee));
}
function soireeAudience(so) {
  const t = { 'Hétéro': 'hétéro', 'Gay hommes': 'entre hommes', 'Gay femmes': 'entre femmes' }[so.type] || (so.type || '');
  const parts = [];
  if (so.tranche) parts.push(`${so.tranche} ans (souplesse ±3)`);
  if (t) parts.push(t);
  return parts.length ? 'réservée aux ' + parts.join(' · ') : 'réservée à un autre profil';
}

function sendReservationMail(so, i) {
  if (!transporter) return;
  const prenom = (i.prenom || '').trim() || 'à toi';
  const quand = so.date_texte ? ` du ${so.date_texte}` : '';
  transporter.sendMail({
    from: MAIL_FROM, to: i.email,
    subject: `Ta réservation Soirée Match${so.date_texte ? ` — ${so.date_texte}` : ''} est confirmée 🎉`,
    text: `Bonjour ${prenom},\n\nTa place pour la Soirée Match${quand} est bien réservée !\n${so.lieu ? `\nLieu : ${so.lieu}` : ''}${so.prix ? `\nEntrée : ${so.prix}` : ''}\n\nUn petit mot qui compte : la salle nous est offerte par le bar en échange de nos consommations. Sans cela, le prix d'entrée serait bien plus élevé — alors joue le jeu en consommant sur place tout au long de la soirée. Merci d'avance : c'est grâce à ça que la soirée est possible !\n\nOn a hâte de te voir. À très vite !\nTa team Soirée Match 💛`,
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

async function runCampaign(recipients, subject, body, linkUrl = SITE_URL, so = null, soireesForList = null, forceEligible = false) {
  lastCampaign = { at: new Date().toISOString(), total: recipients.length, sent: 0, failed: 0, running: true, subject };
  const dateTxt = (so && so.date_texte) ? so.date_texte : '';
  const lieuTxt = (so && so.lieu) ? so.lieu : '';
  const manqueTxt = so ? deficitTxt(so) : 'quelques personnes';
  const allSoirees = (soireesForList && soireesForList.length) ? soireesForList : db.prepare('SELECT * FROM soirees WHERE actif=1 ORDER BY id DESC').all();
  for (const r of recipients) {
    const prenom = (r.prenom || '').trim() || 'à toi';
    const unsub = unsubLink(r.email);
    const resa = resaLink(r.email);
    const eligibles = forceEligible ? allSoirees : allSoirees.filter((so2) => eligibleForSoiree(r, so2));
    const aucune = "Aucune date ne correspond à ton profil pour le moment — on t'écrit dès qu'une nouvelle soirée s'ouvre pour toi.";
    const sT = eligibles.length
      ? eligibles.map((so2) => `• ${so2.date_texte || so2.code}${soireeMetaShort(so2) ? ' · ' + soireeMetaShort(so2) : ''}${so2.lieu ? '\n  ' + so2.lieu : ''}\n  👉 Réserver : ${resaLinkSoiree(r.email, so2.code)}`).join('\n\n')
      : aucune;
    const sH = eligibles.length
      ? eligibles.map((so2) => `<div style="background:#ffffff;border:1px solid #57a893;border-left:4px solid #d0aa54;border-radius:10px;padding:14px 16px;margin:14px 0"><div style="font-weight:700;color:#156b54;font-size:16px">${esc(so2.date_texte || so2.code)}</div><div style="color:#5b6b64;font-size:13px;margin:3px 0 12px">${esc(soireeMetaShort(so2))}${so2.lieu ? ' · ' + esc(so2.lieu) : ''}</div><a href="${resaLinkSoiree(r.email, so2.code)}" style="display:inline-block;background:#156b54;color:#ffffff;text-decoration:none;padding:9px 18px;border-radius:22px;font-weight:600;font-size:14px">Réserver ma place</a></div>`).join('')
      : `<div style="margin:12px 0;color:#8a9a99">${esc(aucune)}</div>`;
    const dateR = eligibles.length ? eligibles.map((x) => x.date_texte || x.code).join(' ou le ') : dateTxt;
    const lieuR = eligibles.length ? (eligibles[0].lieu || '') : lieuTxt;
    const rep = (s) => s.replace(/\{pr[ée]nom\}/gi, prenom).replace(/\{lien\}/gi, linkUrl).replace(/\{reserver\}/gi, resa).replace(/\{date\}/gi, dateR).replace(/\{lieu\}/gi, lieuR).replace(/\{manque\}/gi, manqueTxt).replace(/\{soirees\}/gi, sT);
    const subj = rep(subject);
    const txt = rep(body) + `\n\n—\nPour ne plus recevoir ces e-mails : ${unsub}`;
    const btn = `<a href="${resa}" style="display:inline-block;background:#156b54;color:#ffffff;text-decoration:none;padding:12px 26px;border-radius:26px;font-weight:700">Je réserve ma place</a>`;
    const htmlBody = esc(body).replace(/\{pr[ée]nom\}/gi, esc(prenom))
      .replace(/\{lien\}/gi, `<a href="${linkUrl}" style="color:#2f7d8a">${esc(linkUrl)}</a>`)
      .replace(/\{reserver\}/gi, btn)
      .replace(/\{date\}/gi, esc(dateR)).replace(/\{lieu\}/gi, esc(lieuR)).replace(/\{manque\}/gi, esc(manqueTxt))
      .replace(/\{soirees\}/gi, sH)
      .replace(/\n/g, '<br>');
    const html = emailShell(htmlBody, unsub);
    try {
      await transporter.sendMail({ from: MAIL_FROM, to: r.email, subject: subj, text: txt, html,
        headers: {
          'List-Unsubscribe': `<${unsub}>, <mailto:${MAIL_USER}?subject=désinscription>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        } });
      lastCampaign.sent++;
    } catch (e) { lastCampaign.failed++; console.error('Campagne — échec', r.email, e.message); }
    await sleep(300);
  }
  lastCampaign.running = false;
  console.log(`Campagne « ${subject} » : ${lastCampaign.sent}/${lastCampaign.total} envoyés, ${lastCampaign.failed} échecs.`);
}

// Destinataires (exclut les désinscrits) selon genre / recherche / "tous"
function recipientsFor({ genre, recherche, tranche }) {
  let sql = 'SELECT prenom, email, genre, recherche, annee, langues FROM inscriptions WHERE COALESCE(unsubscribed,0)=0', args = [];
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
  if (/^\d+-\d+$/.test(ft)) { const [lo, hi] = ft.split('-').map(Number); const age = "(CAST(strftime('%Y','now') AS INTEGER) - annee)"; sql += ` AND annee IS NOT NULL AND ${age} >= ? AND ${age} <= ?`; args.push(lo - 3, hi + 3); }
  sql += ' ORDER BY id DESC';
  const rows = db.prepare(sql).all(...args);
  const selF = rows.filter((r) => r.genre === 'Femme').length, selH = rows.filter((r) => r.genre === 'Homme').length;
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
      <a href="/admin/test"><button type=button class=sec>🧪 E-mail de test</button></a>
      <button form=act formaction=/admin/export>⬇ Exporter la sélection (CSV)</button>
      <a href="/admin/export?all=1${q || fg || fr || fl || ft ? '&q=' + encodeURIComponent(q) + '&genre=' + encodeURIComponent(fg) + '&recherche=' + encodeURIComponent(fr) + '&langue=' + encodeURIComponent(fl) + '&tranche=' + encodeURIComponent(ft) : ''}"><button type=button class=sec>⬇ Exporter tout (filtré)</button></a>
      <button form=act formaction=/admin/delete class=danger onclick="return confirm('Supprimer les inscriptions sélectionnées ?')">🗑 Supprimer la sélection</button>
    </div>

    <div style="margin:6px 0 12px;padding:10px 14px;background:#eaf3f2;border:1px solid var(--line);border-radius:10px;font-size:.92rem">Sélection affichée : <b>${rows.length}</b> personne(s) — <b>${selF}</b> femme(s) · <b>${selH}</b> homme(s)${ft ? ` <span style=\"color:var(--muted)\">(tranche ${esc(ft)} ans · souplesse ±3)</span>` : ''}</div>
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

function confirmSoireePage(person, so) {
  const tok = resaToken(person.email);
  return `${siteHead('Réserver — Soirée Match')}
  <div class=box>
    <h1>Réserver ta place 💛</h1>
    <div class=facts>
      ${so.date_texte ? `<div><b>${esc(so.date_texte)}</b><span>Quand</span></div>` : ''}
      ${so.lieu ? `<div><b>${esc(so.lieu)}</b><span>Où</span></div>` : ''}
      ${so.prix ? `<div><b>${esc(so.prix)}</b><span>Entrée</span></div>` : ''}
    </div>
    <p class=muted>Clique ci-dessous pour réserver et régler ta place.</p>
    <form method=post action=/reserver/confirm>
      <input type=hidden name=e value="${esc(person.email)}">
      <input type=hidden name=t value="${esc(tok)}">
      <input type=hidden name=soiree value="${so.id}">
      <button class=btn>Je réserve et je paie ma place</button>
    </form>
    <p style="margin-top:14px"><a href="${SITE_URL}/reserver?e=${encodeURIComponent(person.email)}&t=${tok}">Voir toutes les soirées qui me correspondent</a></p>
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
      <label>Code (court, sans espace)</label><input name=code required placeholder="ex. sept22" style="width:100%">
      <label>Lieu</label><input name=lieu value="Happy Days Bar &amp; Gril, rue Saint Pierre 3, Lausanne" style="width:100%">
      <label>Prix</label><input name=prix placeholder="ex. 20 CHF" style="width:100%">
      <div style="display:flex;gap:12px;flex-wrap:wrap">
        <span style="flex:1;min-width:150px"><label>Type</label><select name=type style="width:100%"><option value="">—</option>${TYPES.map((v) => `<option>${v}</option>`).join('')}</select></span>
        <span style="flex:1;min-width:150px"><label>Tranche d'âge</label><select name=tranche style="width:100%"><option value="">—</option>${TRANCHES.map((v) => `<option>${v}</option>`).join('')}</select></span>
      </div>
      <p class=hint>Type + tranche d'âge servent au routage : chaque inscrit ne verra que les soirées qui le concernent.</p>
      <label>Date &amp; heure exactes <span class=hint>(pour rappels &amp; équilibrage auto — sinon pas d'automatisation)</span></label>
      <input type="datetime-local" name="date_start" style="width:100%">
      <div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:8px">
        <span style="flex:1;min-width:110px"><label>Places / sexe</label><input name=cap_sexe type=number value=15 style="width:100%"></span>
        <span style="flex:1;min-width:110px"><label>Min / sexe</label><input name=min_sexe type=number value=8 style="width:100%"></span>
        <span style="flex:1;min-width:110px"><label>Capacité (gay)</label><input name=cap_total type=number value=30 style="width:100%"></span>
      </div>
      <p class=hint>Hétéro : parité stricte, min/sexe puis max/sexe. Gay : capacité totale, sans parité.</p>
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
      <label>Lieu</label><input name=lieu value="${esc(s.lieu)}" style="width:100%">
      <label>Prix</label><input name=prix value="${esc(s.prix)}" style="width:100%">
      <label>Type</label><select name=type style="width:100%"><option value="">—</option>${TYPES.map((v) => `<option${v === s.type ? ' selected' : ''}>${v}</option>`).join('')}</select>
      <label>Tranche d'âge</label><select name=tranche style="width:100%"><option value="">—</option>${TRANCHES.map((v) => `<option${v === s.tranche ? ' selected' : ''}>${v}</option>`).join('')}</select>
      <label>Date &amp; heure exactes</label><input type="datetime-local" name="date_start" value="${s.date_start ? esc(new Date(s.date_start).toISOString().slice(0, 16)) : ''}" style="width:100%">
      <div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:8px">
        <span style="flex:1;min-width:110px"><label>Places / sexe</label><input name=cap_sexe type=number value="${capSexe(s)}" style="width:100%"></span>
        <span style="flex:1;min-width:110px"><label>Min / sexe</label><input name=min_sexe type=number value="${minSexe(s)}" style="width:100%"></span>
        <span style="flex:1;min-width:110px"><label>Capacité (gay)</label><input name=cap_total type=number value="${capTotal(s)}" style="width:100%"></span>
      </div>
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
function reservationsPage(s, done) {
  const list = db.prepare("SELECT * FROM reservations WHERE soiree_id=? ORDER BY (status='paid') DESC, priority DESC, created_at ASC").all(s.id);
  const cnt = (st, g) => list.filter((r) => r.status === st && (!g || r.genre === g)).length;
  const par = isParity(s);
  const lbl = { paid: '✅ payé', hold: '⏳ à confirmer (3h)', waiting: "🕒 liste d'attente", refunded: '↩ remboursé', expired: '✕ expiré', cancelled: '✕ annulé' };
  const rows = list.map((r, i) => `<tr><td>${i + 1}</td><td>${esc((r.created_at || '').slice(0, 16).replace('T', ' '))}</td><td>${esc(r.prenom)}</td><td>${esc(r.nom)}</td><td><a href="mailto:${esc(r.email)}">${esc(r.email)}</a></td><td>${esc(r.genre)}</td><td>${lbl[r.status] || esc(r.status || '')}</td><td>${['paid', 'hold', 'waiting'].includes(r.status) ? `<form method=post action=/admin/soirees/resa/remove style="margin:0" onsubmit="return confirm('Retirer ${esc((r.prenom || '') + ' ' + (r.nom || ''))} ?${r.status === 'paid' ? ' Cette personne sera remboursée.' : ''}')"><input type=hidden name=id value=${r.id}><button class=danger style="padding:4px 10px;font-size:12px">Retirer</button></form>` : ''}</td></tr>`).join('');
  const viable = isViable(s);
  const capLine = par
    ? `Parité stricte — <b>${cnt('paid', 'Femme')}</b> F / <b>${cnt('paid', 'Homme')}</b> H payés · min ${minSexe(s)}/sexe · max ${capSexe(s)}/sexe · ${viable ? '<span style="color:#1c7a3f">✔ viable</span>' : `<span style="color:#c0392b">✘ sous le minimum (manque ${esc(deficitTxt(s))})</span>`}`
    : `Sans parité — <b>${cnt('paid')}</b> payés · capacité ${capTotal(s)} · ${viable ? '<span style="color:#1c7a3f">✔ viable</span>' : '<span style="color:#c0392b">✘ sous le minimum</span>'}`;
  return `${pageHead('Réservations')}
  <div class=wrap>
    <a class=back href="/admin/soirees">← Retour aux soirées</a>
    <h2>Réservations — ${esc(s.date_texte || s.code)}${s.annulee ? ' <span style="color:#c0392b">(ANNULÉE)</span>' : ''}</h2>
    ${done ? '<div class=panel style="border-color:#8fbf8f;background:#eefaee;color:#1c7a3f">✅ Vérifications lancées.</div>' : ''}
    <div class=panel>${capLine}<br>${s.date_start ? `📅 ${esc(formatFr(s.date_start))}` : '<span style="color:#c0392b">⚠ pas de date/heure exacte → aucune automatisation (rappels, annulation, réconciliation)</span>'}</div>
    <div class=cards>
      <div class=card><div class=n>${cnt('paid')}</div><div class=l>Payées</div></div>
      ${par ? `<div class=card><div class=n>${cnt('paid', 'Femme')}</div><div class=l>F payées</div></div><div class=card><div class=n>${cnt('paid', 'Homme')}</div><div class=l>H payées</div></div>` : ''}
      <div class=card><div class=n>${cnt('hold')}</div><div class=l>À confirmer</div></div>
      <div class=card><div class=n>${cnt('waiting')}</div><div class=l>Liste d'attente</div></div>
      <div class=card><div class=n>${cnt('refunded')}</div><div class=l>Remboursées</div></div>
    </div>
    <div class=bar>
      <a href="/admin/soirees/reservations/export?id=${s.id}"><button type=button>⬇ Exporter (CSV)</button></a>
      <form method=post action=/admin/soirees/run-checks style="display:inline"><input type=hidden name=id value=${s.id}><button class=sec>🔄 Lancer les vérifications</button></form>
      ${s.annulee ? '' : `<form method=post action=/admin/soirees/cancel style="display:inline" onsubmit="return confirm('Annuler la soirée et rembourser toutes les places payées ?')"><input type=hidden name=id value=${s.id}><button class=danger>✕ Annuler + rembourser</button></form>`}
    </div>
    ${list.length ? `<table><tr><th>#</th><th>Inscrit</th><th>Prénom</th><th>Nom</th><th>E-mail</th><th>Genre</th><th>Statut</th><th>Action</th></tr>${rows}</table>`
      : `<div class=empty>Aucune réservation pour l'instant.</div>`}
  </div></html>`;
}

// ---------- Modèles d'e-mails ----------
const PRATIQUE = `📍 {lieu}
🎟️ Entrée : 20 CHF

Un petit mot qui compte : la salle nous est offerte par le bar en échange de nos consommations. Sans cela, le prix d'entrée serait bien plus élevé — alors joue le jeu en consommant sur place tout au long de la soirée. Merci d'avance : c'est grâce à ça que la soirée est possible !

Au programme : des jeux intelligents pour se découvrir, se comprendre vraiment et briser la glace, de la musique, quelques fous rires, et surtout de vraies rencontres humaines autour d'un verre — sans applis, sans rejet, sans faux-semblants.

👉 {reserver}`;

const SIGNOFF = `On a hâte de te (re)voir. Belle semaine à toi !

Ta team Soirée Match 💛`;

const TEMPLATES = [
  {
    name: 'Prochaines soirées (référence)',
    subject: 'La prochaine Soirée Match approche — viens tenter ta chance',
    body: `Bonjour {prenom},

La prochaine Soirée Match approche, et c'est l'occasion rêvée de faire de belles rencontres, en vrai. Laisse les applis de côté et viens tenter ta chance : pas besoin de savoir quoi dire, nos jeux s'occupent de briser la glace pour toi — tu n'as qu'à venir avec le sourire.

Voici les dates faites pour toi — clique sur celle qui te tente :

{soirees}

Au programme : des jeux intelligents pour se découvrir, se comprendre vraiment et briser la glace, de la musique, quelques fous rires, et surtout de vraies rencontres humaines autour d'un verre — sans applis, sans rejet, sans faux-semblants.

Un petit mot qui compte : la salle nous est offerte par le bar en échange de nos consommations. Sans cela, le prix d'entrée serait bien plus élevé — alors joue le jeu en consommant sur place tout au long de la soirée. Merci d'avance : c'est grâce à ça que la soirée est possible !

Comment ça se passe : les places partent dans l'ordre d'inscription. Dès qu'une place est libre pour ton profil — pour les soirées hétéro, cela veut dire qu'il y a autant de femmes que d'hommes inscrits, pour que personne ne se retrouve seul(e) dans son coin — tu peux la régler et la confirmer tout de suite. Sinon, tu passes en liste d'attente et on t'envoie un lien pour payer dès qu'une place se libère. Tu es tenu(e) au courant automatiquement par e-mail à chaque étape.

Une question ou un souci technique ? Écris-nous à contact@soireematch.com — et ajoute cette adresse à tes contacts pour être sûr(e) de ne rien manquer.

On a hâte de t'y voir,
L'équipe Soirée Match`,
  },
  {
    name: 'Relance — il manque des inscrits',
    subject: 'Il reste des places pour nos prochaines soirées',
    body: `Bonjour {prenom},

Nos prochaines soirées approchent, et il nous manque encore {manque} pour garantir une belle parité et une soirée réussie.

Si tu hésitais, c'est le moment idéal — et si quelqu'un autour de toi pourrait aimer, transmets-lui ce message : nos plus belles soirées naissent du bouche-à-oreille.

Voici les dates qui te concernent :

{soirees}

Les places partent dans l'ordre d'inscription. Dès qu'une place est libre pour ton profil — pour les soirées hétéro, dès qu'il y a autant de femmes que d'hommes — tu peux la régler ; sinon tu passes en liste d'attente et on te prévient dès qu'une place se libère.

Une question ? Écris-nous à contact@soireematch.com — et ajoute cette adresse à tes contacts pour ne rien manquer.

On a hâte de t'y voir,
L'équipe Soirée Match`,
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
    <p class=hint>Pour t'envoyer un e-mail de test à toi seul (sans aucun risque pour la liste), utilise la <a href="/admin/test"><b>page d'e-mail de test</b></a>.</p>
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

      <label>Soirées à inclure <span class=hint>(coche une ou plusieurs — elles s'affichent via la balise {soirees}, chacune avec un lien « Réserver » pour les personnes concernées)</span></label>
      <div style="display:flex;flex-direction:column;gap:6px;max-height:180px;overflow:auto;border:1px solid #ddd;border-radius:8px;padding:10px">
        ${soirees.length ? soirees.map((s) => `<label style="display:flex;align-items:center;gap:8px;font-weight:400"><input type=checkbox name=soirees value="${esc(s.code)}"> ${esc(s.date_texte || s.code)} (${esc(s.code)})</label>`).join('') : '<span class=hint>Aucune soirée active — crée-en dans « Soirées ».</span>'}
      </div>
      <p class=hint>Si tu coches <b>une seule</b> soirée, les balises {lien}, {date} et {lieu} pointent vers elle. Si tu en coches plusieurs (ou aucune), utilise <b>{soirees}</b> pour toutes les lister ; {lien} mène alors au site.</p>
      <label class=hint style="display:flex;align-items:center;gap:8px;font-weight:400;margin-top:6px"><input type=checkbox name=auto checked> Envoyer uniquement aux personnes concernées par les soirées cochées (âge ±3, sexe, orientation)</label>

      <label>Objet</label>
      <input id=subject name=subject required style="width:100%" placeholder="Ex. La prochaine Soirée Match approche !">
      <label>Message</label>
      <textarea id=body name=body rows=14 required placeholder="Bonjour {prenom},&#10;&#10;…"></textarea>
      <p class=hint>Repères : <b>{prenom}</b> = le prénom de chacun · <b>{reserver}</b> = bouton personnalisé « Je réserve ma place » (chaque personne arrive sur une page qui lui montre <b>automatiquement les soirées qui la concernent</b> selon son âge, son sexe et qui elle cherche — réservation en un clic). <b>{lien}</b> = un lien fixe vers la soirée liée ci-dessus, ou le site. <b>{date}</b> et <b>{lieu}</b> = la date et le lieu de la soirée liée (se remplissent tout seuls). <b>{soirees}</b> = la liste de toutes les soirées à venir, avec un lien « Réserver » uniquement pour celles qui concernent la personne (les autres affichées sans lien). Un lien de désinscription est ajouté automatiquement en bas.</p>
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

function testComposePage(done) {
  const off = !transporter;
  const soirees = db.prepare('SELECT code,date_texte FROM soirees WHERE actif=1 ORDER BY id DESC').all();
  const defaultAddr = /@/.test(ADMIN_USER) ? ADMIN_USER : '';
  return `${pageHead('E-mail de test')}
  <div class=wrap>
    <a class=back href="/admin/compose">← Retour à l'envoi normal</a>
    <h2>🧪 E-mail de test</h2>
    <div class=panel style="border-color:#8fbf8f;background:#eefaee;color:#1c7a3f;margin-bottom:14px"><b>Zéro risque d'envoi de masse ici.</b> Cette page envoie l'e-mail <b>uniquement</b> à l'adresse indiquée ci-dessous. La liste des inscrits n'est jamais utilisée.</div>
    ${done ? `<div class=panel style="border-color:#8fbf8f;background:#eefaee;color:#1c7a3f;margin-bottom:14px">✅ E-mail de test envoyé à <b>${esc(done)}</b>. Va vérifier ta boîte (pense aux spams).</div>` : ''}
    ${off ? '<div class=panel style="border-color:#e0b4b0;color:#c0392b">⚠ L\'envoi d\'e-mails est désactivé (MAIL_USER / MAIL_PASS non définis).</div>' : ''}
    <form class=panel method=post action=/admin/test/send onsubmit="return confirm('Envoyer ce test à cette seule adresse ?')">
      <label>Modèle</label>
      <select id=tpl><option value="-1">— Partir d'un modèle… —</option>${TEMPLATES.map((t, i) => `<option value=${i}>${esc(t.name)}</option>`).join('')}</select>
      <label>Soirées à inclure <span class=hint>(coche une ou plusieurs — pour {soirees} ; une seule pour {lien}/{date}/{lieu})</span></label>
      <div style="display:flex;flex-direction:column;gap:6px;max-height:180px;overflow:auto;border:1px solid #ddd;border-radius:8px;padding:10px">
        ${soirees.length ? soirees.map((so2) => `<label style="display:flex;align-items:center;gap:8px;font-weight:400"><input type=checkbox name=soirees value="${esc(so2.code)}"> ${esc(so2.date_texte || so2.code)} (${esc(so2.code)})</label>`).join('') : '<span class=hint>Aucune soirée active.</span>'}
      </div>
      <p class=hint>Pour ce test, les soirées cochées s'affichent toujours (même si ton adresse n'est pas inscrite) afin que tu voies le rendu. Les liens « Réserver » ne fonctionnent que si l'adresse de test est un inscrit.</p>
      <label>Objet</label>
      <input id=subject name=subject required style="width:100%">
      <label>Message</label>
      <textarea id=body name=body rows=14 required></textarea>
      <p class=hint>Repères : <b>{prenom}</b>, <b>{reserver}</b>, <b>{lien}</b>, <b>{date}</b>, <b>{lieu}</b>, <b>{soirees}</b>. Si l'adresse de test correspond à un inscrit, la personnalisation (soirées éligibles, liens 1-clic) est réelle.</p>
      <label>Destinataire UNIQUE — ton adresse <span class=hint>(obligatoire)</span></label>
      <input name=test_email type=email required value="${esc(defaultAddr)}" style="width:100%;border:2px solid #2f7d8a">
      <div style="margin-top:14px"><button ${off ? 'disabled' : ''}>Envoyer le test (à cette seule adresse)</button></div>
    </form>
  </div>
  <script>
    const TPL = ${JSON.stringify(TEMPLATES)};
    document.getElementById('tpl').addEventListener('change', function(e){
      const i = +e.target.value; if (i < 0) return;
      document.getElementById('subject').value = TPL[i].subject;
      document.getElementById('body').value = TPL[i].body;
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
    ? pubMsg('C\'est fait ✓', 'Tu ne recevras plus d\'e-mails de la Soirée Match, et tu ne verras plus les prochaines soirées. Si c\'était une erreur, réinscris-toi sur soireematch.com ou écris-nous à contact@soireematch.com.')
    : pubMsg('Lien invalide', 'Ce lien de désinscription n\'est pas valide. Écris-nous à contact@soireematch.com et on s\'en occupe.');
}
function unsubConfirmPage(email, token) {
  const q = `e=${encodeURIComponent(email)}&t=${encodeURIComponent(token)}`;
  return `${siteHead('Se désinscrire — Soirée Match')}<div class=box>
    <h1>Avant de partir… 💛</h1>
    <p>Tu es sur le point de te désinscrire de la liste Soirée Match avec l'adresse <b>${esc(email)}</b>. Prends un instant : ce n'est pas automatique, tu dois confirmer ci-dessous.</p>
    <p style="text-align:left;max-width:440px;margin:14px auto">Si tu confirmes :</p>
    <ul style="text-align:left;max-width:440px;margin:0 auto 14px;line-height:1.7">
      <li>tu ne recevras <b>plus aucun e-mail</b> de notre part ;</li>
      <li>tu ne seras <b>plus informé(e) des prochaines soirées</b> près de chez toi ;</li>
      <li>tes liens de réservation personnels ne fonctionneront plus (il faudra te réinscrire sur soireematch.com).</li>
    </ul>
    <p style="max-width:440px;margin:0 auto">Tu veux juste souffler un peu ? Écris-nous à <b>contact@soireematch.com</b>, on peut espacer les envois plutôt que tout arrêter.</p>
    <form method=post action="/unsub?${q}" style="margin-top:20px">
      <button class=btn style="background:#c0392b">Oui, me désinscrire définitivement</button>
    </form>
    <p style="margin-top:14px"><a href="${SITE_URL}">← Non, je reste inscrit(e)</a></p>
  </div></html>`;
}

// ---------- Serveur ----------
// ================= Parité, liste d'attente & remboursements (Option A) =================
const HOLD_MS = 3 * 60 * 60 * 1000;                 // 3h pour confirmer/payer une place proposée
const nowMs = () => Date.now();
const nowIso = () => new Date().toISOString();
const VENUE_DEFAULT = 'Happy Days Bar & Gril, rue Saint Pierre 3, Lausanne';
const FR_DAYS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const FR_MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
function dtLocalToIso(v) {
  const m = String(v || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00.000Z` : null;
}
function formatFr(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const hh = String(d.getUTCHours()).padStart(2, '0'), mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${FR_DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${FR_MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} à ${hh}h${mm}`;
}
function soireeMetaShort(so) {
  const p = [];
  if (so.tranche) p.push(`${so.tranche} ans (±3)`);
  const t = { 'Hétéro': 'hétéro', 'Gay hommes': 'entre hommes', 'Gay femmes': 'entre femmes' }[so.type];
  if (t) p.push(t);
  return p.join(' · ');
}
function emailShell(inner, unsub) {
  const tile = `${SITE_URL}/zellige-email.png`;
  return `<div style="background:#f5faf8;padding:24px 12px;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif"><div style="max-width:560px;margin:auto;background:#ffffff;border:1px solid #d7e6df;border-radius:14px;overflow:hidden">`
  + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse"><tr><td background="${tile}" bgcolor="#156b54" style="background-color:#156b54;background-image:url('${tile}');background-repeat:repeat;padding:34px 28px;text-align:center;border-bottom:3px solid #d0aa54"><div style="font-size:30px;font-weight:800;letter-spacing:.5px;color:#d0aa54">Soirée Match</div><div style="color:#d0aa54;font-size:12px;letter-spacing:2px;margin-top:9px">RENCONTRES CÉLIBATAIRES · LAUSANNE</div></td></tr></table>`
  + `<div style="padding:28px;color:#1b2a24;font-size:15px;line-height:1.6">${inner}</div>`
  + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse"><tr><td background="${tile}" bgcolor="#156b54" style="background-color:#156b54;background-image:url('${tile}');background-repeat:repeat;padding:24px 28px;text-align:center"><div style="font-size:17px;font-weight:700;letter-spacing:.6px"><a href="${SITE_URL}" style="color:#d0aa54;text-decoration:none">soireematch.com</a></div><div style="margin-top:12px;font-size:12px;color:#cfe6db;line-height:1.6">Tu reçois cet e-mail car tu t'es inscrit(e) à la Soirée Match.<br><a href="${unsub}" style="color:#e8d39a">Se désinscrire</a> · <a href="mailto:contact@soireematch.com" style="color:#e8d39a">contact@soireematch.com</a></td></tr></table>`
  + `</div></div>`;
}
const isParity = (so) => (so.type === 'Hétéro');
const otherGenre = (g) => (g === 'Femme' ? 'Homme' : 'Femme');
const capSexe = (so) => (Number(so.cap_sexe) > 0 ? Number(so.cap_sexe) : 15);
const minSexe = (so) => (Number(so.min_sexe) > 0 ? Number(so.min_sexe) : 8);
const capTotal = (so) => (Number(so.cap_total) > 0 ? Number(so.cap_total) : 30);
const minTotal = (so) => (Number(so.min_total) > 0 ? Number(so.min_total) : 10);
const LEAD_MAX = 3;   // parité : un sexe peut mener de 3 au maximum, ensuite liste d'attente

function paidCount(soId, genre) {
  return genre
    ? db.prepare("SELECT COUNT(*) n FROM reservations WHERE soiree_id=? AND status='paid' AND genre=?").get(soId, genre).n
    : db.prepare("SELECT COUNT(*) n FROM reservations WHERE soiree_id=? AND status='paid'").get(soId).n;
}
function holdCount(soId, genre) {
  const iso = nowIso();
  return genre
    ? db.prepare("SELECT COUNT(*) n FROM reservations WHERE soiree_id=? AND status='hold' AND hold_expires>? AND genre=?").get(soId, iso, genre).n
    : db.prepare("SELECT COUNT(*) n FROM reservations WHERE soiree_id=? AND status='hold' AND hold_expires>?").get(soId, iso).n;
}
// Une place est-elle ouverte au paiement maintenant pour ce profil ?
// Hétéro : on n'autorise (payé+hold) d'un sexe que jusqu'au nombre de PAYÉS de l'autre sexe
// -> garantit |payésF - payésH| <= 1 en permanence. Gay : simple capacité totale.
function slotOpen(so, genre) {
  if (isParity(so)) {
    const held = paidCount(so.id, genre) + holdCount(so.id, genre);
    return held < capSexe(so) && (held - paidCount(so.id, otherGenre(genre))) < LEAD_MAX;
  }
  const heldT = paidCount(so.id, null) + holdCount(so.id, null);
  return heldT < capTotal(so);
}
function isViable(so) {
  return isParity(so)
    ? (paidCount(so.id, 'Femme') >= minSexe(so) && paidCount(so.id, 'Homme') >= minSexe(so))
    : (paidCount(so.id, null) >= minTotal(so));
}
function deficitTxt(so) {
  if (isParity(so)) {
    const mf = Math.max(0, minSexe(so) - paidCount(so.id, 'Femme'));
    const mh = Math.max(0, minSexe(so) - paidCount(so.id, 'Homme'));
    const parts = [];
    if (mf) parts.push(mf + ' ' + (mf > 1 ? 'femmes' : 'femme'));
    if (mh) parts.push(mh + ' ' + (mh > 1 ? 'hommes' : 'homme'));
    return parts.join(' et ') || 'quelques personnes';
  }
  const m = Math.max(0, minTotal(so) - paidCount(so.id, null));
  return m ? (m + ' ' + (m > 1 ? 'personnes' : 'personne')) : 'quelques personnes';
}

const payToken = (rid, email) => crypto.createHmac('sha256', SECRET).update('pay:' + rid + ':' + String(email).toLowerCase()).digest('base64url');
const payLink = (rid, email) => `${SITE_URL}/payer?rid=${rid}&e=${encodeURIComponent(email)}&t=${payToken(rid, email)}`;

// Promeut les 1ers en attente tant qu'une place s'ouvre (ordre : priorité puis ancienneté)
function promote(soIn) {
  const so = getSoireeById(soIn.id) || soIn;
  if (!so.actif || so.annulee) return;
  const genres = isParity(so) ? ['Femme', 'Homme'] : [null];
  for (const g of genres) {
    let guard = 0;
    while (guard++ < 200 && slotOpen(so, g || 'Femme')) {
      const w = db.prepare(
        "SELECT * FROM reservations WHERE soiree_id=? AND status='waiting'" + (g ? ' AND genre=?' : '')
        + ' ORDER BY priority DESC, created_at ASC LIMIT 1'
      ).get(...(g ? [so.id, g] : [so.id]));
      if (!w) break;
      if (PAY_ON) {
        db.prepare("UPDATE reservations SET status='hold', hold_expires=? WHERE id=?").run(new Date(nowMs() + HOLD_MS).toISOString(), w.id);
        mailSlotOpen(so, w);
      } else {
        db.prepare("UPDATE reservations SET status='paid', paid=1 WHERE id=?").run(w.id);
        sendReservationMail(so, w);
      }
    }
  }
}
function expireHolds(so) {
  const info = db.prepare("UPDATE reservations SET status='expired' WHERE soiree_id=? AND status='hold' AND hold_expires<=?").run(so.id, nowIso());
  return info.changes;
}
async function refundResa(resa, so, reason) {
  try {
    if (PAY_ON && resa.stripe_payment_intent) await stripeApi('POST', '/v1/refunds', { payment_intent: resa.stripe_payment_intent });
  } catch (e) { console.error('Remboursement Stripe échoué', resa.id, e.message); }
  db.prepare("UPDATE reservations SET status='refunded', paid=0 WHERE id=?").run(resa.id);
  mailRefund(so, resa, reason);
}
// Réconciliation ±1 : rembourse le surplus (les dernier·e·s arrivé·e·s du sexe majoritaire)
async function reconcile(so) {
  if (!isParity(so)) return;
  const f = paidCount(so.id, 'Femme'), h = paidCount(so.id, 'Homme');
  if (f === h) return;
  const majority = f > h ? 'Femme' : 'Homme';
  const excess = Math.abs(f - h);
  const rows = db.prepare("SELECT * FROM reservations WHERE soiree_id=? AND status='paid' AND genre=? ORDER BY priority ASC, created_at DESC LIMIT ?").all(so.id, majority, excess);
  for (const r of rows) await refundResa(r, so, 'parite');
}
async function cancelSoiree(so, reason) {
  db.prepare('UPDATE soirees SET actif=0, annulee=1 WHERE id=?').run(so.id);
  for (const r of db.prepare("SELECT * FROM reservations WHERE soiree_id=? AND status='paid'").all(so.id)) await refundResa(r, so, 'annulation');
  for (const r of db.prepare("SELECT * FROM reservations WHERE soiree_id=? AND status IN ('waiting','hold')").all(so.id)) {
    db.prepare("UPDATE reservations SET status='cancelled' WHERE id=?").run(r.id);
    mailCancel(so, r);
  }
  if (NOTIFY_TO && transporter) transporter.sendMail({ from: MAIL_FROM, to: NOTIFY_TO, subject: `Soirée ${so.code} ANNULÉE (effectif insuffisant)`, text: `La soirée ${so.code} (${so.date_texte || ''}) a été auto-annulée à J-24h faute d'effectif. Remboursements lancés.` }).catch(() => {});
}
function alert72(so) {
  if (!NOTIFY_TO || !transporter) return;
  const detail = isParity(so)
    ? `Femmes payées : ${paidCount(so.id, 'Femme')}/${minSexe(so)} · Hommes payés : ${paidCount(so.id, 'Homme')}/${minSexe(so)}`
    : `Payés : ${paidCount(so.id, null)}/${minTotal(so)}`;
  transporter.sendMail({ from: MAIL_FROM, to: NOTIFY_TO,
    subject: `⚠ Soirée ${so.code} sous l'effectif minimum (J-72h)`,
    text: `La soirée ${so.code} (${so.date_texte || ''}) est sous le minimum à 72h.\n${detail}\nIl manque ${deficitTxt(so)}.\n\nEnvoie l'e-mail de relance « il manque X » depuis l'admin (modèle « Relance — il manque des inscrits » déjà prêt). Sans effectif suffisant à 24h, elle sera auto-annulée et tout le monde remboursé.` }).catch(() => {});
}
const eventStartMs = (so) => (so.date_start ? new Date(so.date_start).getTime() : NaN);
async function tick() {
  const list = db.prepare('SELECT * FROM soirees WHERE actif=1 AND COALESCE(annulee,0)=0').all();
  const now = nowMs();
  for (const so of list) {
    try {
      if (expireHolds(so)) promote(so);
      const start = eventStartMs(so);
      if (!Number.isFinite(start)) continue;
      const hrs = (start - now) / 3600000;
      if (hrs <= 72 && hrs > 24 && !so.alert72_sent && !isViable(so)) { alert72(so); db.prepare('UPDATE soirees SET alert72_sent=1 WHERE id=?').run(so.id); }
      if (hrs <= 24 && hrs > 3 && !isViable(so)) { await cancelSoiree(so, 'non_viable'); continue; }
      if (hrs <= 3 && !so.reconcile_done) { expireHolds(so); await reconcile(so); db.prepare('UPDATE soirees SET reconcile_done=1 WHERE id=?').run(so.id); }
    } catch (e) { console.error('tick', so.code, e.message); }
  }
}
if (!process.env.NO_SCHEDULER) setInterval(() => { tick().catch(() => {}); }, 5 * 60 * 1000);

// ---- E-mails liste d'attente / place dispo / remboursement / annulation ----
function mailWaitlist(so, i) {
  if (!transporter) return;
  const prenom = (i.prenom || '').trim() || 'à toi';
  transporter.sendMail({ from: MAIL_FROM, to: i.email,
    subject: `Tu es sur la liste d'attente — Soirée Match${so.date_texte ? ` du ${so.date_texte}` : ''}`,
    text: `Bonjour ${prenom},\n\nMerci de ton intérêt pour la Soirée Match${so.date_texte ? ` du ${so.date_texte}` : ''} !\n\nPour garantir une parité parfaite hommes/femmes, les places de ton profil sont complètes pour le moment. Tu es inscrit(e) sur la liste d'attente, dans ton ordre d'arrivée.\n\nDès qu'une place se libère pour toi, tu reçois un e-mail avec un lien pour la confirmer — tu auras alors 3 heures pour la régler avant qu'elle ne passe à la personne suivante. Rien n'est débité tant que ta place n'est pas garantie.\n\nOn croise les doigts pour toi 💛\nTa team Soirée Match` }).catch(() => {});
}
function mailSlotOpen(so, r) {
  if (!transporter) return;
  const prenom = (r.prenom || '').trim() || 'à toi';
  const link = payLink(r.id, r.email);
  const txt = `Bonjour ${prenom},\n\nBonne nouvelle : une place vient de se libérer pour toi pour la Soirée Match${so.date_texte ? ` du ${so.date_texte}` : ''} !\n\nVotre place pour cet événement a été réservée en priorité dans votre ordre d'inscription, cependant nous ne pouvons pas la réserver plus de trois heures pour éviter de bloquer d'autres personnes sur cette même liste.\n\n👉 Confirme et règle ta place ici : ${link}\n\nÀ très vite 💛\nTa team Soirée Match`;
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:520px;margin:auto;color:#1e2f30;font-size:15px;line-height:1.55"><p>Bonjour ${esc(prenom)},</p><p>Bonne nouvelle : une place vient de se libérer pour toi pour la <b>Soirée Match${so.date_texte ? ` du ${esc(so.date_texte)}` : ''}</b> !</p><p>Votre place pour cet événement a été réservée en priorité dans votre ordre d'inscription, cependant nous ne pouvons pas la réserver plus de trois heures pour éviter de bloquer d'autres personnes sur cette même liste.</p><p><a href="${link}" style="display:inline-block;background:#2f7d8a;color:#fff;text-decoration:none;padding:12px 24px;border-radius:30px;font-weight:600">Confirmer et régler ma place</a></p><p style="font-size:13px;color:#8a9a99">Ce lien expire dans 3 heures.</p><p>À très vite 💛<br>Ta team Soirée Match</p></div>`;
  transporter.sendMail({ from: MAIL_FROM, to: r.email, subject: `Une place s'est libérée — Soirée Match${so.date_texte ? ` du ${so.date_texte}` : ''} (3h pour confirmer)`, text: txt, html }).catch(() => {});
}
function mailRefund(so, r, reason) {
  if (!transporter) return;
  const prenom = (r.prenom || '').trim() || 'à toi';
  const why = reason === 'annulation'
    ? `la Soirée Match${so.date_texte ? ` du ${so.date_texte}` : ''} a dû être annulée faute d'un effectif suffisant pour garantir une belle soirée`
    : `nous n'avons pas pu confirmer ta place pour la Soirée Match${so.date_texte ? ` du ${so.date_texte}` : ''} : il nous manquait une personne du sexe opposé pour garder une parité parfaite`;
  transporter.sendMail({ from: MAIL_FROM, to: r.email,
    subject: `Remboursement — Soirée Match${so.date_texte ? ` du ${so.date_texte}` : ''}`,
    text: `Bonjour ${prenom},\n\nOn est désolés : ${why}.\n\nTon paiement est intégralement remboursé — il réapparaîtra sur ton moyen de paiement d'ici quelques jours (le délai dépend de ta banque).\n\nOn espère te voir à une prochaine soirée — on t'avertira dès qu'une nouvelle date de ton profil s'ouvre 💛\nTa team Soirée Match` }).catch(() => {});
}
function mailCancel(so, r) {
  if (!transporter) return;
  const prenom = (r.prenom || '').trim() || 'à toi';
  transporter.sendMail({ from: MAIL_FROM, to: r.email,
    subject: `Soirée annulée — Soirée Match${so.date_texte ? ` du ${so.date_texte}` : ''}`,
    text: `Bonjour ${prenom},\n\nLa Soirée Match${so.date_texte ? ` du ${so.date_texte}` : ''} a dû être annulée faute d'un effectif suffisant. Tu n'avais pas encore réglé de place, donc rien n'a été débité.\n\nOn t'avertira dès qu'une nouvelle date de ton profil s'ouvre 💛\nTa team Soirée Match` }).catch(() => {});
}
function waitlistPage(so) {
  return `${siteHead('Liste d\'attente — Soirée Match')}<div class=box><h1>Tu es sur la liste d'attente ⏳</h1><p>Pour garder une <b>parité parfaite</b> hommes/femmes, les places de ton profil sont complètes pour l'instant. Tu es inscrit(e) sur la liste d'attente, dans ton ordre d'arrivée.</p><p>Dès qu'une place se libère pour toi, on t'envoie un e-mail avec un lien — tu auras <b>3 heures</b> pour la confirmer. Aucun paiement n'est demandé tant que ta place n'est pas garantie. 💛</p></div></html>`;
}

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

  // Liste publique des soirées à afficher sur le site (à venir + passées depuis moins de 7 jours)
  if (p === '/api/soirees' && req.method === 'GET') {
    const now = Date.now(), cutoff = now - 7 * 24 * 3600 * 1000;
    const rows = db.prepare("SELECT code,date_start,lieu,type,tranche FROM soirees WHERE COALESCE(annulee,0)=0 AND date_start IS NOT NULL").all()
      .filter((so) => new Date(so.date_start).getTime() >= cutoff)
      .map((so) => ({ code: so.code, iso: so.date_start, lieu: so.lieu || '', type: so.type || '', tranche: so.tranche || '', past: new Date(so.date_start).getTime() < now }));
    return json(res, 200, rows);
  }

  // Désinscription : page de confirmation (GET) puis action réelle (POST, ou 1-clic Gmail/Outlook)
  if (p === '/unsub') {
    const email = url.searchParams.get('e') || '';
    const t = url.searchParams.get('t') || '';
    const good = email ? unsubToken(email) : '';
    const valid = !!good && t.length === good.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(good));
    if (req.method === 'POST') {
      await readBody(req);   // consomme le corps (désinscription 1-clic)
      if (valid) db.prepare('UPDATE inscriptions SET unsubscribed=1 WHERE lower(email)=lower(?)').run(email);
      return send(res, 200, unsubPage(valid));
    }
    if (!valid) return send(res, 200, unsubPage(false));
    return send(res, 200, unsubConfirmPage(email, t));
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
    const sCode = (url.searchParams.get('s') || '').trim();
    if (sCode) {
      const soS = getSoiree(sCode);
      if (soS && soS.actif && eligibleForSoiree(person, soS)) return send(res, 200, confirmSoireePage(person, soS));
    }
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
  // Confirmer/payer une place proposée depuis la liste d'attente
  if (p === '/payer' && req.method === 'GET') {
    const rid = Number(url.searchParams.get('rid') || 0);
    const email = url.searchParams.get('e') || '';
    const t = String(url.searchParams.get('t') || '');
    const good = (rid && email) ? payToken(rid, email) : '';
    const valid = !!good && t.length === good.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(good));
    const r = valid ? db.prepare('SELECT * FROM reservations WHERE id=?').get(rid) : null;
    if (!r) return send(res, 200, pubMsg('Lien invalide', 'Ce lien n\'est plus valable. Écris-nous à contact@soireematch.com.'));
    if (r.status === 'paid') return send(res, 200, pubMsg('Déjà confirmé', 'Ta place est déjà confirmée. À très vite ! 💛'));
    if (r.status !== 'hold' || (r.hold_expires && r.hold_expires < nowIso()))
      return send(res, 200, pubMsg('Délai dépassé', 'Le délai de 3h pour confirmer cette place est écoulé. Si une place se libère à nouveau, on te recontacte. 💛'));
    const so = getSoireeById(r.soiree_id);
    if (!so || !so.actif || so.annulee) return send(res, 200, pubMsg('Indisponible', 'Cette soirée n\'est plus disponible.'));
    if (!PAY_ON) { markPaidAndConfirm(r); return send(res, 200, soireeOkPage(so)); }
    try { return send(res, 302, '', { Location: await createCheckout(r.id, so, r.email) }); }
    catch (e) { return send(res, 200, pubMsg('Paiement momentanément indisponible', 'Réessaie dans un instant.')); }
  }

  // Paiement Stripe — retour succès / annulation + webhook
  if (p === '/paiement/ok' && req.method === 'GET') {
    const sid = url.searchParams.get('session_id') || '';
    if (sid && PAY_ON) {
      try {
        const sess = await stripeApi('GET', '/v1/checkout/sessions/' + encodeURIComponent(sid), null);
        if (sess && sess.payment_status === 'paid') {
          const resa = db.prepare('SELECT * FROM reservations WHERE stripe_session=?').get(sid);
          if (resa) { markPaidAndConfirm(resa, sess.payment_intent); return send(res, 200, soireeOkPage(getSoireeById(resa.soiree_id) || {})); }
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
      if (resa) markPaidAndConfirm(resa, ev.data.object.payment_intent);
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
        if (/^\d+-\d+$/.test(ft)) { const [lo, hi] = ft.split('-').map(Number); const age = "(CAST(strftime('%Y','now') AS INTEGER) - annee)"; sql += ` AND annee IS NOT NULL AND ${age} >= ? AND ${age} <= ?`; args.push(lo - 3, hi + 3); }
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
      let codes = d.soirees || [];
      if (!Array.isArray(codes)) codes = [codes];
      const selected = codes.map((c) => getSoiree(String(c).trim())).filter(Boolean);
      const so = selected.length === 1 ? selected[0] : null;   // balises singulières {lien}/{date}/{lieu}
      const linkUrl = so ? soireeLink(so.code) : SITE_URL;
      const auto = (d.auto === 'on' || d.auto === '1');
      const recips = (auto && selected.length)
        ? db.prepare('SELECT prenom,email,genre,recherche,annee,langues FROM inscriptions WHERE COALESCE(unsubscribed,0)=0').all().filter((p) => selected.some((sel) => eligibleForSoiree(p, sel)))
        : recipientsFor({ genre, recherche, tranche });
      runCampaign(recips, subject, body, linkUrl, so, selected);   // en arrière-plan (non bloquant)
      return send(res, 302, '', { Location: '/admin' });
    }
    if (p === '/admin/test' && req.method === 'GET') return send(res, 200, testComposePage(url.searchParams.get('done') || ''));
    if (p === '/admin/test/send' && req.method === 'POST') {
      const d = parseForm(await readBody(req));
      const subject = (d.subject || '').trim(), body = (d.body || '').trim();
      const testEmail = (d.test_email || '').trim();
      if (!transporter || !subject || !body || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(testEmail)) return send(res, 302, '', { Location: '/admin/test' });
      let codes = d.soirees || [];
      if (!Array.isArray(codes)) codes = [codes];
      const selected = codes.map((c) => getSoiree(String(c).trim())).filter(Boolean);
      const so = selected.length === 1 ? selected[0] : null;
      const linkUrl = so ? soireeLink(so.code) : SITE_URL;
      const row = db.prepare('SELECT prenom,email,genre,recherche,annee,langues FROM inscriptions WHERE lower(email)=lower(?)').get(testEmail);
      const recips = [row || { prenom: 'Test', email: testEmail, genre: '', recherche: '', annee: 0, langues: '' }];
      runCampaign(recips, subject, body, linkUrl, so, selected, true);   // true = afficher les soirées cochées (aperçu)
      return send(res, 302, '', { Location: '/admin/test?done=' + encodeURIComponent(testEmail) });
    }

    // Gestion des soirées
    if (p === '/admin/soirees' && req.method === 'GET') return send(res, 200, soireesPage());
    if (p === '/admin/soirees' && req.method === 'POST') {
      const d = parseForm(await readBody(req));
      const code = (d.code || '').trim().replace(/\s+/g, '').toLowerCase();
      if (code) {
        try {
          const dstart = dtLocalToIso(d.date_start);
          const lieu = (d.lieu || '').trim() || VENUE_DEFAULT;
          db.prepare('INSERT INTO soirees(code,date_texte,lieu,prix,actif,created_at,type,tranche,date_start,cap_sexe,min_sexe,cap_total) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
            .run(code, formatFr(dstart), lieu, (d.prix || '').trim(), d.actif ? 1 : 0, new Date().toISOString(), (d.type || '').trim(), (d.tranche || '').trim(), dstart, Number(d.cap_sexe) || 15, Number(d.min_sexe) || 8, Number(d.cap_total) || 30);
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
        const dstart = dtLocalToIso(d.date_start);
        const lieu = (d.lieu || '').trim() || VENUE_DEFAULT;
        db.prepare('UPDATE soirees SET code=?,date_texte=?,lieu=?,prix=?,actif=?,type=?,tranche=?,date_start=?,cap_sexe=?,min_sexe=?,cap_total=? WHERE id=?')
          .run((d.code || '').trim().replace(/\s+/g, '').toLowerCase(), formatFr(dstart), lieu, (d.prix || '').trim(), d.actif ? 1 : 0, (d.type || '').trim(), (d.tranche || '').trim(), dstart, Number(d.cap_sexe) || 15, Number(d.min_sexe) || 8, Number(d.cap_total) || 30, id);
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
      return send(res, 200, reservationsPage(s, url.searchParams.get('done')));
    }
    if (p === '/admin/soirees/reservations/export' && req.method === 'GET') {
      const s = getSoireeById(Number(url.searchParams.get('id')));
      if (!s) return send(res, 302, '', { Location: '/admin/soirees' });
      const rows = db.prepare('SELECT * FROM reservations WHERE soiree_id=? ORDER BY id DESC').all(s.id);
      return send(res, 200, resaCSV(rows), { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="resa-${s.code}.csv"` });
    }
    if (p === '/admin/soirees/run-checks' && req.method === 'POST') {
      const id = Number(parseForm(await readBody(req)).id);
      await tick();
      return send(res, 302, '', { Location: id ? `/admin/soirees/reservations?id=${id}&done=1` : '/admin/soirees' });
    }
    if (p === '/admin/soirees/cancel' && req.method === 'POST') {
      const id = Number(parseForm(await readBody(req)).id);
      const s = id && getSoireeById(id);
      if (s && !s.annulee) await cancelSoiree(s, 'manuel');
      return send(res, 302, '', { Location: id ? `/admin/soirees/reservations?id=${id}&done=1` : '/admin/soirees' });
    }
    if (p === '/admin/soirees/resa/remove' && req.method === 'POST') {
      const id = Number(parseForm(await readBody(req)).id);
      const r = id && db.prepare('SELECT * FROM reservations WHERE id=?').get(id);
      if (!r) return send(res, 302, '', { Location: '/admin/soirees' });
      if (r.status === 'paid' && PAY_ON && r.stripe_payment_intent) {
        try { await stripeApi('POST', '/v1/refunds', { payment_intent: r.stripe_payment_intent }); } catch (e) { console.error('Remboursement (retrait admin) échoué', id, e.message); }
      }
      db.prepare("UPDATE reservations SET status='cancelled', paid=0 WHERE id=?").run(id);
      const so = getSoireeById(r.soiree_id);
      if (so) promote(so);
      return send(res, 302, '', { Location: `/admin/soirees/reservations?id=${r.soiree_id}&done=1` });
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
