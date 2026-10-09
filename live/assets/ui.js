// DOM layer shared by the dashboards: theme, palette, feed health, polling,
// cards with a table view twin, and one render scheduler that every chart
// registers with, so ingestion rate and paint rate are decoupled.
import { fmt, EWMA, isNum } from './util.js';

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];

// Safe element builder. Strings become text nodes, never HTML, because almost
// every label on these pages comes from a third party feed.
export function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  if (props) for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return e;
}
export function setText(sel, text, root = document) { const e = typeof sel === 'string' ? $(sel, root) : sel; if (e && e.textContent !== String(text)) e.textContent = text; }

// Only links back to the source's own domains are rendered as anchors.
export function safeHref(u, allow) {
  try { const x = new URL(u); return x.protocol === 'https:' && allow.some(d => x.hostname === d || x.hostname.endsWith('.' + d)) ? x.href : null; }
  catch { return null; }
}

// ---------------------------------------------------------------- theme
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};
export function currentTheme() {
  const s = document.documentElement.dataset.theme;
  if (s) return s;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
export function initTheme() {
  const saved = store.get('live-theme');
  if (saved === 'light' || saved === 'dark') document.documentElement.dataset.theme = saved;
  const btn = $('.top__theme');
  const label = () => { if (btn) btn.textContent = currentTheme() === 'dark' ? 'Light theme' : 'Dark theme'; };
  label();
  btn && btn.addEventListener('click', () => {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next; store.set('live-theme', next);
    label(); paletteCache = null; dispatchEvent(new Event('themechange'));
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { paletteCache = null; label(); dispatchEvent(new Event('themechange')); });
}

// ---------------------------------------------------------------- palette
let paletteCache = null;
function hex2rgb(x) { x = x.trim().replace('#', ''); if (x.length === 3) x = [...x].map(c => c + c).join(''); const n = parseInt(x, 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; }
export function rgba(hex, a) { const [r, g, b] = hex2rgb(hex); return `rgba(${r},${g},${b},${a})`; }
export function palette() {
  if (paletteCache) return paletteCache;
  const cs = getComputedStyle(document.documentElement), v = n => cs.getPropertyValue('--' + n).trim();
  const p = {
    paper: v('paper'), surface: v('surface'), sunk: v('sunk'), ink: v('ink'), ink2: v('ink-2'), ink3: v('ink-3'), muted: v('muted'),
    rule: v('rule'), grid: v('grid'), axis: v('axis'), other: v('other'),
    good: v('good'), warning: v('warning'), serious: v('serious'), critical: v('critical'),
    s: [1, 2, 3, 4, 5, 6, 7, 8].map(i => v('s' + i)),
    seq: [0, 1, 2, 3, 4, 5].map(i => hex2rgb(v('seq-' + i))),
    mono: v('mono'), sans: v('sans'),
  };
  // sequential lookup: t in [0,1] mapped piecewise across the six ramp stops
  p.seqRGB = t => {
    t = Math.min(1, Math.max(0, t)) * (p.seq.length - 1);
    const i = Math.min(p.seq.length - 2, Math.floor(t)), f = t - i, a = p.seq[i], b = p.seq[i + 1];
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
  };
  p.seqAt = t => { const c = p.seqRGB(t); return `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`; };
  p.color = c => typeof c === 'number' ? p.s[c - 1] : (p[c] || c);
  return (paletteCache = p);
}

// ---------------------------------------------------------------- scheduler
// Charts register a paint function and a minimum interval. Painting stops while
// the page is hidden or paused; ingestion never does.
const jobs = new Set();
let paused = false, rafId = 0;
export function isPaused() { return paused; }
export function onPaint(fn, everyMs = 250) {
  const job = { fn, every: everyMs, last: 0, dirty: true };
  jobs.add(job);
  if (!rafId) rafId = requestAnimationFrame(loop);
  return { invalidate() { job.dirty = true; }, now() { job.dirty = true; job.last = 0; }, stop() { jobs.delete(job); } };
}
function loop(t) {
  rafId = requestAnimationFrame(loop);
  if (paused) return;
  for (const j of jobs) if (j.dirty && t - j.last >= j.every) {
    j.last = t; j.dirty = false;
    try { j.fn(t); } catch (e) { console.error(e); }
  }
}
export function initPause(btn, feeds = []) {
  if (!btn) return;
  btn.addEventListener('click', () => {
    paused = !paused;
    btn.setAttribute('aria-pressed', String(paused));
    btn.textContent = paused ? 'Resume display' : 'Pause display';
    feeds.forEach(f => f.setPaused(paused));
    if (!paused) for (const j of jobs) j.dirty = true;
  });
}
addEventListener('themechange', () => { for (const j of jobs) { j.dirty = true; j.last = 0; } });

// ---------------------------------------------------------------- feed health
// One Feed per upstream source. It owns the connection state the header shows,
// a smoothed message rate, and the time since the last message. A live feed
// that goes quiet for `staleMs` turns stale on its own.
export class Feed {
  constructor({ label, kind = 'stream', staleMs = 15000 }) {
    this.label = label; this.kind = kind; this.staleMs = staleMs;
    this.state = 'connecting'; this.msgs = 0; this.bytes = 0; this.lastAt = NaN; this.err = '';
    this.reconnects = 0; this.rate = new EWMA(10); this.paused = false; this.nextAt = NaN;
    this.el = null;
  }
  set(state, err = '') { this.state = state; this.err = err; this.paint(); }
  hit(bytes = 0, n = 1) {
    const now = performance.now();
    // Messages delivered in one clump arrive under a millisecond apart. Pool them
    // until 50 ms have passed so the rate is count / elapsed; a per message n / dt
    // with dt clamped at 1 ms reads clumped traffic far too low.
    if (isNum(this.lastAt)) {
      this.pend = (this.pend || 0) + n;
      const dt = (now - this.rateAt) / 1000;
      if (dt >= 0.05) { this.rate.update(this.pend / dt, now / 1000); this.rateAt = now; this.pend = 0; }
    } else { this.rateAt = now; this.pend = 0; }
    this.lastAt = now; this.msgs += n; this.bytes += bytes;
    if (this.state !== 'live') this.set('live');
  }
  setPaused(p) { this.paused = p; this.paint(); }
  view() {
    const now = performance.now(), age = isNum(this.lastAt) ? now - this.lastAt : NaN;
    let st = this.state;
    if (st === 'live' && age > this.staleMs) st = 'stale';
    if (this.paused && (st === 'live' || st === 'stale')) st = 'paused';
    const words = { live: 'Live', stale: 'Stale', connecting: 'Connecting', error: 'Error', paused: 'Display paused' };
    let detail;
    if (st === 'error') detail = this.err || 'retrying';
    else if (st === 'connecting') detail = this.reconnects ? 'reconnect ' + this.reconnects : 'opening';
    else if (this.kind === 'poll') detail = 'polled ' + fmt.ago(age) + (isNum(this.nextAt) ? ' · next ' + fmt.dur(Math.max(0, this.nextAt - now)) : '');
    else {
      // between messages the smoothed rate decays toward the observed silence
      const r = isNum(age) && age > 1000 ? Math.min(this.rate.mean, 1000 / age) : this.rate.mean;
      detail = (isNum(r) ? (r < 10 ? r.toFixed(1) : Math.round(r)) : '–') + ' msg/s · last ' + fmt.ago(age);
    }
    return { st, word: words[st], detail };
  }
  mount(parent) {
    this.el = h('div', { class: 'feed', role: 'status', 'aria-live': 'off' },
      h('span', { class: 'feed__dot', 'aria-hidden': 'true' }), h('span', { class: 'feed__state' }), h('span', { class: 'feed__lab' }), h('span', { class: 'feed__det' }));
    parent.append(this.el); this.paint(); return this;
  }
  paint() {
    if (!this.el) return;
    const v = this.view();
    this.el.dataset.state = v.st;
    setText(this.el.children[1], v.word);
    setText(this.el.children[2], this.label);
    setText(this.el.children[3], v.detail);
  }
}
export function mountFeeds(parent, feeds) { feeds.forEach(f => f.mount(parent)); setInterval(() => feeds.forEach(f => f.paint()), 500); }

// ---------------------------------------------------------------- polling
// Poll a JSON endpoint on a fixed cadence. The first poll always runs, so a page
// opened in a background tab has data waiting when it is shown; after that, polls
// are skipped while the tab is hidden and fire immediately when it returns.
// Failures back off exponentially.
export function poll(url, { every, feed, onData, timeoutMs = 20000, parse = 'json' }) {
  let timer = 0, fails = 0, inflight = false, lastMod = '', started = false;
  async function tick() {
    clearTimeout(timer);
    if (document.hidden && started) { feed && (feed.nextAt = NaN); return; }
    if (inflight) return;
    inflight = true; started = true;
    const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), timeoutMs);
    const t0 = performance.now();
    try {
      const r = await fetch(url, { cache: 'no-cache', signal: ctl.signal });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const text = await r.text();
      const meta = { lastModified: r.headers.get('last-modified') || '', ms: performance.now() - t0, bytes: text.length, changed: true };
      meta.changed = !lastMod || meta.lastModified !== lastMod; lastMod = meta.lastModified;
      const data = parse === 'json' ? JSON.parse(text) : text;
      fails = 0; feed && feed.hit(text.length);
      onData(data, meta);
    } catch (e) {
      fails++;
      feed && feed.set('error', (e.name === 'AbortError' ? 'timeout' : e.message) + ' · retry ' + fails);
    } finally {
      clearTimeout(to); inflight = false;
      const wait = fails ? Math.min(every * 2 ** Math.min(fails - 1, 4), 10 * 60e3) : every;
      if (feed) feed.nextAt = performance.now() + wait;
      timer = setTimeout(tick, wait);
    }
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
  tick();
  return { now: tick };
}

// ---------------------------------------------------------------- cards
// Wire a card's Table button to a function returning { cols, rows }. The table
// is the accessible twin of the chart and is refreshed while it is visible.
export function tableView(card, build) {
  const btn = card.querySelector('[data-act="table"]');
  let tv = card.querySelector('.tv');
  if (!tv) { tv = h('div', { class: 'tv', tabindex: '0' }); card.querySelector('.card__b').append(tv); }
  const render = () => {
    if (card.dataset.view !== 'table') return;
    const { cols, rows } = build();
    const t = h('table', null,
      h('thead', null, h('tr', null, cols.map(c => h('th', { class: c.left ? 'l' : null, scope: 'col' }, c.label)))),
      h('tbody', null, rows.map(r => h('tr', null, cols.map(c => h('td', { class: c.left ? 'l' : null }, c.fmt ? c.fmt(r[c.key], r) : r[c.key]))))));
    tv.replaceChildren(t);
  };
  btn && btn.addEventListener('click', () => {
    const on = card.dataset.view !== 'table';
    card.dataset.view = on ? 'table' : 'chart';
    btn.setAttribute('aria-pressed', String(on));
    btn.textContent = on ? 'Chart' : 'Table';
    render();
  });
  setInterval(render, 1500);
  return render;
}

export function legend(el, items) {
  const p = palette();
  el.replaceChildren(...items.map(it => h('span', null,
    h('i', { class: it.shape || '', style: { background: p.color(it.color) } }), it.label)));
}
addEventListener('themechange', () => document.querySelectorAll('[data-legend]').forEach(el => el._legend && legend(el, el._legend)));
export function mountLegend(el, items) { el.dataset.legend = ''; el._legend = items; legend(el, items); }

export function boot() { initTheme(); }
