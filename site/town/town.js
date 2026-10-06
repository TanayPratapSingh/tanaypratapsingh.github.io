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

  // hero and contact links come from the classic sidebar, so the two pages never disagree
  const rail = tpl('t-rail');
  const links = [...rail.querySelectorAll('.rail__btns a')];
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
      t.textContent = short(k);
      t.addEventListener('click', () => show(m));
      tabs.appendChild(t);
    });
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
    [...$('pTabs').children].forEach((t, m) => t.setAttribute('aria-selected', String(m === j)));
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
  $('pClose').addEventListener('click', close);
  ov.addEventListener('click', close);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
  document.addEventListener('focusin', e => { if (!panel.hidden && !panel.contains(e.target)) panel.focus(); });

})();
