// Live readings for the overview cards: one small number per dashboard, read
// from the same public sources the dashboards use. Each reading stops quietly
// if its source is unreachable; the cards still link to the full dashboards.
import { boot, $, setText } from './ui.js';
import { fmt } from './util.js';

boot();
const say = (id, text, live = true) => {
  const el = $('#' + id); if (!el) return;
  setText(el.querySelector('.now__v'), text);
  el.dataset.state = live ? 'live' : 'off';
};

// Wikipedia: edits per second over the last 5 seconds of arrivals
(function wiki() {
  const times = [];
  let es, first = NaN;
  const open = () => {
    es = new EventSource('https://stream.wikimedia.org/v2/stream/recentchange');
    es.onmessage = () => { const t = performance.now(); if (isNaN(first)) first = t; times.push(t); if (times.length > 2000) times.splice(0, 1000); };
    es.onerror = () => say('now-wiki', 'reconnecting', false);
  };
  open();
  setInterval(() => {
    const now = performance.now(), cut = now - 5000;
    while (times.length && times[0] < cut) times.shift();
    // until 5 s of stream has arrived, divide by the time actually observed
    const span = Math.min(5, (now - first) / 1000);
    if (times.length && span >= 1) say('now-wiki', Math.round(times.length / span) + ' edits a second right now');
  }, 1000);
  // a hidden overview tab has no reason to keep the stream open
  document.addEventListener('visibilitychange', () => { if (document.hidden) { es.close(); times.length = 0; first = NaN; } else open(); });
})();

// Kraken: last traded BTC/USD price from the public ticker channel
(function book() {
  let ws, wait = 1000;
  const open = () => {
    ws = new WebSocket('wss://ws.kraken.com/v2');
    ws.onopen = () => { wait = 1000; ws.send(JSON.stringify({ method: 'subscribe', params: { channel: 'ticker', symbol: ['BTC/USD'] } })); };
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.channel === 'ticker' && m.data && m.data[0]) say('now-book', 'BTC/USD ' + fmt.fixed(m.data[0].last, 1) + ', last trade');
    };
    ws.onclose = () => { if (!document.hidden) { say('now-book', 'reconnecting', false); setTimeout(open, wait = Math.min(wait * 2, 30000)); } };
  };
  open();
  document.addEventListener('visibilitychange', () => { if (document.hidden) ws.close(); else if (ws.readyState > 1) open(); });
})();

// USGS: the newest earthquake in the past hour
async function quakes() {
  try {
    const d = await (await fetch('https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson', { cache: 'no-cache' })).json();
    const f = d.features.slice().sort((a, b) => b.properties.time - a.properties.time)[0];
    if (!f) { say('now-quakes', 'no earthquakes in the past hour'); return; }
    const p = f.properties;
    say('now-quakes', 'M' + fmt.fixed(p.mag, 1) + ', ' + p.place + ', ' + fmt.ago(Date.now() - p.time));
  } catch { say('now-quakes', 'feed unreachable', false); }
}
quakes(); setInterval(() => document.hidden || quakes(), 60e3);

// NOAA: the newest solar wind speed from the active spacecraft (newest rows come first)
async function sun() {
  try {
    const rows = await (await fetch('https://services.swpc.noaa.gov/json/rtsw/rtsw_wind_1m.json', { cache: 'no-cache' })).json();
    const r = rows.find(x => x.active && x.proton_speed != null);
    if (!r) { say('now-sun', 'no recent solar wind sample', false); return; }
    say('now-sun', 'Solar wind ' + Math.round(r.proton_speed) + ' km/s at ' + r.time_tag.slice(11, 16) + ' UTC');
  } catch { say('now-sun', 'feed unreachable', false); }
}
sun(); setInterval(() => document.hidden || sun(), 60e3);
