import { fontsReady } from './fonts.js';
import './styles.css';
import { Desk } from './desk.js';
import { PaperOverlay } from './paper.js';
import { snapshot, warmSvgs } from './snapshot.js';
import { PAGES, esc, renderEdition, renderIssues } from './render.js';
import { deviceName, passkeysSupported, registerPasskey } from './webauthn.js';

const sites = import.meta.env.MODE === 'sites';
const $ = (sel) => document.querySelector(sel);
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const sheet = $('#sheet');
const folio = $('#folio');
const press = $('#press');
const issues = $('#issues');
const issuesBtn = $('#issues-btn');
const keys = $('#keys');
const keysBtn = $('#keys-btn');
if (sites) keysBtn.hidden = true;

const desk = Desk.create($('#desk'), { reduced });
const overlay = reduced ? null : PaperOverlay.create($('#overlay'));

let edition = null;
let editions = [];
let pages = [];
let current = 0;
let busy = false;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

async function api(path, init) {
  const res = await fetch(path, { credentials: 'same-origin', headers: { Accept: 'application/json' }, ...init });
  if (res.status === 401) {
    location.replace(sites ? `/signin-with-chatgpt?return_to=${encodeURIComponent(location.pathname)}` : `/login?next=${encodeURIComponent(location.pathname)}`);
    throw Object.assign(new Error('auth'), { auth: true });
  }
  if (!res.ok) throw Object.assign(new Error(res.statusText), { status: res.status });
  return res.json();
}

const dateFromPath = () => location.pathname.match(/^\/e\/(\d{4}-\d{2}-\d{2})$/)?.[1] ?? 'latest';

/* ---------- pages ---------- */

function activate(i) {
  pages.forEach((page, idx) => {
    const on = idx === i;
    page.classList.toggle('is-active', on);
    page.inert = !on;
    page.setAttribute('aria-hidden', String(!on));
  });
  current = i;
  sheet.dataset.page = String(i);
  sheet.dataset.last = String(i === pages.length - 1);
  folio.querySelectorAll('[data-goto]').forEach((b) => {
    b.setAttribute('aria-current', Number(b.dataset.goto) === i ? 'page' : 'false');
  });
  folio.querySelector('[data-dir="-1"]').disabled = i === 0;
  folio.querySelector('[data-dir="1"]').disabled = i === pages.length - 1;
  history.replaceState(history.state, '', `${location.pathname}#${PAGES[i].slug}`);
}

async function goTo(i) {
  if (busy || i === current || i < 0 || i >= pages.length) return;
  if (!overlay) {
    sheet.classList.add('is-fading');
    activate(i);
    setTimeout(() => sheet.classList.remove('is-fading'), 400);
    return;
  }
  busy = true;
  const rect = sheet.getBoundingClientRect();
  try {
    if (i > current) {
      await overlay.beginTurn(rect, snapshot(pages[current], sheet), 0);
      activate(i);
      await overlay.animateTo(1);
    } else {
      await overlay.beginTurn(rect, snapshot(pages[i], sheet), 1);
      await overlay.animateTo(0);
      activate(i);
      await frames();
    }
  } finally {
    overlay.end();
    busy = false;
  }
}

async function mount(ed, { intro = true } = {}) {
  edition = ed;
  sheet.classList.add('is-hidden');
  sheet.hidden = false;
  sheet.innerHTML = `${renderEdition(ed)}
    <button class="corner corner--prev" data-dir="-1" aria-label="Turn back a page"><span class="corner__hole"></span><span class="corner__flap"></span></button>
    <button class="corner corner--next" data-dir="1" aria-label="Turn the page"><span class="corner__hole"></span><span class="corner__flap"></span></button>`;
  pages = [...sheet.querySelectorAll('.page')];
  const fromHash = PAGES.findIndex((p) => p.slug === location.hash.slice(1));
  activate(Math.max(0, fromHash));
  warmSvgs(sheet);
  document.title = `The Personal Times — ${ed.front.headline}`;
  press.hidden = true;
  folio.hidden = false;
  $('#issues-list').innerHTML = renderIssues(editions, ed.date);
  await frames();

  if (intro && overlay) {
    try {
      await overlay.intro(sheet.getBoundingClientRect(), snapshot(pages[current], sheet));
    } catch (err) {
      console.warn('intro skipped', err);
    }
  }
  sheet.classList.remove('is-hidden');
  await wait(300);
  overlay?.end();
}

async function loadEdition(date, { push = true } = {}) {
  if (busy) return;
  busy = true;
  try {
    const ed = await api(`/api/editions/${date}`);
    closeIssues();
    if (push) history.pushState({ date: ed.date }, '', `/e/${ed.date}`);
    sheet.classList.add('is-hidden');
    await wait(280);
    await mount(ed);
  } catch (err) {
    if (!err.auth) console.error(err);
  } finally {
    busy = false;
  }
}

/* ---------- chrome ---------- */

function closeIssues() {
  issues.hidden = true;
  issuesBtn.setAttribute('aria-expanded', 'false');
}

issuesBtn.addEventListener('click', () => {
  const open = issues.hidden;
  issues.hidden = !open;
  issuesBtn.setAttribute('aria-expanded', String(open));
  if (open) {
    closeKeys();
    issues.querySelector('button')?.focus();
  }
});

/* ---------- passkeys ---------- */

const keysList = $('#keys-list');
const keysStatus = $('#keys-status');
const keysAdd = $('#keys-add');
const shortDate = (ts) => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
  .format(new Date(ts * 1000));

function closeKeys() {
  keys.hidden = true;
  keysBtn.setAttribute('aria-expanded', 'false');
}

function drawKeys(list) {
  keysBtn.classList.toggle('has-dot', !list.length && passkeysSupported());
  keysList.innerHTML = list.length ? list.map((k) => `
    <li class="key">
      <span class="key__name">${esc(k.name)}</span>
      <span class="key__meta">Added ${esc(shortDate(k.created_at))} · ${k.last_used_at ? `last used ${esc(shortDate(k.last_used_at))}` : 'not used yet'}</span>
      <button class="key__remove" type="button" data-key="${esc(k.id)}">Remove</button>
    </li>`).join('') : '<li class="empty">No passkeys yet — add one to sign in with Face ID or Touch ID.</li>';
}

async function refreshKeys() {
  if (sites) return;
  try {
    drawKeys(await api('/api/passkeys'));
  } catch (err) {
    if (!err.auth) keysStatus.textContent = 'Couldn’t load your passkeys.';
  }
}

keysBtn.addEventListener('click', () => {
  const open = keys.hidden;
  keys.hidden = !open;
  keysBtn.setAttribute('aria-expanded', String(open));
  if (!open) return;
  closeIssues();
  keysAdd.disabled = !passkeysSupported();
  keysStatus.textContent = passkeysSupported() ? '' : 'This browser doesn’t support passkeys.';
  refreshKeys();
});

keysAdd.addEventListener('click', async () => {
  keysAdd.disabled = true;
  keysStatus.textContent = 'Follow the prompt on your device…';
  try {
    const { passkeys } = await registerPasskey(deviceName());
    drawKeys(passkeys);
    keysStatus.textContent = 'Passkey added. Next time, tap “Sign in with passkey”.';
  } catch (err) {
    keysStatus.textContent = err.name === 'NotAllowedError' ? 'Cancelled — no passkey was added.'
      : err.name === 'InvalidStateError' ? 'This device already has a passkey for The Personal Times.'
        : err.message || 'Couldn’t add a passkey.';
  } finally {
    keysAdd.disabled = !passkeysSupported();
  }
});

keysList.addEventListener('click', async (e) => {
  const btn = e.target.closest('.key__remove');
  if (!btn) return;
  if (!btn.dataset.armed) {
    btn.dataset.armed = '1';
    btn.textContent = 'Confirm';
    setTimeout(() => {
      if (btn.isConnected) {
        delete btn.dataset.armed;
        btn.textContent = 'Remove';
      }
    }, 4000);
    return;
  }
  try {
    drawKeys(await api(`/api/passkeys/${encodeURIComponent(btn.dataset.key)}`, { method: 'DELETE' }));
    keysStatus.textContent = 'Passkey removed.';
  } catch (err) {
    if (!err.auth) keysStatus.textContent = 'Couldn’t remove that passkey.';
  }
});

$('#issues-list').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-date]');
  if (btn && btn.dataset.date !== edition?.date) loadEdition(btn.dataset.date);
  else if (btn) closeIssues();
});

$('#logout-btn').addEventListener('click', async () => {
  if (sites) { location.assign('/signout-with-chatgpt?return_to=%2F'); return; }
  await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
  location.replace('/login');
});

document.addEventListener('click', (e) => {
  const target = e.target.closest('[data-goto], [data-dir]');
  if (target && (folio.contains(target) || sheet.contains(target))) {
    if (target.dataset.goto != null) goTo(Number(target.dataset.goto));
    else goTo(current + Number(target.dataset.dir));
  }
  if (!issues.hidden && !issues.contains(e.target) && !issuesBtn.contains(e.target)) closeIssues();
  if (!keys.hidden && !keys.contains(e.target) && !keysBtn.contains(e.target)) closeKeys();
});

addEventListener('keydown', (e) => {
  if (e.target.closest?.('input, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'ArrowRight') goTo(current + 1);
  else if (e.key === 'ArrowLeft') goTo(current - 1);
  else if (e.key === 'Escape') {
    closeIssues();
    closeKeys();
  }
});

addEventListener('hashchange', () => {
  const i = PAGES.findIndex((p) => p.slug === location.hash.slice(1));
  if (i >= 0 && pages.length) goTo(i);
});

addEventListener('popstate', () => {
  const date = dateFromPath();
  if (date !== 'latest' && date !== edition?.date) loadEdition(date, { push: false });
});

/* ---------- drag to turn (touch, pen, or the mouse on a page corner) ---------- */

let drag = null;

sheet.addEventListener('pointerdown', (e) => {
  if (busy || !overlay || e.button !== 0) return;
  if (e.pointerType === 'mouse' && !e.target.closest('.corner')) return;
  if (e.target.closest('.table-wrap')) return; // tables scroll sideways
  drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, t0: performance.now(), active: false, ready: false };
});

addEventListener('pointermove', async (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  const dx = e.clientX - drag.x0;
  const dy = e.clientY - drag.y0;
  if (!drag.active) {
    if (Math.abs(dy) > 14 && Math.abs(dy) > Math.abs(dx)) { drag = null; return; }
    if (Math.abs(dx) < 14 || Math.abs(dx) < Math.abs(dy) * 1.4) return;
    const dir = dx < 0 ? 1 : -1;
    const target = current + dir;
    if (target < 0 || target >= pages.length) { drag = null; return; }
    const d = drag;
    Object.assign(d, { active: true, dir, target, from: current, width: sheet.getBoundingClientRect().width });
    busy = true;
    try { sheet.setPointerCapture(e.pointerId); } catch { /* not all pointers capture */ }
    const rect = sheet.getBoundingClientRect();
    if (dir > 0) {
      await overlay.beginTurn(rect, snapshot(pages[current], sheet), 0);
      activate(target);
    } else {
      await overlay.beginTurn(rect, snapshot(pages[target], sheet), 1);
    }
    d.ready = true;
  }
  if (!drag?.ready) return;
  const k = Math.min(1, Math.abs(dx) / (drag.width * .9));
  overlay.setProgress(drag.dir > 0 ? k : 1 - k);
  drag.dx = dx;
});

async function endDrag(e) {
  if (!drag || e.pointerId !== drag.id) return;
  const d = drag;
  drag = null;
  if (!d.active) return;
  while (!d.ready) await frames();
  const velocity = (d.dx ?? 0) / Math.max(1, performance.now() - d.t0);
  const p = overlay.progress;
  if (d.dir > 0) {
    const commit = p > .33 || velocity < -.6;
    await overlay.animateTo(commit ? 1 : 0, { easing: 'out' });
    if (!commit) { activate(d.from); await frames(); }
  } else {
    const commit = p < .67 || velocity > .6;
    await overlay.animateTo(commit ? 0 : 1, { easing: 'out' });
    if (commit) { activate(d.target); await frames(); }
  }
  overlay.end();
  busy = false;
}
addEventListener('pointerup', endDrag);
addEventListener('pointercancel', endDrag);

/* ---------- boot ---------- */

(async function boot() {
  const lamp = desk?.lampOn();
  try {
    const [ed, list] = await Promise.all([
      api(`/api/editions/${dateFromPath()}`),
      api('/api/editions').catch(() => []),
      fontsReady(),
      lamp,
    ]);
    editions = list;
    refreshKeys();
    await mount(ed);
  } catch (err) {
    if (err.auth) return;
    press.querySelector('.press__line').textContent = err.status === 404
      ? "The presses haven't run yet — the first edition prints at 7 a.m."
      : 'The delivery van broke down on the way. Try again shortly.';
  }
})();
