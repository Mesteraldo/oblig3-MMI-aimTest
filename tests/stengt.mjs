// Test for stengt nettsted: alle offentlige adresser viser bare «Innsending er ferdig», innsending er avvist,
// og /admin + /healthz virker fortsatt. Kjør: npm test
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASSWORD = 'test-passord';
const resultsDir = await mkdtemp(path.join(tmpdir(), 'aimtest-'));
const server = spawn(process.execPath, ['server.mjs'], {
  cwd: ROOT,
  env: { ...process.env, PORT: '0', RESULTS_DIR: resultsDir, ADMIN_PASSWORD: PASSWORD },
  stdio: ['ignore', 'pipe', 'inherit']
});
const base = await new Promise((resolve, reject) => {
  let out = '';
  server.stdout.on('data', c => {
    out += c;
    const m = /http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
    if (m) resolve(`http://127.0.0.1:${m[1]}`);
  });
  server.once('exit', code => reject(new Error(`server stoppet (${code})`)));
});

try {
  for (const p of ['/', '/index.html', '/README.md', '/noe/annet']) {
    const r = await fetch(base + p);
    assert.equal(r.status, 200, p);
    const html = await r.text();
    assert.match(html, /Innsending er ferdig/, p);
    assert.match(html, /Takk for bidrag!/, p);
    assert.doesNotMatch(html, /trackpad/i, `${p} skal ikke vise testen`);
  }
  const save = await fetch(base + '/api/save?filename=gjennomgang_2026-01-01_00-00-00.json', { method: 'POST', body: '{}' });
  assert.equal(save.status, 410);
  assert.equal((await fetch(base + '/healthz')).status, 200);
  assert.equal((await fetch(base + '/admin')).status, 401);
  const auth = { authorization: 'Basic ' + Buffer.from(`x:${PASSWORD}`).toString('base64') };
  assert.equal((await fetch(base + '/admin', { headers: auth })).status, 200);
  assert.equal((await fetch(base + '/api/admin/list', { headers: auth })).status, 200);
  console.log('OK: nettstedet er stengt og viser bare takkesiden.');
} finally {
  server.kill();
  await rm(resultsDir, { recursive: true, force: true });
}
