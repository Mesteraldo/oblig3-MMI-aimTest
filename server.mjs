// Server for Mus vs. Trackpad. TESTINGEN ER FERDIG: alle offentlige adresser viser bare stengt/index.html
// («Innsending er ferdig, takk for bidrag!»), og /api/save tar ikke imot nye innsendinger.
// /admin (passordbeskyttet) er beholdt så innsamlede data fortsatt kan ses og lastes ned.
// Kjør lokalt: npm start   (admin: ADMIN_PASSWORD=hemmelig npm start → http://127.0.0.1:3000/admin)
// Miljøvariabler (se .env.example):
//   PORT            standard 3000
//   HOST            standard 127.0.0.1 (Dockerfile setter 0.0.0.0)
//   RESULTS_DIR     standard ./resultater (Docker: /data)
//   ADMIN_PASSWORD  passord for /admin. Uten det er admin slått av.
//
// Lagring: innsendingene ligger i RESULTS_DIR/venter/, godkjent/ og avvist/. Admin kan fortsatt flytte
// mellom dem og laste ned de godkjente.
import { createServer } from 'node:http';
import { readFile, mkdir, readdir, rename } from 'node:fs/promises';
import { createHash, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CLOSED_FILE = path.join(ROOT, 'stengt', 'index.html');
const ADMIN_FILE = path.join(ROOT, 'admin', 'index.html');
const RESULTS_DIR = path.resolve(process.env.RESULTS_DIR || path.join(ROOT, 'resultater'));
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

const STORED_NAME = /^gjennomgang_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}(-\d+)?\.json$/;
const STATES = ['venter', 'godkjent', 'avvist'];
const TYPES = { '.html': 'text/html; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.json': 'application/json' };

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

/* ---------- Lagring ---------- */

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

/* ---------- Stengt-side ---------- */

async function handleClosed(req, res) {
  send(res, 200, req.method === 'HEAD' ? '' : await readFile(CLOSED_FILE), TYPES['.html']);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/healthz') return send(res, 200, 'ok', 'text/plain');
    // Testingen er ferdig – nye innsendinger avvises.
    if (url.pathname === '/api/save') return send(res, 410, { error: 'innsendingen er stengt' });
    if (url.pathname === '/admin' || url.pathname.startsWith('/admin/') || url.pathname.startsWith('/api/admin/')) {
      return await handleAdmin(req, res, url);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Ikke tillatt', 'text/plain');
    await handleClosed(req, res);
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
  console.log(`\nMus vs. Trackpad (stengt) kjører på http://127.0.0.1:${actual}`);
  console.log(ADMIN_HASH ? `Admin: http://127.0.0.1:${actual}/admin` : 'Admin er slått av (sett ADMIN_PASSWORD for å slå den på)');
  console.log('Stopp med Ctrl+C');
});

const shutdown = () => server.close(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
