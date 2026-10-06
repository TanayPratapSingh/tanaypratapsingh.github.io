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

})();
