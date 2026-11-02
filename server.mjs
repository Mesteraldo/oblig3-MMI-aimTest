// Lokal server for Mus vs. Trackpad. Serverer mouse-test/ og lagrer gjennomganger i resultater/.
// Kjør: npm start   (eller: node server.mjs)
// Miljøvariabler: PORT (standard 3000), RESULTS_DIR (standard ./resultater)
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.join(ROOT, 'mouse-test');
const RESULTS_DIR = path.resolve(process.env.RESULTS_DIR || path.join(ROOT, 'resultater'));
const PORT = Number(process.env.PORT || 3000);
const MAX_BODY = 1024 * 1024;
const FILENAME = /^gjennomgang_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.json$/;
const TYPES = { '.html': 'text/html; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.json': 'application/json' };

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
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

/** Skriver filen uten å overskrive: legger på -2, -3 … hvis navnet finnes. */
async function writeUnique(filename, content) {
  const base = filename.replace(/\.json$/, '');
  for (let n = 1; n < 1000; n++) {
    const name = n === 1 ? filename : `${base}-${n}.json`;
    try {
      await writeFile(path.join(RESULTS_DIR, name), content, { flag: 'wx' });
      return name;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
  throw new Error('fant ikke ledig filnavn');
}

async function handleSave(req, res, url) {
  const filename = url.searchParams.get('filename') || '';
  if (!FILENAME.test(filename)) return send(res, 400, { error: 'ugyldig filnavn' });
  let data;
  try {
    data = JSON.parse(await readBody(req));
  } catch {
    return send(res, 400, { error: 'ugyldig JSON' });
  }
  if (!data || !data.participant || !Array.isArray(data.tests)) return send(res, 400, { error: 'mangler participant/tests' });
  await mkdir(RESULTS_DIR, { recursive: true });
  const name = await writeUnique(filename, JSON.stringify(data, null, 2) + '\n');
  console.log(`Lagret ${path.join(RESULTS_DIR, name)}`);
  send(res, 200, { path: `${path.basename(RESULTS_DIR)}/${name}` });
}

async function handleStatic(res, url) {
  const rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
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
    if (url.pathname === '/api/save') {
      if (req.method !== 'POST') return send(res, 405, { error: 'bruk POST' });
      return await handleSave(req, res, url);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Ikke tillatt', 'text/plain');
    await handleStatic(res, url);
  } catch (err) {
    console.error(err);
    send(res, 500, { error: 'serverfeil' });
  }
});

await mkdir(RESULTS_DIR, { recursive: true });

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

// Er porten opptatt, prøver vi de neste 10 – med mindre PORT er satt eksplisitt.
let port = PORT;
if (port !== 0) {
  const autoPort = !process.env.PORT;
  while (!(await isFree(port))) {
    if (!autoPort || port >= PORT + 10) {
      console.error(`Port ${port} er opptatt. Stopp det andre programmet eller velg en annen port: PORT=4000 npm start`);
      process.exit(1);
    }
    console.log(`Port ${port} er opptatt av et annet program, prøver ${port + 1} …`);
    port++;
  }
}
server.listen(port, '127.0.0.1', () => {
  const { port: actual } = server.address();
  console.log(`\nMus vs. Trackpad kjører på http://127.0.0.1:${actual}`);
  console.log(`Gjennomganger lagres i ${RESULTS_DIR}`);
  console.log('Stopp med Ctrl+C');
});
