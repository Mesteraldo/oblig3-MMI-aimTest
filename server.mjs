// Server for Mus vs. Trackpad. Serverer mouse-test/, tar imot gjennomganger og lar admin godkjenne dem.
// Kjør lokalt: npm start   (admin: ADMIN_PASSWORD=hemmelig npm start → http://127.0.0.1:3000/admin)
// Miljøvariabler (se .env.example):
//   PORT            standard 3000
//   HOST            standard 127.0.0.1 (Dockerfile setter 0.0.0.0)
//   RESULTS_DIR     standard ./resultater (Docker: /data)
//   ADMIN_PASSWORD  passord for /admin. Uten det er admin slått av.
//
// Lagring: hver innsending havner først i RESULTS_DIR/venter/. Først når admin godkjenner, flyttes
// filen til RESULTS_DIR/godkjent/ – det er den «ordentlige» lagringen. Avviste går til avvist/
// (slettes ikke, så et feiltrykk kan angres).
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, readdir, rename, stat } from 'node:fs/promises';
import { createHash, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.join(ROOT, 'mouse-test');
const ADMIN_FILE = path.join(ROOT, 'admin', 'index.html');
const RESULTS_DIR = path.resolve(process.env.RESULTS_DIR || path.join(ROOT, 'resultater'));
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

const MAX_BODY = 64 * 1024; // en ekte gjennomgang er ~3 kB
const MAX_PENDING = 2000; // hindrer at noen fyller disken med søppel
const RATE_LIMIT = { windowMs: 10 * 60 * 1000, max: 10 }; // innsendinger per IP per 10 min
const FILENAME = /^gjennomgang_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.json$/;
const STORED_NAME = /^gjennomgang_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}(-\d+)?\.json$/;
const STATES = ['venter', 'godkjent', 'avvist'];
const TYPES = { '.html': 'text/html; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.json': 'application/json' };

const SCHEMA_VERSION = 3;
const TARGET_COUNT = 20;
const PLAN = ['trackpad', 'trackpad', 'trackpad', 'external_mouse', 'external_mouse', 'external_mouse'];
const GENDERS = ['kvinne', 'mann', 'annet', 'vil_ikke_oppgi'];
const PREFERENCES = ['trackpad', 'mus', 'ingen'];

const dir = state => path.join(RESULTS_DIR, state);

function send(res, status, body, type = 'application/json', extra = {}) {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    ...extra
  });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('for stor')); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/* ---------- Validering ---------- */

const isNum = (v, min = 0, max = 10 * 60 * 1000) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;

/**
 * Sjekker at innsendingen har nøyaktig formatet appen lager, og bygger en ny kopi med kun kjente felt.
 * Returnerer { data } eller { error }.
 */
function sanitize(raw) {
  if (!raw || typeof raw !== 'object') return { error: 'mangler data' };
  const p = raw.participant;
  if (!p || !Array.isArray(raw.tests)) return { error: 'mangler participant/tests' };
  if (raw.schemaVersion !== SCHEMA_VERSION) return { error: 'feil schemaVersion' };
  const completedAt = new Date(raw.completedAt);
  if (typeof raw.completedAt !== 'string' || Number.isNaN(completedAt.getTime())) return { error: 'ugyldig completedAt' };
  if (!Number.isInteger(p.age) || p.age < 5 || p.age > 120) return { error: 'ugyldig alder' };
  if (!GENDERS.includes(p.gender)) return { error: 'ugyldig kjønn' };
  if (!PREFERENCES.includes(p.preference)) return { error: 'ugyldig preferanse' };
  if (raw.tests.length !== PLAN.length) return { error: `forventet ${PLAN.length} tester` };

  const tests = [];
  for (let i = 0; i < PLAN.length; i++) {
    const t = raw.tests[i];
    if (!t || t.testType !== PLAN[i] || t.attempt !== (i % 3) + 1) return { error: `test ${i + 1}: feil type/forsøk` };
    const times = t.timesBetweenClicksMs;
    if (!Array.isArray(times) || times.length !== TARGET_COUNT || !times.every(v => isNum(v))) {
      return { error: `test ${i + 1}: timesBetweenClicksMs må være ${TARGET_COUNT} tall` };
    }
    for (const k of ['totalTimeMs', 'averageTimeMs', 'longestTimeMs', 'shortestTimeMs']) {
      if (!isNum(t[k], 0, 60 * 60 * 1000)) return { error: `test ${i + 1}: ugyldig ${k}` };
    }
    if (!Number.isInteger(t.totalMisses) || t.totalMisses < 0 || t.totalMisses > 100000) return { error: `test ${i + 1}: ugyldig totalMisses` };
    tests.push({
      testType: t.testType,
      attempt: t.attempt,
      totalTimeMs: t.totalTimeMs,
      averageTimeMs: t.averageTimeMs,
      longestTimeMs: t.longestTimeMs,
      shortestTimeMs: t.shortestTimeMs,
      totalMisses: t.totalMisses,
      timesBetweenClicksMs: times.slice()
    });
  }
  return {
    data: {
      schemaVersion: SCHEMA_VERSION,
      completedAt: completedAt.toISOString(),
      participant: { age: p.age, gender: p.gender, preference: p.preference },
      tests
    }
  };
}

/* ---------- Lagring ---------- */

/** Skriver filen uten å overskrive: legger på -2, -3 … hvis navnet finnes i noen av mappene. */
async function writeUnique(filename, content) {
  const base = filename.replace(/\.json$/, '');
  for (let n = 1; n < 1000; n++) {
    const name = n === 1 ? filename : `${base}-${n}.json`;
    if (await existsAnywhere(name)) continue;
    try {
      await writeFile(path.join(dir('venter'), name), content, { flag: 'wx' });
      return name;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
  throw new Error('fant ikke ledig filnavn');
}

async function existsAnywhere(name) {
  for (const s of STATES) {
    try { await stat(path.join(dir(s), name)); return true; } catch {}
  }
  return false;
}

async function listState(state) {
  const files = (await readdir(dir(state))).filter(f => STORED_NAME.test(f)).sort().reverse();
  const items = [];
  for (const id of files) {
    try {
      const data = JSON.parse(await readFile(path.join(dir(state), id), 'utf8'));
      items.push({ id, state, data });
    } catch (err) {
      console.error(`Kunne ikke lese ${state}/${id}:`, err.message);
    }
  }
  return items;
}

/* ---------- Ratebegrensning (i minnet, per IP) ---------- */

const hits = new Map();
function clientIp(req) {
  // Bak Cloudflare Tunnel er cf-connecting-ip den ekte klienten.
  return String(req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '?');
}
function rateLimited(req) {
  const now = Date.now();
  const ip = clientIp(req);
  const list = (hits.get(ip) || []).filter(t => now - t < RATE_LIMIT.windowMs);
  if (list.length >= RATE_LIMIT.max) { hits.set(ip, list); return true; }
  list.push(now);
  hits.set(ip, list);
  return false;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, list] of hits) if (!list.some(t => now - t < RATE_LIMIT.windowMs)) hits.delete(ip);
}, RATE_LIMIT.windowMs).unref();

/* ---------- Offentlig API ---------- */

async function handleSave(req, res, url) {
  const filename = url.searchParams.get('filename') || '';
  if (!FILENAME.test(filename)) return send(res, 400, { error: 'ugyldig filnavn' });
  if (rateLimited(req)) return send(res, 429, { error: 'for mange innsendinger, prøv igjen senere' });
  let raw;
  try {
    raw = JSON.parse(await readBody(req));
  } catch {
    return send(res, 400, { error: 'ugyldig JSON' });
  }
  const { data, error } = sanitize(raw);
  if (error) return send(res, 400, { error });
  if ((await readdir(dir('venter'))).length >= MAX_PENDING) {
    return send(res, 503, { error: 'køen er full, prøv igjen senere' });
  }
  const name = await writeUnique(filename, JSON.stringify(data, null, 2) + '\n');
  console.log(`Ny innsending venter på godkjenning: venter/${name}`);
  send(res, 200, { status: 'venter', id: name });
}

/* ---------- Admin ---------- */

const sha = s => createHash('sha256').update(s).digest();
const ADMIN_HASH = ADMIN_PASSWORD ? sha(ADMIN_PASSWORD) : null;

/** Basic auth: brukernavn ignoreres, passordet må være ADMIN_PASSWORD. */
function isAdmin(req) {
  if (!ADMIN_HASH) return false;
  const m = /^Basic (.+)$/i.exec(req.headers.authorization || '');
  if (!m) return false;
  const decoded = Buffer.from(m[1], 'base64').toString('utf8');
  const password = decoded.slice(decoded.indexOf(':') + 1);
  return timingSafeEqual(sha(password), ADMIN_HASH);
}

async function handleAdmin(req, res, url) {
  if (!ADMIN_HASH) return send(res, 503, 'Admin er slått av: sett ADMIN_PASSWORD.', 'text/plain; charset=utf-8');
  if (!isAdmin(req)) {
    return send(res, 401, 'Logg inn', 'text/plain; charset=utf-8', { 'www-authenticate': 'Basic realm="aimtest-admin", charset="UTF-8"' });
  }

  if (url.pathname === '/admin' || url.pathname === '/admin/') {
    if (req.method !== 'GET') return send(res, 405, { error: 'bruk GET' });
    return send(res, 200, await readFile(ADMIN_FILE), TYPES['.html']);
  }

  if (url.pathname === '/api/admin/list') {
    const state = url.searchParams.get('state') || 'venter';
    if (!STATES.includes(state)) return send(res, 400, { error: 'ukjent state' });
    const counts = {};
    for (const s of STATES) counts[s] = (await readdir(dir(s))).filter(f => STORED_NAME.test(f)).length;
    return send(res, 200, { counts, items: await listState(state) });
  }

  if (url.pathname === '/api/admin/export') {
    const items = await listState('godkjent');
    const body = items.reverse().map(i => ({ id: i.id, ...i.data }));
    return send(res, 200, JSON.stringify(body, null, 2), 'application/json',
      { 'content-disposition': 'attachment; filename="godkjente-gjennomganger.json"' });
  }

  const MOVES = { '/api/admin/approve': ['venter', 'godkjent'], '/api/admin/reject': ['venter', 'avvist'], '/api/admin/restore': ['avvist', 'venter'], '/api/admin/unapprove': ['godkjent', 'venter'] };
  const move = MOVES[url.pathname];
  if (move) {
    if (req.method !== 'POST') return send(res, 405, { error: 'bruk POST' });
    // Egen header tvinger nettleseren til CORS-preflight, så andre nettsider ikke kan trigge dette (CSRF).
    if (req.headers['x-admin-action'] !== '1') return send(res, 403, { error: 'mangler x-admin-action' });
    const id = url.searchParams.get('id') || '';
    if (!STORED_NAME.test(id)) return send(res, 400, { error: 'ugyldig id' });
    const [from, to] = move;
    try {
      await rename(path.join(dir(from), id), path.join(dir(to), id));
    } catch (err) {
      if (err.code === 'ENOENT') return send(res, 404, { error: `finnes ikke i ${from}/` });
      throw err;
    }
    console.log(`Admin: ${from}/${id} → ${to}/`);
    return send(res, 200, { id, state: to });
  }

  send(res, 404, { error: 'ukjent admin-adresse' });
}

/* ---------- Statiske filer ---------- */

async function handleStatic(res, url) {
  let rel;
  try {
    rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  } catch {
    return send(res, 400, 'Ugyldig adresse', 'text/plain; charset=utf-8');
  }
  const file = path.normalize(path.join(APP_DIR, rel));
  if (!file.startsWith(APP_DIR + path.sep)) return send(res, 403, 'Forbudt', 'text/plain');
  try {
    send(res, 200, await readFile(file), TYPES[path.extname(file)] || 'application/octet-stream');
  } catch {
    send(res, 404, 'Fant ikke siden', 'text/plain; charset=utf-8');
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/healthz') return send(res, 200, 'ok', 'text/plain');
    if (url.pathname === '/api/save') {
      if (req.method !== 'POST') return send(res, 405, { error: 'bruk POST' });
      return await handleSave(req, res, url);
    }
    if (url.pathname === '/admin' || url.pathname.startsWith('/admin/') || url.pathname.startsWith('/api/admin/')) {
      return await handleAdmin(req, res, url);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Ikke tillatt', 'text/plain');
    await handleStatic(res, url);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) send(res, 500, { error: 'serverfeil' });
  }
});

for (const s of STATES) await mkdir(dir(s), { recursive: true });

/**
 * Sjekker om porten er ledig på både IPv4 og IPv6. Et annet program (f.eks. `npx serve`) kan lytte
 * kun på IPv6 – da ville vi ellers startet «ved siden av» det, og localhost kunne havnet hos feil server.
 */
function canListen(port, host) {
  return new Promise(resolve => {
    const probe = createServer();
    probe.once('error', err => resolve(err.code === 'EADDRNOTAVAIL' || err.code === 'EAFNOSUPPORT'));
    probe.listen(port, host, () => probe.close(() => resolve(true)));
  });
}
const isFree = async port => {
  for (const host of ['127.0.0.1', '::1', '0.0.0.0', '::']) {
    if (!(await canListen(port, host))) return false;
  }
  return true;
};

// Er porten opptatt, prøver vi de neste 10 – med mindre PORT er satt eksplisitt (som i Docker).
let port = PORT;
if (port !== 0 && !process.env.PORT) {
  while (!(await isFree(port))) {
    if (port >= PORT + 10) {
      console.error(`Port ${port} er opptatt. Stopp det andre programmet eller velg en annen port: PORT=4000 npm start`);
      process.exit(1);
    }
    console.log(`Port ${port} er opptatt av et annet program, prøver ${port + 1} …`);
    port++;
  }
}
server.listen(port, HOST, () => {
  const { port: actual } = server.address();
  console.log(`\nMus vs. Trackpad kjører på http://127.0.0.1:${actual}`);
  console.log(`Innsendinger lagres i ${RESULTS_DIR}/venter/ til de godkjennes`);
  console.log(ADMIN_HASH ? `Admin: http://127.0.0.1:${actual}/admin` : 'Admin er slått av (sett ADMIN_PASSWORD for å slå den på)');
  console.log('Stopp med Ctrl+C');
});

const shutdown = () => server.close(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
