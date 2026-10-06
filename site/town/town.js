(function(){
  const $ = id => document.getElementById(id);
  const tpl = id => $(id).content;
  const root = document.documentElement;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const key = t => t.split(':')[0].trim();
  const short = k => TOWN.short[k] || k;
  const store = {
    get: k => { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} }
  };
  const idx = {};
  PROJECTS.forEach((p, i) => { idx[key(p.title)] = i; });
  const B = {};
  TOWN.buildings.forEach(b => { B[b.id] = b; });
  const svg = $('map'), hero = svg.closest('.hero');
  const say = msg => { const a = $('announce'); a.textContent = ''; setTimeout(() => { a.textContent = msg; }, 60); };

  // hero and contact links come from the classic sidebar, so the two pages never disagree
  const rail = tpl('t-rail');
  const links = [...rail.querySelectorAll('.rail__btns a:not(.rail__btn--town)')];
  const emails = [...rail.querySelectorAll('.rail__c a')];
  $('role').textContent = rail.querySelector('.rail__role').textContent.replace(/\s+/g, ' ').trim();
  const mailBtn = emails[0].cloneNode(true);
  mailBtn.textContent = 'Email me';
  $('heroLinks').append(mailBtn, ...links.map(a => { const c = a.cloneNode(true); c.removeAttribute('class'); return c; }));

  /* ---------------------------------------------------------------- camera */
  const FULL = { x: 0, y: 0, w: 980, h: 770 }, R = FULL.h / FULL.w, MAXZ = 4;
  let view = { ...FULL }, flight = 0;
  function apply() {
    svg.setAttribute('viewBox', [view.x, view.y, view.w, view.h].map(n => n.toFixed(1)).join(' '));
    hero.classList.toggle('zoomed', view.w < FULL.w - 0.5);
  }
  // zoomed in, the camera may drift half a view past the edge, so any building can sit beside the panel
  function fit(v) {
    const w = Math.max(FULL.w / MAXZ, Math.min(FULL.w, v.w)), h = w * R;
    if (w >= FULL.w - 0.5) return { ...FULL };
    const sx = w / 2, sy = h / 2;
    return { w, h, x: Math.max(-sx, Math.min(FULL.w - w + sx, v.x)), y: Math.max(-sy, Math.min(FULL.h - h + sy, v.y)) };
  }
  function toSvg(cx, cy) { return new DOMPoint(cx, cy).matrixTransform(svg.getScreenCTM().inverse()); }
  function zoomAt(px, py, f) {
    cancelAnimationFrame(flight);
    const w = view.w / f, s = w / view.w;
    view = fit({ w, x: px - (px - view.x) * s, y: py - (py - view.y) * s });
    apply();
    $('hint').classList.add('gone');
  }
  function zoomCenter(f) { zoomAt(view.x + view.w / 2, view.y + view.h / 2, f); }
  function flyTo(t, done) {
    cancelAnimationFrame(flight);
    t = fit(t);
    if (reduce) { view = t; apply(); if (done) done(); return; }
    const s = { ...view }, t0 = performance.now(), D = 560;
    const ease = x => x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
    const step = now => {
      const k = Math.min(1, (now - t0) / D), e = ease(k);
      const w = s.w + (t.w - s.w) * e;
      view = { x: s.x + (t.x - s.x) * e, y: s.y + (t.y - s.y) * e, w, h: w * R };
      apply();
      if (k < 1) flight = requestAnimationFrame(step); else if (done) done();
    };
    flight = requestAnimationFrame(step);
  }
  // frame a building, leaving it visible beside the panel that is about to open
  function frame(id) {
    const bb = svg.querySelector('.b[data-b="' + id + '"]').getBBox();
    const w = Math.max(bb.width * 1.9, (bb.height * 1.9) / R, FULL.w / 3.2);
    const r = svg.getBoundingClientRect();
    const visRight = Math.min(r.right, innerWidth - Math.min(820, innerWidth));
    const fx = visRight - r.left > 260 ? ((r.left + visRight) / 2 - r.left) / r.width : 0.5;
    return { w, x: bb.x + bb.width / 2 - fx * w, y: bb.y + bb.height / 2 - 0.5 * w * R };
  }

  document.querySelectorAll('.zoom [data-z]').forEach(btn => btn.addEventListener('click', () => {
    const z = btn.dataset.z;
    if (z === 'in') zoomCenter(1.5);
    else if (z === 'out') zoomCenter(1 / 1.5);
    else flyTo(FULL);
  }));
  svg.addEventListener('wheel', e => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const p = toSvg(e.clientX, e.clientY);
    zoomAt(p.x, p.y, Math.exp(-e.deltaY * 0.004));
  }, { passive: false });

  // drag to pan once zoomed in, two fingers to pinch; a drag never counts as a click
  const pts = new Map();
  let drag = null, pinch = null, moved = false;
  svg.addEventListener('pointerdown', e => {
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 1) { drag = { x: e.clientX, y: e.clientY, v: { ...view } }; moved = false; }
    if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), v: { ...view }, m: toSvg((a.x + b.x) / 2, (a.y + b.y) / 2) };
      drag = null;
    }
  });
  svg.addEventListener('pointermove', e => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pts.size === 2) {
      const [a, b] = [...pts.values()];
      const w = pinch.v.w / (Math.hypot(a.x - b.x, a.y - b.y) / pinch.d), s = w / pinch.v.w;
      view = fit({ w, x: pinch.m.x - (pinch.m.x - pinch.v.x) * s, y: pinch.m.y - (pinch.m.y - pinch.v.y) * s });
      apply();
      moved = true;
      $('hint').classList.add('gone');
      return;
    }
    if (!drag || !hero.classList.contains('zoomed')) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!moved && Math.hypot(dx, dy) < 6) return;
    if (!moved) { moved = true; svg.setPointerCapture(e.pointerId); hero.classList.add('panning'); $('tip').hidden = true; }
    const s = drag.v.w / svg.getBoundingClientRect().width;
    view = fit({ w: drag.v.w, x: drag.v.x - dx * s, y: drag.v.y - dy * s });
    apply();
  });
  const lift = e => {
    pts.delete(e.pointerId);
    if (pts.size < 2) pinch = null;
    if (!pts.size) { drag = null; hero.classList.remove('panning'); }
  };
  svg.addEventListener('pointerup', lift);
  svg.addEventListener('pointercancel', lift);
  svg.addEventListener('click', e => { if (moved) { e.stopPropagation(); e.preventDefault(); moved = false; } }, true);
  document.addEventListener('keydown', e => {
    if (!e.target.closest || !e.target.closest('.map')) return;
    if (e.key === '+' || e.key === '=') zoomCenter(1.5);
    else if (e.key === '-') zoomCenter(1 / 1.5);
    else if (e.key === '0') flyTo(FULL);
  });

  /* ---------------------------------------------------------------- buildings */
  const hot = (id, on) => svg.querySelectorAll('[data-b="' + id + '"]').forEach(el => el.classList.toggle('is-hot', on));
  svg.querySelectorAll('[data-b]').forEach(el => {
    const id = el.dataset.b;
    el.addEventListener('click', () => enter(id, el));
    el.addEventListener('mouseenter', () => hot(id, true));
    el.addEventListener('mouseleave', () => hot(id, false));
    if (el.classList.contains('b')) {
      el.addEventListener('focus', () => hot(id, true));
      el.addEventListener('blur', () => hot(id, false));
      el.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); enter(id, el); }
      });
    }
  });

  // a preview card follows the mouse over a building
  const tip = $('tip');
  svg.addEventListener('pointermove', e => {
    if (e.pointerType !== 'mouse' || hero.classList.contains('panning')) return;
    const el = e.target.closest('[data-b]');
    if (!el) { tip.hidden = true; return; }
    const b = B[el.dataset.b];
    tip.innerHTML = '<b>' + b.name + '</b>' + (b.projects ? b.projects.map(short).join(', ') : b.about) +
      '<span class="go">' + (b.projects ? 'Click to look inside' : 'Click to go there') + '</span>';
    tip.hidden = false;
    const r = hero.getBoundingClientRect();
    const x = Math.min(e.clientX - r.left + 18, r.width - tip.offsetWidth - 8);
    const y = Math.min(e.clientY - r.top + 18, r.height - tip.offsetHeight - 8);
    tip.style.transform = 'translate(' + x + 'px,' + y + 'px)';
  });
  svg.addEventListener('pointerleave', () => { tip.hidden = true; });

  let back = null;
  function enter(id, from) {
    const b = B[id];
    tip.hidden = true;
    if (b.section) { $(b.section).scrollIntoView({ behavior: reduce ? 'auto' : 'smooth' }); return; }
    if (from && from.closest && from.closest('.map')) {
      back = { ...view };
      flyTo(frame(id), () => open(id, 0, from));
    } else {
      back = null;
      open(id, 0, from);
    }
  }

  // the same buildings as a list, for phones, keyboards and skimmers
  TOWN.buildings.forEach(b => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'dir__item';
    btn.style.setProperty('--c', b.color);
    const what = b.projects ? b.projects.map(short).join(', ') : b.about;
    btn.innerHTML = '<span class="dir__sw" aria-hidden="true"></span><span><span class="dir__name">' + b.name +
      '</span><span class="dir__what">' + what + '</span></span>';
    btn.addEventListener('click', () => enter(b.id, btn));
    $('dir').appendChild(btn);
  });

  /* ---------------------------------------------------------------- inside a building */
  const ov = $('ov'), panel = $('panel');
  let opener = null, cur = null;
  // the hash makes a building linkable; some hosts refuse history edits, which must not break the panel
  const setUrl = u => { try { history.replaceState(null, '', u); } catch (e) {} };

  function open(id, j, from) {
    cur = B[id];
    opener = from || document.activeElement;
    panel.style.setProperty('--c', cur.color);
    $('pName').textContent = cur.name;
    const n = cur.projects.length;
    $('pAbout').textContent = cur.about + '. ' + (n === 1 ? 'One project inside.' : n + ' projects inside.');
    const tabs = $('pTabs');
    tabs.innerHTML = '';
    tabs.hidden = n < 2;
    cur.projects.forEach((k, m) => {
      const t = document.createElement('button');
      t.type = 'button';
      t.className = 'tab';
      t.setAttribute('role', 'tab');
      t.id = 'ptab-' + m;
      t.setAttribute('aria-controls', 'pBody');
      t.textContent = short(k);
      t.addEventListener('click', () => show(m));
      tabs.appendChild(t);
    });
    const body = $('pBody');
    if (n > 1) body.setAttribute('role', 'tabpanel'); else { body.removeAttribute('role'); body.removeAttribute('aria-labelledby'); }
    show(j || 0);
    ov.hidden = false;
    panel.hidden = false;
    document.body.classList.add('locked');
    requestAnimationFrame(() => requestAnimationFrame(() => panel.classList.add('open')));
    panel.focus({ preventScroll: true });
    setUrl('#' + id);
    sync();
  }

  function show(j) {
    const k = cur.projects[j], i = idx[k], p = PROJECTS[i];
    [...$('pTabs').children].forEach((t, m) => { t.setAttribute('aria-selected', String(m === j)); t.tabIndex = m === j ? 0 : -1; });
    if (cur.projects.length > 1) $('pBody').setAttribute('aria-labelledby', 'ptab-' + j);
    const v = VIDEOS[i], r = REPOS[i];
    const chips = p.badge.split('&middot;').map(s => '<span>' + s.trim() + '</span>').join('');
    const acts = (v || r) ? '<div class="acts">' +
      (v ? '<button class="btn" type="button" data-play>Watch the walkthrough</button>' : '') +
      (r ? '<a class="btn btn--2" href="' + r + '" target="_blank" rel="noopener">See the code on GitHub</a>' : '') +
      '</div>' : '';
    const body = $('pBody');
    body.innerHTML =
      '<p class="proj__plain">' + TOWN.plain[k] + '</p>' +
      '<div class="chips">' + chips + '</div>' + acts + '<div class="vid"></div>' +
      '<section class="tech"><p class="tech__label">The technical version</p><h3>' + p.title + '</h3>' +
      '<p class="tech__meta">' + p.meta + '</p><div class="wu">' + p.body + '</div>' +
      '<p class="tags">Built with ' + p.tags.join(', ') + '.</p></section>';
    body.querySelectorAll('.wu table').forEach(t => {
      const w = document.createElement('div');
      w.className = 'tw';
      t.parentNode.insertBefore(w, t);
      w.appendChild(t);
    });
    const play = body.querySelector('[data-play]');
    if (play) play.addEventListener('click', () => {
      const base = v.replace(/\.mp4$/, '');
      body.querySelector('.vid').innerHTML = '<video controls autoplay playsinline preload="metadata" poster="' + base +
        '.jpg"><source src="' + v + '" type="video/mp4"><track kind="captions" src="' + base +
        '.vtt" srclang="en" label="English" default></video>';
      play.remove();
    });
    panel.scrollTop = 0;
  }

  function close() {
    if (panel.hidden) return;
    const vid = panel.querySelector('video');
    if (vid) vid.pause();
    panel.classList.remove('open');
    document.body.classList.remove('locked');
    const done = () => { panel.hidden = true; ov.hidden = true; $('pBody').innerHTML = ''; sync(); };
    if (reduce) done(); else setTimeout(done, 280);
    if (opener && opener.focus) opener.focus({ preventScroll: true });
    setUrl(location.href.split('#')[0]);
    if (back) { flyTo(back); back = null; }
  }
  // arrow keys move between tabs, and between seasons, the way the roles promise
  function arrows(e, items, pick) {
    const i = items.indexOf(document.activeElement);
    if (i < 0) return;
    const n = { ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1, ArrowUp: i - 1, Home: 0, End: items.length - 1 }[e.key];
    if (n === undefined) return;
    e.preventDefault();
    const k = (n + items.length) % items.length;
    pick(k);
    items[k].focus();
  }
  $('pTabs').addEventListener('keydown', e => arrows(e, [...$('pTabs').children], show));
  $('pClose').addEventListener('click', close);
  ov.addEventListener('click', close);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
  document.addEventListener('focusin', e => { if (!panel.hidden && !panel.contains(e.target)) panel.focus(); });

  /* ---------------------------------------------------------------- seasons, night and weather */
  const cv = $('weather'), ctx = cv.getContext('2d');
  let W = 0, H = 0, parts = [], running = false, onScreen = true, held = store.get('town-motion') === 'paused';
  const WEATHER = {
    spring: { n: 46, colors: ['#F4A6C6', '#FFD0E1', '#FFFFFF'], fall: [0.35, 0.8], size: [3, 5.5], sway: 1.4, spin: 0.03 },
    summer: { n: 28, colors: ['rgba(255,255,255,.85)', 'rgba(255,238,170,.9)'], fall: [-0.35, -0.12], size: [1.4, 2.6], sway: 0.6, spin: 0 },
    autumn: { n: 34, colors: ['#E8742E', '#C9432B', '#E3A934', '#F49A4A'], fall: [0.5, 1.1], size: [5, 8], sway: 2.2, spin: 0.05 },
    winter: { n: 120, colors: ['rgba(255,255,255,.92)'], fall: [0.35, 1.0], size: [1.2, 3.2], sway: 0.8, spin: 0 }
  };
  const rnd = (a, b) => a + Math.random() * (b - a);
  function seed(p, cfg, anywhere) {
    p.x = rnd(0, W);
    p.y = anywhere ? rnd(0, H) : (cfg.fall[0] < 0 ? H + 10 : -10);
    p.v = rnd(cfg.fall[0], cfg.fall[1]);
    p.s = rnd(cfg.size[0], cfg.size[1]);
    p.c = cfg.colors[Math.floor(Math.random() * cfg.colors.length)];
    p.ph = rnd(0, 6.28);
    p.r = rnd(0, 6.28);
    return p;
  }
  function resize() {
    const r = hero.getBoundingClientRect(), dpr = Math.min(2, devicePixelRatio || 1);
    W = r.width; H = r.height;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  function weather() {
    const cfg = WEATHER[root.dataset.season];
    parts = Array.from({ length: cfg.n }, () => seed({}, cfg, true));
  }
  function tick(t) {
    if (!running) return;
    const cfg = WEATHER[root.dataset.season], night = root.dataset.time === 'night';
    ctx.clearRect(0, 0, W, H);
    for (const p of parts) {
      p.y += p.v;
      p.x += Math.sin(t / 900 + p.ph) * cfg.sway * 0.35;
      p.r += cfg.spin;
      if (p.y > H + 12 || p.y < -12 || p.x < -20 || p.x > W + 20) seed(p, cfg, false);
      ctx.fillStyle = night && root.dataset.season === 'summer' ? 'rgba(255,224,102,' + (0.45 + 0.5 * Math.abs(Math.sin(t / 400 + p.ph))) + ')' : p.c;
      ctx.beginPath();
      if (cfg.spin) {
        ctx.ellipse(p.x, p.y, p.s, p.s * 0.55, p.r, 0, 6.283);
      } else {
        ctx.arc(p.x, p.y, p.s, 0, 6.283);
      }
      ctx.fill();
    }
    requestAnimationFrame(tick);
  }
  // nothing moves while the town is off screen, the tab is hidden, or a panel covers it
  function sync() {
    const go = !reduce && !held && onScreen && !document.hidden && panel.hidden;
    hero.classList.toggle('paused', !go && !reduce);
    if (go) svg.unpauseAnimations(); else svg.pauseAnimations();
    if (go && !running) { running = true; requestAnimationFrame(tick); }
    if (!go) { running = false; if (reduce) ctx.clearRect(0, 0, W, H); }
  }
  // the controls float at the bottom of the screen while at least a quarter of the town is in view
  new IntersectionObserver(es => {
    onScreen = es[0].isIntersecting;
    hero.classList.toggle('on', es[0].intersectionRatio >= 0.25);
    sync();
  }, { threshold: [0, 0.25, 0.5] }).observe(hero);
  document.addEventListener('visibilitychange', sync);
  new ResizeObserver(() => { resize(); weather(); }).observe(hero);

  const SAY = {
    spring: 'Spring: blossom on the trees and falling petals.',
    summer: 'Summer: green trees and drifting pollen.',
    autumn: 'Autumn: orange and red trees and falling leaves.',
    winter: 'Winter: snow on the roofs and the ground, and falling snow.'
  };
  const seasons = [...document.querySelectorAll('.seg [data-season]')];
  function setSeason(s, speak) {
    root.dataset.season = s;
    seasons.forEach(b => { const on = b.dataset.season === s; b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1; });
    store.set('town-season', s);
    weather();
    if (speak) say(SAY[s]);
  }
  function setNight(on, speak) {
    if (on) root.dataset.time = 'night'; else delete root.dataset.time;
    const b = $('night');
    b.setAttribute('aria-pressed', String(on));
    b.querySelector('span').textContent = on ? 'Day' : 'Night';
    store.set('town-night', on ? '1' : '0');
    if (speak) say(on ? 'Night: the moon is out and the windows are lit.' : 'Day.');
  }
  function setMotion(paused, speak) {
    held = paused;
    const b = $('motion');
    b.setAttribute('aria-pressed', String(paused));
    b.querySelector('span').textContent = paused ? 'Play motion' : 'Pause motion';
    store.set('town-motion', paused ? 'paused' : 'playing');
    sync();
    if (speak) say(paused ? 'Motion paused.' : 'Motion playing.');
  }
  seasons.forEach((b, k) => b.addEventListener('click', () => setSeason(b.dataset.season, true)));
  document.querySelector('.seg').addEventListener('keydown', e => arrows(e, seasons, k => setSeason(seasons[k].dataset.season, true)));
  $('night').addEventListener('click', () => setNight(root.dataset.time !== 'night', true));
  $('motion').addEventListener('click', () => setMotion(!held, true));
  if (reduce) $('motion').hidden = true;
  svg.querySelectorAll('.sun, .night-sky').forEach(el => el.addEventListener('click', () => setNight(root.dataset.time !== 'night', true)));
  setSeason(root.dataset.season || 'summer');
  setNight(root.dataset.time === 'night');
  setMotion(held);

  /* ---------------------------------------------------------------- the road */
  tpl('t-exp').querySelectorAll('article.job').forEach((job, n) => {
    const h = job.querySelector('h3').textContent.trim();
    const stats = [...job.querySelectorAll('.job__s > div')].map(d =>
      '<span>' + d.querySelector('dt').textContent + ': <b>' + d.querySelector('dd').innerHTML + '</b></span>').join('');
    const li = document.createElement('li');
    li.className = 'stop';
    li.innerHTML = '<span class="stop__pin" aria-hidden="true">' + (n + 1) + '</span><div class="stop__card">' +
      '<p class="stop__when">' + job.querySelector('.job__w').textContent + '</p>' +
      '<p class="stop__plain">' + (TOWN.jobs[h] || '') + '</p>' +
      '<h3>' + h + '</h3><p class="stop__org">' + job.querySelector('.job__o').innerHTML + '</p>' +
      '<div class="chips">' + stats + '</div><div class="stop__body">' + job.querySelector('.job__b').innerHTML + '</div></div>';
    $('stops').appendChild(li);
  });
  // a little car drives down the road as you scroll, and lights each stop it reaches
  const road = $('stops'), car = $('car'), pins = [...road.querySelectorAll('.stop__pin')];
  let roadQueued = false;
  function drive() {
    roadQueued = false;
    const r = road.getBoundingClientRect();
    const travel = r.height - car.offsetHeight;
    const y = Math.max(0, Math.min(travel, innerHeight * 0.55 - r.top));
    car.style.transform = 'translateY(' + y.toFixed(1) + 'px)';
    const front = r.top + y + car.offsetHeight;
    pins.forEach(p => { const pr = p.getBoundingClientRect(); p.classList.toggle('reached', pr.top + pr.height / 2 <= front); });
  }
  addEventListener('scroll', () => { if (!roadQueued) { roadQueued = true; requestAnimationFrame(drive); } }, { passive: true });
  addEventListener('resize', drive);
  drive();

  /* ---------------------------------------------------------------- toolshed, university, post office */
  const ICON = {
    'Languages': '<path class="ic-line" d="M8 6 3 12l5 6M16 6l5 6-5 6"/>',
    'LLM and generative AI': '<path class="ic-line" d="M4 5h16v10H10l-6 4Z"/><circle cx="9" cy="10" r="1.3"/><circle cx="12" cy="10" r="1.3"/><circle cx="15" cy="10" r="1.3"/>',
    'MLOps and deployment': '<path class="ic-line" d="M12 3 20 7.5v9L12 21l-8-4.5v-9ZM12 12l8-4.5M12 12 4 7.5M12 12v9"/>',
    'Deep learning': '<path class="ic-line" d="M12 4 21 9l-9 5-9-5ZM3 14l9 5 9-5"/>',
    'ML and data science libraries': '<path class="ic-line" d="M5 20v-8M10 20V6M15 20v-9M20 20V9"/>',
    'Databases and data engineering': '<ellipse class="ic-line" cx="12" cy="6" rx="7" ry="3"/><path class="ic-line" d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3"/>'
  };
  const TAG = ['#FF9A80', '#9AA7F5', '#6FD1C2', '#FFD56A', '#FF9EC4', '#C3B8FF'];
  tpl('t-skills').querySelectorAll('.skills > div').forEach((g, n) => {
    const title = g.querySelector('h3').textContent.trim();
    const items = g.querySelector('p').textContent.split('\u00b7').map(t => t.trim()).filter(Boolean);
    const rack = document.createElement('section');
    rack.className = 'rack';
    rack.style.setProperty('--tag', TAG[n % TAG.length]);
    rack.setAttribute('aria-labelledby', 'rack' + n);
    rack.innerHTML = '<h3 class="rack__sign" id="rack' + n + '"><svg viewBox="0 0 24 24" aria-hidden="true">' + (ICON[title] || '') + '</svg>' +
      title + ' <span class="rack__n">' + items.length + ' tools</span></h3><ul class="rack__tags">' +
      items.map((t, k) => '<li style="--k:' + k + '"><span>' + t + '</span></li>').join('') + '</ul>';
    $('shelves').appendChild(rack);
  });
  tpl('t-edu').querySelectorAll('.ent').forEach(e => {
    const d = document.createElement('article');
    d.className = 'dip';
    d.innerHTML = '<h3>' + e.querySelector('h3').textContent + '</h3>' +
      '<p class="dip__o">' + e.querySelector('.ent__o').textContent + '</p>' +
      '<p class="dip__w">' + e.querySelector('.ent__w').textContent + '</p>' +
      '<p class="dip__t">' + e.querySelector('p').innerHTML + '</p>';
    $('diplomas').appendChild(d);
  });
  $('letter').innerHTML =
    '<p class="letter__big">' + emails.map(a => '<a href="' + a.getAttribute('href') + '">' + a.textContent + '</a>').join('') + '</p>' +
    '<div class="acts">' + links.map(a => '<a class="btn' + (a.textContent === 'Resume' ? '' : ' btn--2') + '" href="' +
      a.getAttribute('href') + '"' + (a.hasAttribute('download') ? ' download="' + a.getAttribute('download') + '"' : ' target="_blank" rel="noopener"') +
      '>' + a.textContent + '</a>').join('') + '</div>' +
    '<p class="letter__loc">' + rail.querySelector('.rail__loc').innerHTML + '</p>';

  // a shared link like town.html#gym opens that building
  const h = location.hash.slice(1);
  if (B[h] && B[h].projects) open(h, 0, null);
})();
