// Ende-til-ende-test for mouse-test/index.html og server.mjs (Playwright, headless Chromium).
// Kjør: node tests/e2e.mjs   (eller: npm test)
import { chromium } from 'playwright';
import { readFile, readdir, mkdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_DIR = path.join(ROOT, 'mouse-test');
const APP_FILE = path.join(APP_DIR, 'index.html');
const SHOT_DIR = path.join(ROOT, 'tests', 'screenshots');
const OUT_DIR = path.join(ROOT, 'tests', 'output');
// Testkjøringen bruker sin egen resultater-mappe, så ekte data i ./resultater ikke blandes med testdata.
const TEST_RESULTS_DIR = path.join(OUT_DIR, 'resultater');
const PENDING_DIR = path.join(TEST_RESULTS_DIR, 'venter');
const ADMIN_PASSWORD = 'test-passord';

const TARGETS = 20;
const MARGIN = 32 + 16;
const PLAN = [
  { type: 'trackpad', attempt: 1 }, { type: 'trackpad', attempt: 2 }, { type: 'trackpad', attempt: 3 },
  { type: 'external_mouse', attempt: 1 }, { type: 'external_mouse', attempt: 2 }, { type: 'external_mouse', attempt: 3 }
];
const LABELS = {
  trackpad: { label: 'Trackpad test', heading: 'TRACKPAD TEST', device: 'Bruk kun trackpaden' },
  external_mouse: { label: 'Ekstern mus test', heading: 'EKSTERN MUS TEST', device: 'Bruk kun den eksterne musa' }
};
// Tre gjennomganger: lagre via serveren (→ mappe), lagre via file:// (→ nedlasting), og «Ikke lagre».
const RUNS = [
  { name: 'server-lagre', width: 1440, height: 900, via: 'server', decision: 'save',
    participant: { age: 24, gender: 'kvinne', preference: 'trackpad' }, screenshots: true, printJson: true },
  { name: 'file-lagre', width: 1024, height: 700, via: 'file', decision: 'save',
    participant: { age: 31, gender: 'annet', preference: 'ingen' }, screenshots: true },
  { name: 'server-ikke-lagre', width: 1024, height: 700, via: 'server', decision: 'discard',
    participant: { age: 52, gender: 'mann', preference: 'mus' } }
];

/* ---------- PASS/FAIL-rapportering ---------- */
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok });
  const line = `${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`;
  console.log(ok ? line : `\x1b[31m${line}\x1b[0m`);
  return !!ok;
}
async function guarded(name, fn) {
  try {
    await fn();
  } catch (err) {
    check(name, false, 'unntak: ' + (err && err.message ? err.message.split('\n')[0] : err));
  }
}

/* ---------- Uavhengig referanseberegning ---------- */
const r1 = n => Math.round(n * 10) / 10;
function expectedStats(times, misses) {
  let total = 0, li = 0, si = 0;
  times.forEach((t, i) => {
    total += t;
    if (t > times[li]) li = i;
    if (t < times[si]) si = i;
  });
  return {
    totalTimeMs: r1(total),
    averageTimeMs: r1(total / times.length),
    longestTimeMs: times[li], longestTargetIndex: li + 1,
    shortestTimeMs: times[si], shortestTargetIndex: si + 1,
    totalMisses: misses.reduce((a, b) => a + b, 0)
  };
}
function expectedMediumAverage(observed, type) {
  const tests = observed.filter(o => o.type === type);
  const total = tests.reduce((a, o) => a + o.exp.totalTimeMs, 0);
  return r1(total / (tests.length * TARGETS));
}
const nb1 = n => n.toLocaleString('nb-NO', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const nbS = ms => (ms / 1000).toLocaleString('nb-NO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const norm = s => s.replace(/[  ]/g, ' ');
const approx = (a, b, eps = 0.051) => Math.abs(a - b) <= eps;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const isNum = v => typeof v === 'number' && Number.isFinite(v);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const FILENAME = /^gjennomgang_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}(-\d+)?\.json$/;

/* ---------- Hjelpere ---------- */
async function shot(page, run, name) {
  if (run.screenshots) await page.screenshot({ path: path.join(SHOT_DIR, `${run.width}x${run.height}-${run.name}-${name}.png`) });
}
const visibleTargets = page => page.locator('[data-testid=target]:visible').count();
// textContent (ikke innerText) slik at CSS text-transform ikke påvirker sammenligningen.
const text = async (page, id) => norm((await page.getByTestId(id).textContent()).replace(/\s+/g, ' ').trim());
const listResults = async (state = 'venter') =>
  (await readdir(path.join(TEST_RESULTS_DIR, state)).catch(() => [])).filter(f => f.endsWith('.json')).sort();

async function fillParticipant(page, p) {
  await page.getByTestId('age-input').fill(String(p.age));
  await page.getByTestId('gender-select').selectOption(p.gender);
  await page.getByTestId(`preference-${p.preference}`).check();
}

/** Starter server.mjs på en ledig port med testens egen resultater-mappe. */
async function startAppServer() {
  const child = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
    env: { ...process.env, PORT: '0', RESULTS_DIR: TEST_RESULTS_DIR, ADMIN_PASSWORD },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const url = await new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error('server.mjs startet ikke: ' + out)), 5000);
    child.stdout.on('data', d => {
      out += d;
      const m = out.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) { clearTimeout(timer); resolve(`http://127.0.0.1:${m[1]}/`); }
    });
    child.stderr.on('data', d => { out += d; });
    child.on('exit', code => reject(new Error(`server.mjs avsluttet (${code}): ${out}`)));
  });
  return { url, stop: () => child.kill() };
}

/**
 * Kjører én test (instruksjon → nedtelling → 20 targets → resultatskjerm).
 * Returnerer data lest fra DOM-en underveis.
 */
async function runOneTest(page, run, seq) {
  const { type, attempt } = PLAN[seq - 1];
  const L = LABELS[type];
  const tag = `[${run.name}] Test ${seq}/6 ${L.label} #${attempt}`;
  const shots = run.screenshots && (seq === 1 || seq === 4) ? (seq === 1 ? '02-trackpad1' : '03-mouse1') : null;

  // Instruksjonsskjerm
  await page.getByTestId('screen-instruction').waitFor({ state: 'visible' });
  const heading = await text(page, 'instruction-title');
  const device = await text(page, 'instruction-device');
  const att = await text(page, 'instruction-attempt');
  const prog = await text(page, 'session-progress');
  check(`${tag}: instruksjon «${L.heading}», «Forsøk ${attempt} av 3», «Test ${seq} av 6»`,
    heading === L.heading && device === L.device && att === `Forsøk ${attempt} av 3` && prog.endsWith(`Test ${seq} av 6`),
    `fikk «${heading}» / «${device}» / «${att}» / «${prog}»`);
  if (shots) await shot(page, run, `${shots}-1-instruction`);

  await page.getByTestId('instruction-start').click();
  await page.getByTestId('countdown').waitFor({ state: 'visible' });
  const titleDuringCountdown = await page.getByTestId('test-title').isVisible();
  if (shots) {
    await sleep(350); // la pop-animasjonen på tallet bli synlig
    await shot(page, run, `${shots}-2-countdown`);
  }
  check(`${tag}: nedtelling vises, ingen target før den er ferdig`,
    (await visibleTargets(page)) === 0 && titleDuringCountdown);

  await page.locator('[data-testid=target][data-index="1"][data-ready="1"]').waitFor({ timeout: 6000 });

  const arena = await page.getByTestId('arena').evaluate(el => {
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, width: el.clientWidth, height: el.clientHeight };
  });
  const minDist = 0.25 * Math.min(arena.width, arena.height);

  let titleAlwaysOk = true, oneTargetOk = true, inBoundsOk = true, notSameOk = true, distOk = true, progressOk = true;
  const positions = [];
  const missPlan = { 1: 1, 5: 2 }; // target-nr → antall bevisste bom
  let missCheckOk = true, missDetail = '';
  let missesSoFar = 0;

  for (let i = 1; i <= TARGETS; i++) {
    const t = page.locator(`[data-testid=target][data-index="${i}"][data-ready="1"]`);
    await t.waitFor({ timeout: 4000 });

    const title = page.getByTestId('test-title');
    if (!(await title.isVisible()) || (await title.textContent()).trim() !== L.label ||
        (await text(page, 'test-attempt')) !== `forsøk ${attempt} av 3`) titleAlwaysOk = false;
    if ((await visibleTargets(page)) !== 1) oneTargetOk = false;
    if ((await text(page, 'progress')) !== `Target ${i} / ${TARGETS}`) progressOk = false;

    const x = Number(await t.getAttribute('data-x'));
    const y = Number(await t.getAttribute('data-y'));
    const box = await t.boundingBox();
    const boxInside =
      box.x - arena.x >= 16 - 0.5 && box.y - arena.y >= 16 - 0.5 &&
      arena.x + arena.width - (box.x + box.width) >= 16 - 0.5 &&
      arena.y + arena.height - (box.y + box.height) >= 16 - 0.5 &&
      Math.abs(box.width - 64) < 0.5 && Math.abs(box.height - 64) < 0.5;
    if (x < MARGIN || x > arena.width - MARGIN || y < MARGIN || y > arena.height - MARGIN || !boxInside) inBoundsOk = false;
    const prev = positions[positions.length - 1];
    if (prev) {
      if (prev.x === x && prev.y === y) notSameOk = false;
      if (Math.hypot(prev.x - x, prev.y - y) < minDist) distOk = false;
    }
    positions.push({ x, y });

    // Bevisste bom: klikk i hjørnet lengst unna target
    for (let m = 0; m < (missPlan[i] || 0); m++) {
      const corners = [[20, 20], [arena.width - 20, 20], [20, arena.height - 20], [arena.width - 20, arena.height - 20]];
      corners.sort((a, b) => Math.hypot(b[0] - x, b[1] - y) - Math.hypot(a[0] - x, a[1] - y));
      const [mx, my] = corners[m % corners.length];
      await page.mouse.click(arena.x + mx, arena.y + my);
      missesSoFar++;
      const missText = await text(page, 'header-misses');
      const progAfter = await text(page, 'progress');
      const idxAfter = await page.getByTestId('target').getAttribute('data-index');
      if (missText !== `Bom: ${missesSoFar}` || progAfter !== `Target ${i} / ${TARGETS}` || idxAfter !== String(i)) {
        missCheckOk = false;
        missDetail = `etter bom: «${missText}», «${progAfter}», index=${idxAfter}`;
      }
      if (shots && i === 1 && m === 0) await shot(page, run, `${shots}-3-test-miss`);
    }

    await sleep(15 + Math.floor(Math.random() * 70)); // variasjon i tidene
    await page.mouse.click(arena.x + x, arena.y + y);
  }

  check(`${tag}: test-title og forsøksnummer synlig gjennom hele testen`, titleAlwaysOk);
  check(`${tag}: nøyaktig ett target synlig om gangen`, oneTargetOk);
  check(`${tag}: fremdrift «Target n / 20» korrekt`, progressOk);
  check(`${tag}: alle 20 posisjoner innenfor arenaen med marg ${MARGIN}px`, inBoundsOk && positions.length === 20);
  check(`${tag}: ingen to etterfølgende posisjoner identiske, avstand ≥ ${minDist.toFixed(0)}px`, notSameOk && distOk);
  check(`${tag}: bom øker bom-teller uten å endre fremdrift (${missesSoFar} bom)`, missCheckOk, missDetail);

  // Resultatskjerm for denne testen
  await page.getByTestId('screen-result').waitFor({ state: 'visible', timeout: 4000 });
  const rTitle = await text(page, 'result-title');
  check(`${tag}: resultatskjerm «Resultat: ${L.label} – forsøk ${attempt} av 3»`,
    rTitle === `Resultat: ${L.label} – forsøk ${attempt} av 3`, rTitle);
  check(`${tag}: ingen Lagre/Ikke lagre før alle 6 er ferdige`,
    !(await page.getByTestId('save-button').isVisible()) && !(await page.getByTestId('discard-button').isVisible()));

  const rows = await page.$$eval('[data-testid=result-table] tbody tr', trs => trs.map(tr => ({
    index: Number(tr.dataset.index), timeMs: Number(tr.dataset.time), misses: Number(tr.dataset.misses),
    cells: [...tr.children].map(td => td.textContent)
  })));
  const tableOk = rows.length === 20 && rows.every((r, k) =>
    r.index === k + 1 && r.cells[0] === String(k + 1) && r.cells[1] === nb1(r.timeMs) &&
    r.cells[2] === String(r.misses) && r.misses === (missPlan[r.index] || 0));
  check(`${tag}: tabell med 20 rader, nb-NO-formatert, bom på riktig target`, tableOk);

  const exp = expectedStats(rows.map(r => r.timeMs), rows.map(r => r.misses));
  const card = async id => {
    const l = page.getByTestId(id);
    return {
      value: Number(await l.getAttribute('data-value')),
      index: Number(await l.getAttribute('data-index')),
      text: norm((await l.innerText()).replace(/\s+/g, ' ').trim())
    };
  };
  const total = await card('stat-total');
  const avg = await card('stat-average');
  const longest = await card('stat-longest');
  const shortest = await card('stat-shortest');
  const misses = await card('stat-misses');
  check(`${tag}: stat-total ${nb1(exp.totalTimeMs)} ms / ${nbS(exp.totalTimeMs)} s, stat-average ${nb1(exp.averageTimeMs)} ms`,
    approx(total.value, exp.totalTimeMs) && total.text.includes(norm(`${nb1(exp.totalTimeMs)} ms`)) &&
    total.text.includes(norm(`${nbS(exp.totalTimeMs)} s`)) &&
    approx(avg.value, exp.averageTimeMs) && avg.text.includes(norm(`${nb1(exp.averageTimeMs)} ms`)),
    `${total.text} | ${avg.text}`);
  check(`${tag}: stat-longest ${nb1(exp.longestTimeMs)} ms (#${exp.longestTargetIndex}), stat-shortest ${nb1(exp.shortestTimeMs)} ms (#${exp.shortestTargetIndex})`,
    longest.value === exp.longestTimeMs && longest.index === exp.longestTargetIndex &&
    longest.text.includes(norm(`${nb1(exp.longestTimeMs)} ms`)) && longest.text.includes(`Target ${exp.longestTargetIndex}`) &&
    shortest.value === exp.shortestTimeMs && shortest.index === exp.shortestTargetIndex &&
    shortest.text.includes(norm(`${nb1(exp.shortestTimeMs)} ms`)) && shortest.text.includes(`Target ${exp.shortestTargetIndex}`),
    `${longest.text} | ${shortest.text}`);
  check(`${tag}: stat-misses = ${exp.totalMisses}`, misses.value === exp.totalMisses && misses.value === missesSoFar);

  const nextText = await text(page, 'next-button');
  const nextP = PLAN[seq];
  const wantNext = nextP ? `Neste: ${LABELS[nextP.type].label}, forsøk ${nextP.attempt} av 3 →` : 'Se oppsummering →';
  check(`${tag}: neste-knapp «${wantNext}»`, nextText === wantNext, nextText);
  if (shots) await shot(page, run, `${shots}-4-result`);

  return { type, attempt, rows, exp };
}

/**
 * Validerer den lagrede filen: kun deltakerinfo og tidene per test –
 * ingen target-indekser eller koordinater.
 */
function validateSessionJson(json, participant, observed) {
  const errors = [];
  const keys = (o, expected, where) => {
    const got = Object.keys(o || {}).join(',');
    const want = expected.join(',');
    if (got !== want) errors.push(`${where}: nøkler [${got}] ≠ [${want}]`);
  };
  keys(json, ['schemaVersion', 'completedAt', 'participant', 'tests'], 'rot');
  if (json.schemaVersion !== 3) errors.push('schemaVersion ≠ 3');
  if (typeof json.completedAt !== 'string' || !ISO.test(json.completedAt)) errors.push('completedAt');
  keys(json.participant, ['age', 'gender', 'preference'], 'participant');
  if (JSON.stringify(json.participant) !== JSON.stringify(participant)) errors.push(`participant ${JSON.stringify(json.participant)}`);
  if (!Array.isArray(json.tests) || json.tests.length !== 6) { errors.push('tests.length ≠ 6'); return errors; }

  const testKeys = ['testType', 'attempt', 'totalTimeMs', 'averageTimeMs', 'longestTimeMs', 'shortestTimeMs', 'totalMisses', 'timesBetweenClicksMs'];
  json.tests.forEach((t, i) => {
    const w = `tests[${i}]`, o = observed[i];
    keys(t, testKeys, w);
    if (t.testType !== PLAN[i].type || t.attempt !== PLAN[i].attempt) errors.push(`${w}: ${t.testType}#${t.attempt} ≠ ${PLAN[i].type}#${PLAN[i].attempt}`);
    for (const k of testKeys.slice(2, 7)) if (!isNum(t[k])) errors.push(`${w}.${k} ikke tall`);
    if (!Number.isInteger(t.totalMisses)) errors.push(`${w}.totalMisses ikke heltall`);
    const times = t.timesBetweenClicksMs;
    if (!Array.isArray(times) || times.length !== 20 || !times.every(v => isNum(v) && v > 0)) {
      errors.push(`${w}.timesBetweenClicksMs: 20 positive tall`);
      return;
    }
    // Stemmer med det skjermen viste
    if (JSON.stringify(times) !== JSON.stringify(o.rows.map(r => r.timeMs))) errors.push(`${w}.timesBetweenClicksMs ≠ tabell`);
    if (t.totalTimeMs !== o.exp.totalTimeMs || t.averageTimeMs !== o.exp.averageTimeMs ||
        t.longestTimeMs !== o.exp.longestTimeMs || t.shortestTimeMs !== o.exp.shortestTimeMs ||
        t.totalMisses !== o.exp.totalMisses) errors.push(`${w}: stats ≠ skjerm`);
    // Internt konsistent
    const sum = times.reduce((a, b) => a + b, 0);
    if (!approx(sum, t.totalTimeMs)) errors.push(`${w}: totalTimeMs ${t.totalTimeMs} ≠ sum ${sum}`);
    if (!approx(t.totalTimeMs / 20, t.averageTimeMs)) errors.push(`${w}: averageTimeMs ≠ total/20`);
    if (t.longestTimeMs !== Math.max(...times) || t.shortestTimeMs !== Math.min(...times)) errors.push(`${w}: lengste/korteste`);
  });
  const raw = JSON.stringify(json);
  for (const banned of ['"index"', 'targetX', 'targetY', 'clickX', 'clickY', 'offsetPx', 'TargetIndex', '"arena"']) {
    if (raw.includes(banned)) errors.push(`inneholder ${banned}`);
  }
  return errors;
}

/** Skriver JSON kompakt: én linje per test. */
function prettyJson(json) {
  const { tests, ...rest } = json;
  const head = JSON.stringify(rest, null, 2).replace(/\n}$/, '');
  return head + ',\n  "tests": [\n' + tests.map(t => '    ' + JSON.stringify(t)).join(',\n') + '\n  ]\n}';
}

/* ---------- Én full gjennomgang ---------- */
async function runSession(browser, run, appUrl) {
  const tag = `[${run.name} ${run.width}x${run.height}]`;
  const size = { width: run.width, height: run.height };
  const context = await browser.newContext({ viewport: size, acceptDownloads: true, locale: 'nb-NO' });
  const page = await context.newPage();
  const origin = run.via === 'server' ? new URL(appUrl).origin : null;
  const externalRequests = [];
  page.on('request', r => {
    const u = r.url();
    if (/^(file|data|blob):/.test(u) || (origin && u.startsWith(origin + '/'))) return;
    externalRequests.push(u);
  });
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  const downloads = [];
  page.on('download', d => downloads.push(d));

  await page.goto(appUrl);

  // Startskjerm og skjemavalidering
  await guarded(`${tag} startskjerm`, async () => {
    const t = await text(page, 'screen-start');
    check(`${tag} startskjerm: tittel, forklaring om 6 tester og skjema for alder/kjønn/preferanse`,
      await page.getByTestId('screen-start').isVisible() &&
      t.includes('Mus vs. Trackpad') && t.includes('først 3 × Trackpad test, så 3 × Ekstern mus test') &&
      t.includes('Alder') && t.includes('Kjønn') && t.includes('Trackpad') && t.includes('Mus') && t.includes('Ingen') &&
      (await text(page, 'start-button')) === 'Start gjennomgangen');
    await shot(page, run, '01-start');

    await page.getByTestId('start-button').click();
    const e1 = await text(page, 'form-error');
    await page.getByTestId('age-input').fill('200');
    await page.getByTestId('start-button').click();
    const e2 = await text(page, 'form-error');
    await page.getByTestId('age-input').fill(String(run.participant.age));
    await page.getByTestId('gender-select').selectOption(run.participant.gender);
    await page.getByTestId('start-button').click();
    const e3 = await text(page, 'form-error');
    await shot(page, run, '01b-start-validation');
    check(`${tag} skjema: manglende/ugyldig alder, kjønn og preferanse stopper start`,
      e1.startsWith('Skriv inn alder') && e2.startsWith('Skriv inn alder') && e3.startsWith('Velg hva du foretrekker') &&
      await page.getByTestId('screen-start').isVisible(), `${e1} | ${e2} | ${e3}`);
    await fillParticipant(page, run.participant);
    check(`${tag} skjema: feilmeldingen forsvinner når skjemaet endres`, await page.getByTestId('form-error').isHidden());
    await shot(page, run, '01c-start-filled');
  });

  // Esc, vindusendring og avbryt gjennomgang (én gang per viewport er nok)
  if (run.screenshots) {
    await guarded(`${tag} avbrudd`, async () => {
      await page.getByTestId('start-button').click();
      await page.getByTestId('instruction-start').click();
      await page.locator('[data-testid=target][data-ready="1"]').waitFor({ timeout: 6000 });
      await page.keyboard.press('Escape');
      await page.getByTestId('screen-instruction').waitFor({ state: 'visible', timeout: 2000 });
      const n1 = await text(page, 'instruction-notice');
      check(`${tag} Esc under test → tilbake til samme forsøk (Test 1 av 6, forsøk 1) med melding`,
        n1.includes('avbrutt med Esc') && (await text(page, 'instruction-attempt')) === 'Forsøk 1 av 3' &&
        (await text(page, 'session-progress')).endsWith('Test 1 av 6') && downloads.length === 0, n1);

      await page.getByTestId('instruction-start').click();
      await page.locator('[data-testid=target][data-ready="1"]').waitFor({ timeout: 6000 });
      await page.setViewportSize({ width: run.width - 100, height: run.height - 50 });
      await page.getByTestId('screen-instruction').waitFor({ state: 'visible', timeout: 2000 });
      const n2 = await text(page, 'instruction-notice');
      check(`${tag} vindusendring avbryter med «Vinduet ble endret – ta testen på nytt»`,
        n2 === 'Vinduet ble endret – ta testen på nytt', n2);
      await page.setViewportSize(size);
      await sleep(100);
      await shot(page, run, '01d-instruction-notice');

      await page.getByTestId('abort-session').click();
      const stillThere = await page.getByTestId('screen-instruction').isVisible();
      const armed = await text(page, 'abort-session');
      await page.getByTestId('abort-session').click();
      await page.getByTestId('screen-start').waitFor({ state: 'visible', timeout: 2000 });
      check(`${tag} «Avbryt gjennomgang» krever bekreftelse og går til start uten lagring`,
        stillThere && armed.startsWith('Klikk igjen') &&
        (await text(page, 'notice')) === 'Gjennomgangen ble avbrutt. Ingenting ble lagret.' &&
        (await page.getByTestId('age-input').inputValue()) === '' && downloads.length === 0);
      await fillParticipant(page, run.participant);
    });
  }

  // Hovedflyt: 6 tester → oppsummering → lagre / ikke lagre
  await guarded(`${tag} hovedflyt`, async () => {
    const filesBefore = await listResults();
    await page.getByTestId('start-button').click();

    const observed = [];
    for (let seq = 1; seq <= 6; seq++) {
      observed.push(await runOneTest(page, run, seq));
      await page.getByTestId('next-button').click();
    }
    check(`${tag} ingenting lagret underveis i de 6 testene`,
      downloads.length === 0 && (await listResults()).length === filesBefore.length);

    // Oppsummering
    await page.getByTestId('screen-final').waitFor({ state: 'visible' });
    const chips = await text(page, 'participant-summary');
    const genderLabel = { kvinne: 'Kvinne', mann: 'Mann', annet: 'Annet', vil_ikke_oppgi: 'Vil ikke oppgi' }[run.participant.gender];
    const prefLabel = { trackpad: 'Trackpad', mus: 'Mus', ingen: 'Ingen' }[run.participant.preference];
    check(`${tag} oppsummering viser alder, kjønn og preferanse`,
      chips.includes(`Alder: ${run.participant.age}`) && chips.includes(`Kjønn: ${genderLabel}`) && chips.includes(`Foretrekker: ${prefLabel}`), chips);
    const sumRows = await page.$$eval('[data-testid=summary-table] tbody tr', trs => trs.map(tr => ({
      type: tr.dataset.type, attempt: Number(tr.dataset.attempt), total: Number(tr.dataset.total), average: Number(tr.dataset.average)
    })));
    check(`${tag} oppsummeringstabell: 6 rader i rekkefølgen Trackpad 1–3, Mus 1–3 med riktige tall`,
      sumRows.length === 6 && sumRows.every((r, i) =>
        r.type === PLAN[i].type && r.attempt === PLAN[i].attempt &&
        approx(r.total, observed[i].exp.totalTimeMs) && approx(r.average, observed[i].exp.averageTimeMs)));
    let mediumOk = true;
    for (const type of ['trackpad', 'external_mouse']) {
      const v = Number(await page.getByTestId(`final-${type}`).locator('dd[data-key=averageTimeMs]').getAttribute('data-value'));
      if (!approx(v, expectedMediumAverage(observed, type))) mediumOk = false;
    }
    check(`${tag} snitt per medium (over 60 targets) stemmer for trackpad og mus`, mediumOk);
    check(`${tag} Lagre/Ikke lagre vises først nå`,
      await page.getByTestId('save-button').isVisible() && await page.getByTestId('discard-button').isVisible() &&
      !(await page.getByTestId('restart-button').isVisible()));
    await shot(page, run, '04-final');

    if (run.decision === 'save' && run.via === 'server') {
      await page.getByTestId('save-button').click();
      await page.getByTestId('restart-button').waitFor({ state: 'visible', timeout: 5000 });
      await sleep(500);
      const filesAfter = await listResults();
      const newFiles = filesAfter.filter(f => !filesBefore.includes(f));
      const status = await text(page, 'save-status');
      check(`${tag} «Send inn» via serveren skriver nøyaktig én fil til venter/ og laster ikke ned`,
        newFiles.length === 1 && downloads.length === 0, newFiles.join(', '));
      check(`${tag} filnavn gjennomgang_YYYY-MM-DD_HH-MM-SS.json og status «venter på godkjenning»`,
        FILENAME.test(newFiles[0]) && status === 'Takk! Gjennomgangen er sendt inn og lagres når den er godkjent.' &&
        (await page.getByTestId('save-status').getAttribute('data-mode')) === 'server', status);
      check(`${tag} ingenting havner i godkjent/ før admin godkjenner`, (await listResults('godkjent')).length === 0);
      const json = JSON.parse(await readFile(path.join(PENDING_DIR, newFiles[0]), 'utf8'));
      lastValidSession = json;
      const errs = validateSessionJson(json, run.participant, observed);
      check(`${tag} JSON: kun alder/kjønn/preferanse + per test total, snitt, tid mellom klikk, bom, lengste og korteste`,
        errs.length === 0, errs.slice(0, 5).join('; '));
      check(`${tag} knappene deaktiveres og «Ny gjennomgang» vises`,
        await page.getByTestId('save-button').isDisabled() && await page.getByTestId('discard-button').isDisabled());
      await shot(page, run, '05-final-saved');
      if (run.printJson) {
        console.log(`\n----- Eksempel-JSON fra testkjøringen (${path.relative(ROOT, path.join(PENDING_DIR, newFiles[0]))}) -----`);
        console.log(prettyJson(json));
        console.log('----- slutt på JSON -----\n');
      }
    } else if (run.decision === 'save') {
      const dlPromise = page.waitForEvent('download', { timeout: 5000 });
      await page.getByTestId('save-button').click();
      const dl = await dlPromise;
      await sleep(800);
      const filename = dl.suggestedFilename();
      const status = await text(page, 'save-status');
      check(`${tag} «Lagre» via file:// faller tilbake til nøyaktig én nedlasting`, downloads.length === 1 && FILENAME.test(filename), filename);
      check(`${tag} status ber brukeren flytte filen til resultater/`,
        status === `Lastet ned som ${filename} – flytt filen til resultater/-mappen` &&
        (await page.getByTestId('save-status').getAttribute('data-mode')) === 'download', status);
      const json = JSON.parse(await readFile(await dl.path(), 'utf8'));
      const errs = validateSessionJson(json, run.participant, observed);
      check(`${tag} nedlastet JSON har samme slanke format`, errs.length === 0, errs.slice(0, 5).join('; '));
      await shot(page, run, '05-final-downloaded');
    } else {
      await page.getByTestId('discard-button').click();
      await sleep(1500);
      const st = await text(page, 'save-status');
      check(`${tag} «Ikke send inn» gir verken fil i venter/ eller nedlasting`,
        downloads.length === 0 && (await listResults()).length === filesBefore.length);
      check(`${tag} viser «Gjennomgangen ble ikke sendt inn», knappene deaktiveres`,
        st === 'Gjennomgangen ble ikke sendt inn' && await page.getByTestId('save-button').isDisabled() &&
        await page.getByTestId('restart-button').isVisible(), st);
      await shot(page, run, '05-final-discarded');
    }

    await page.getByTestId('restart-button').click();
    check(`${tag} «Ny gjennomgang» går til tomt startskjema`,
      await page.getByTestId('screen-start').isVisible() && (await page.getByTestId('age-input').inputValue()) === '');
  });

  const storage = await page.evaluate(() => localStorage.length + sessionStorage.length);
  check(`${tag} ingen eksterne nettverkskall og ingen localStorage/sessionStorage`,
    externalRequests.length === 0 && storage === 0, externalRequests.join(', '));
  check(`${tag} ingen JavaScript-feil på siden`, pageErrors.length === 0, pageErrors.join('; '));
  await context.close();
}

/* ---------- Enhetstester av rene funksjoner ---------- */
async function unitTests(browser) {
  const page = await browser.newPage();
  await page.goto(pathToFileURL(APP_FILE).href);
  const r = await page.evaluate(() => {
    const { computeStats, summarizeMedium, parseParticipant, pickPosition, buildFilename, buildTestResult, buildSessionResult, PLAN } = window.MouseTest;
    const out = {};
    out.basic = computeStats([100, 200, 300]);
    out.tie = computeStats([500, 200, 500, 200, 300]);
    out.allEqual = computeStats([250, 250, 250]);
    out.decimals = computeStats([0.1, 0.2, 0.3]);
    out.decimals2 = computeStats([10.1, 20.2, 30.4]);
    out.misses = computeStats([1, 2, 3], [1, 0, 2]);
    out.twenty = computeStats(Array.from({ length: 20 }, (_, i) => 500 + i * 10.5));
    try { computeStats([]); out.emptyThrows = false; } catch { out.emptyThrows = true; }
    try { computeStats([1, NaN]); out.nanThrows = false; } catch { out.nanThrows = true; }

    const mk = (attempt, times, misses) => ({ attempt, stats: computeStats(times, misses), targets: times.map(() => ({})) });
    out.summary = summarizeMedium([mk(1, [100, 300], [1, 0]), mk(2, [100.1, 100.2], [0, 0]), mk(3, [150.1, 50.2], [0, 2])]);
    out.summaryTie = summarizeMedium([mk(1, [200, 200], []), mk(2, [100, 300], []), mk(3, [300, 100], [])]);

    out.p1 = parseParticipant('24', 'kvinne', 'trackpad');
    out.p2 = parseParticipant(' 67 ', 'vil_ikke_oppgi', 'ingen');
    out.pErr = ['', 'abc', '4', '121', '24.5'].map(a => !!parseParticipant(a, 'mann', 'mus').error)
      .concat([!!parseParticipant('24', '', 'mus').error, !!parseParticipant('24', 'mann', '').error, !!parseParticipant('24', 'mann', 'begge').error]);
    out.plan = PLAN.map(p => p.type + '#' + p.attempt).join(',');

    const t1 = buildTestResult({ type: 'trackpad' }, 2, 2, [
      { index: 1, timeMs: 400.5, misses: 1 }, { index: 2, timeMs: 250.25, misses: 0 }, { index: 3, timeMs: 610, misses: 2 }]);
    out.session = buildSessionResult({ age: 30, gender: 'mann', preference: 'mus', extra: 'x' }, [t1], new Date(Date.UTC(2026, 10, 2, 12, 0, 0)));

    let ok = true, prev = null;
    for (let i = 0; i < 2000; i++) {
      const p = pickPosition(1024, 636, prev);
      if (p.x < 48 || p.x > 1024 - 48 || p.y < 48 || p.y > 636 - 48) ok = false;
      if (prev && ((p.x === prev.x && p.y === prev.y) || Math.hypot(p.x - prev.x, p.y - prev.y) < 159)) ok = false;
      prev = p;
    }
    out.pickOk = ok;
    // 120×120: gyldig område er 48…72 → avstandskravet (30 px) er umulig fra midten og droppes,
    // men posisjonen skal fortsatt aldri gjentas og alltid ligge innenfor marg.
    let fbOk = true, fbPrev = { x: 60, y: 60 };
    for (let i = 0; i < 500; i++) {
      const p = pickPosition(120, 120, fbPrev);
      if ((p.x === fbPrev.x && p.y === fbPrev.y) || p.x < 48 || p.x > 72 || p.y < 48 || p.y > 72) fbOk = false;
      fbPrev = p;
    }
    out.fallbackOk = fbOk;
    out.filename = buildFilename(new Date(2026, 10, 2, 9, 5, 7));
    return out;
  });
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  check('computeStats: [100,200,300] → total 600, snitt 200, lengste 300 (#3), korteste 100 (#1)', eq(r.basic,
    { totalTimeMs: 600, averageTimeMs: 200, longestTimeMs: 300, longestTargetIndex: 3, shortestTimeMs: 100, shortestTargetIndex: 1, totalMisses: 0 }), JSON.stringify(r.basic));
  check('computeStats: tie-break – første forekomst vinner (lengste #1, korteste #2)', eq(r.tie,
    { totalTimeMs: 1700, averageTimeMs: 340, longestTimeMs: 500, longestTargetIndex: 1, shortestTimeMs: 200, shortestTargetIndex: 2, totalMisses: 0 }), JSON.stringify(r.tie));
  check('computeStats: alle like → lengste og korteste er begge #1', r.allEqual.longestTargetIndex === 1 && r.allEqual.shortestTargetIndex === 1 && r.allEqual.totalTimeMs === 750);
  check('computeStats: desimaler [0.1,0.2,0.3] → total 0.6 (ikke 0.6000000000000001), snitt 0.2', r.decimals.totalTimeMs === 0.6 && r.decimals.averageTimeMs === 0.2, JSON.stringify(r.decimals));
  check('computeStats: desimaler [10.1,20.2,30.4] → total 60.7, snitt 20.2 (avrundet fra 20.2333)', r.decimals2.totalTimeMs === 60.7 && r.decimals2.averageTimeMs === 20.2 && r.decimals2.longestTargetIndex === 3, JSON.stringify(r.decimals2));
  check('computeStats: totalMisses summerer bom-listen (1+0+2 = 3)', r.misses.totalMisses === 3);
  check('computeStats: 20 verdier 500…699.5 → total 11995, snitt 599.8 (599.75 avrundet)', r.twenty.totalTimeMs === 11995 && r.twenty.averageTimeMs === 599.8 && r.twenty.longestTargetIndex === 20 && r.twenty.shortestTargetIndex === 1, JSON.stringify(r.twenty));
  check('computeStats: tom liste og NaN kaster feil', r.emptyThrows && r.nanThrows);
  check('summarizeMedium: 3 forsøk → total 800.6, snitt 133.4 (800.6/6), bom 3, raskeste forsøk #2', eq(r.summary,
    { attempts: 3, totalTimeMs: 800.6, averageTimeMs: 133.4, totalMisses: 3, fastestAttempt: 2, fastestAverageTimeMs: 100.2 }), JSON.stringify(r.summary));
  check('summarizeMedium: likt snitt → første forsøk vinner (#1)', r.summaryTie.fastestAttempt === 1 && r.summaryTie.averageTimeMs === 200, JSON.stringify(r.summaryTie));
  check('buildSessionResult: kun deltaker + per test total/snitt/lengste/korteste/bom/tider, ingen indekser', eq(r.session, {
    schemaVersion: 3, completedAt: '2026-11-02T12:00:00.000Z',
    participant: { age: 30, gender: 'mann', preference: 'mus' },
    tests: [{ testType: 'trackpad', attempt: 2, totalTimeMs: 1260.8, averageTimeMs: 420.3, longestTimeMs: 610,
      shortestTimeMs: 250.25, totalMisses: 3, timesBetweenClicksMs: [400.5, 250.25, 610] }]
  }), JSON.stringify(r.session));
  check('parseParticipant: gyldige verdier gir { age, gender, preference }',
    eq(r.p1, { participant: { age: 24, gender: 'kvinne', preference: 'trackpad' } }) &&
    eq(r.p2, { participant: { age: 67, gender: 'vil_ikke_oppgi', preference: 'ingen' } }), JSON.stringify([r.p1, r.p2]));
  check('parseParticipant: tom/ikke-tall/for lav/for høy/desimal alder, manglende kjønn og ugyldig preferanse avvises', r.pErr.every(Boolean), JSON.stringify(r.pErr));
  check('PLAN: trackpad #1–3, så external_mouse #1–3', r.plan === 'trackpad#1,trackpad#2,trackpad#3,external_mouse#1,external_mouse#2,external_mouse#3', r.plan);
  check('pickPosition: 2000 trekk innenfor marg, ≥ 25 % avstand, aldri samme posisjon', r.pickOk);
  check('pickPosition: umulig avstandskrav droppes, men aldri samme posisjon', r.fallbackOk);
  check('buildFilename: gjennomgang_2026-11-02_09-05-07.json', r.filename === 'gjennomgang_2026-11-02_09-05-07.json', r.filename);
  await page.close();
}

/* ---------- server.mjs: API, godkjenning og sikkerhet ---------- */
let lastValidSession = null;

/** En gyldig gjennomgang i appens format (brukes når vi tester API-et direkte). */
function fakeSession() {
  const times = Array.from({ length: 20 }, (_, i) => 500 + i * 10);
  const total = times.reduce((a, b) => a + b, 0);
  return {
    schemaVersion: 3,
    completedAt: '2026-11-02T12:00:00.000Z',
    participant: { age: 30, gender: 'mann', preference: 'mus' },
    tests: PLAN.map(p => ({
      testType: p.type, attempt: p.attempt, totalTimeMs: total, averageTimeMs: total / 20,
      longestTimeMs: Math.max(...times), shortestTimeMs: Math.min(...times), totalMisses: 2, timesBetweenClicksMs: times
    }))
  };
}

async function serverTests(appUrl) {
  const valid = fakeSession();
  const post = (name, body, headers = {}) => fetch(new URL('api/save?filename=' + encodeURIComponent(name), appUrl),
    { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
  const before = await listResults();

  const ok1 = await post('gjennomgang_2020-01-01_00-00-00.json', JSON.stringify(valid));
  const ok2 = await post('gjennomgang_2020-01-01_00-00-00.json', JSON.stringify({ ...valid, ekstra: 'fjernes' }));
  const b1 = await ok1.json(), b2 = await ok2.json();
  check('server: innsending havner i venter/ og overskriver aldri (samme navn → -2)',
    ok1.status === 200 && ok2.status === 200 && b1.status === 'venter' &&
    b1.id === 'gjennomgang_2020-01-01_00-00-00.json' && b2.id === 'gjennomgang_2020-01-01_00-00-00-2.json', JSON.stringify([b1, b2]));
  const stored = JSON.parse(await readFile(path.join(PENDING_DIR, b2.id), 'utf8'));
  check('server: ukjente felt fjernes før lagring', !('ekstra' in stored) && stored.tests.length === 6);

  const tooFew = { ...valid, tests: valid.tests.slice(0, 5) };
  const badAge = { ...valid, participant: { ...valid.participant, age: 999 } };
  const badTimes = { ...valid, tests: valid.tests.map((t, i) => i ? t : { ...t, timesBetweenClicksMs: ['<script>'] }) };
  const bad = await Promise.all([
    post('../hack.json', JSON.stringify(valid)),
    post('gjennomgang_2020-01-01_00-00-00.json/../../x.json', JSON.stringify(valid)),
    post('gjennomgang_2020-01-01_00-00-00.json', '{ikke json'),
    post('gjennomgang_2020-01-01_00-00-00.json', JSON.stringify({ foo: 1 })),
    post('gjennomgang_2020-01-01_00-00-00.json', JSON.stringify(tooFew)),
    post('gjennomgang_2020-01-01_00-00-00.json', JSON.stringify(badAge)),
    post('gjennomgang_2020-01-01_00-00-00.json', JSON.stringify(badTimes))
  ]);
  check('server: avviser ugyldig filnavn, path traversal, ugyldig JSON, feil form og ugyldige verdier (400)',
    bad.every(r => r.status === 400) && (await listResults()).length === before.length + 2, bad.map(r => r.status).join(','));

  const rl = [];
  for (let i = 0; i < 11; i++) rl.push((await post('gjennomgang_2020-01-01_00-00-00.json', '{', { 'cf-connecting-ip': '203.0.113.9' })).status);
  check('server: maks 10 innsendinger per IP per 10 min (11. → 429)', rl.slice(0, 10).every(s => s === 400) && rl[10] === 429, rl.join(','));

  const get = await fetch(new URL('api/save', appUrl));
  const traversal = await fetch(new URL('/..%2fpackage.json', appUrl));
  const adminFile = await fetch(new URL('/admin/../server.mjs', appUrl));
  const page = await fetch(appUrl);
  const health = await fetch(new URL('healthz', appUrl));
  check('server: GET /api/save → 405, path traversal blokkeres, index.html og /healthz svarer',
    get.status === 405 && [403, 404].includes(traversal.status) && adminFile.status !== 200 && page.status === 200 &&
    (await page.text()).includes('Mus vs. Trackpad') && health.status === 200,
    `${get.status}, ${traversal.status}, ${adminFile.status}, ${page.status}, ${health.status}`);

  // ----- Admin -----
  const auth = pw => ({ authorization: 'Basic ' + Buffer.from('admin:' + pw).toString('base64') });
  const admin = (p, opts = {}) => fetch(new URL(p, appUrl), { ...opts, headers: { ...auth(ADMIN_PASSWORD), ...(opts.headers || {}) } });
  const action = (a, id, headers = { 'x-admin-action': '1' }) => admin(`api/admin/${a}?id=${encodeURIComponent(id)}`, { method: 'POST', headers });

  const noAuth = await fetch(new URL('api/admin/list', appUrl));
  const wrong = await fetch(new URL('api/admin/list', appUrl), { headers: auth('feil') });
  const noAuthApprove = await fetch(new URL('api/admin/approve?id=' + b1.id, appUrl), { method: 'POST', headers: { 'x-admin-action': '1' } });
  const adminPage = await admin('admin');
  check('admin: krever passord (401 uten / med feil), admin-siden vises med riktig',
    noAuth.status === 401 && wrong.status === 401 && noAuthApprove.status === 401 &&
    adminPage.status === 200 && (await adminPage.text()).includes('Godkjenning'), `${noAuth.status}, ${wrong.status}, ${noAuthApprove.status}, ${adminPage.status}`);

  const list = await (await admin('api/admin/list?state=venter')).json();
  check('admin: lista viser innsendingene som venter', list.counts.venter >= 2 && list.items.some(i => i.id === b1.id), JSON.stringify(list.counts));

  const csrf = await action('approve', b1.id, {});
  check('admin: godkjenning uten x-admin-action-header avvises (CSRF-vern)', csrf.status === 403 && (await listResults('godkjent')).length === 0);

  const approve = await action('approve', b1.id);
  const reject = await action('reject', b2.id);
  const again = await action('approve', b1.id);
  const badId = await action('approve', '../../server.mjs');
  check('admin: godkjenn flytter til godkjent/, avvis til avvist/, dobbel godkjenning → 404, ugyldig id → 400',
    approve.status === 200 && reject.status === 200 && again.status === 404 && badId.status === 400 &&
    (await listResults('godkjent')).includes(b1.id) && (await listResults('avvist')).includes(b2.id) &&
    !(await listResults()).includes(b1.id), `${approve.status}, ${reject.status}, ${again.status}, ${badId.status}`);

  const exp = await admin('api/admin/export');
  const exported = await exp.json();
  check('admin: eksporten inneholder bare godkjente', exp.status === 200 && exported.length === 1 && exported[0].id === b1.id);

  const restore = await action('restore', b2.id);
  const unapprove = await action('unapprove', b1.id);
  check('admin: avvist kan angres, og godkjenning kan trekkes tilbake',
    restore.status === 200 && unapprove.status === 200 && (await listResults()).includes(b1.id) && (await listResults()).includes(b2.id) &&
    (await listResults('godkjent')).length === 0);
  await rm(path.join(PENDING_DIR, b1.id));
  await rm(path.join(PENDING_DIR, b2.id));
}

/** Admin-siden i nettleseren: godkjenn den ekte gjennomgangen som ble sendt inn i hovedflyten. */
async function adminUiTest(browser, appUrl) {
  const pending = await listResults();
  if (pending.length !== 1) return check('admin-UI: én innsending venter fra hovedflyten', false, pending.join(','));
  const context = await browser.newContext({ httpCredentials: { username: 'admin', password: ADMIN_PASSWORD }, viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(new URL('admin', appUrl).href);
  await page.locator('article.card').first().waitFor({ timeout: 5000 });
  check('admin-UI: viser innsendingen med 6 tester og deltakerinfo',
    (await page.locator('article.card').count()) === 1 && (await page.locator('article.card tbody tr').count()) === 6 &&
    (await page.locator('article.card').textContent()).includes(`Alder: ${lastValidSession.participant.age}`));
  await page.screenshot({ path: path.join(SHOT_DIR, 'admin-01-venter.png') });
  await page.getByRole('button', { name: 'Godkjenn' }).click();
  await page.getByText('Ingen her.').waitFor({ timeout: 5000 });
  check('admin-UI: «Godkjenn» flytter filen til godkjent/',
    (await listResults()).length === 0 && (await listResults('godkjent')).includes(pending[0]) && errors.length === 0, errors.join('; '));
  await page.getByRole('tab', { name: /Godkjent/ }).click();
  await page.locator('article.card').first().waitFor({ timeout: 5000 });
  await page.screenshot({ path: path.join(SHOT_DIR, 'admin-02-godkjent.png') });
  await context.close();
}

/* ---------- Statisk server uten API (som `npx serve mouse-test`) ---------- */
async function staticServerTest(browser) {
  const server = createServer(async (req, res) => {
    try {
      if (req.method !== 'GET') { res.writeHead(404); return res.end(); }
      const p = req.url === '/' ? '/index.html' : req.url.split('?')[0];
      const body = await readFile(path.join(APP_DIR, path.normalize(p)));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(`http://127.0.0.1:${port}/`);
  // Lagring mot en server uten /api/save skal gi null (→ appen faller tilbake til nedlasting)
  const fallback = await page.evaluate(() => window.MouseTest.saveToResultsFolder('gjennomgang_2026-11-02_09-05-07.json', { a: 1 }));
  await fillParticipant(page, { age: 40, gender: 'mann', preference: 'mus' });
  await page.getByTestId('start-button').click();
  await page.getByTestId('instruction-start').click();
  await page.locator('[data-testid=target][data-ready="1"]').waitFor({ timeout: 6000 });
  const ok = (await page.getByTestId('test-title').textContent()).trim() === 'Trackpad test';
  check('statisk server (som `npx serve mouse-test`): appen virker, og lagring faller tilbake til nedlasting',
    ok && fallback === null, `fallback=${fallback}`);
  await page.close();
  server.close();
}

/* ---------- Main ---------- */
await rm(SHOT_DIR, { recursive: true, force: true });
await mkdir(SHOT_DIR, { recursive: true });
await rm(TEST_RESULTS_DIR, { recursive: true, force: true });
await mkdir(TEST_RESULTS_DIR, { recursive: true });

const browser = await chromium.launch({ headless: true });
let appServer = null;
try {
  await guarded('enhetstester', () => unitTests(browser));
  appServer = await startAppServer();
  console.log(`\n=== server.mjs (${appServer.url}, RESULTS_DIR=${path.relative(ROOT, TEST_RESULTS_DIR)}) ===`);
  await guarded('server', () => serverTests(appServer.url));
  for (const run of RUNS) {
    const url = run.via === 'server' ? appServer.url : pathToFileURL(APP_FILE).href;
    console.log(`\n=== Gjennomgang «${run.name}» ${run.width}×${run.height} via ${run.via === 'server' ? 'npm start' : 'file://'} ===`);
    await guarded(`gjennomgang ${run.name}`, () => runSession(browser, run, url));
  }
  console.log('\n=== Admin-siden ===');
  await guarded('admin-UI', () => adminUiTest(browser, appServer.url));
  console.log('');
  await guarded('statisk server', () => staticServerTest(browser));
} finally {
  if (appServer) appServer.stop();
  await browser.close();
}

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} sjekker PASS` +
  (failed.length ? `, ${failed.length} FAIL` : ''));
console.log(failed.length === 0 ? 'RESULTAT: PASS' : 'RESULTAT: FAIL');
console.log(`Skjermdumper: ${path.relative(ROOT, SHOT_DIR)}/`);
process.exit(failed.length === 0 ? 0 : 1);
