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

})();
