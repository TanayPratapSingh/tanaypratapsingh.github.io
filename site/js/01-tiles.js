const grid=document.getElementById('grid');
// Tiles show the first few tags; the write up sheet lists all of them.
const TILE_TAGS=3;
PROJECTS.forEach(function(p,i){
  const b=document.createElement('button');
  const extra=p.tags.length-TILE_TAGS;
  b.className='tile'; b.type='button'; b.setAttribute('aria-haspopup','dialog');
  b.innerHTML='<div class="tile__meta">'+p.meta+'</div>'+
    '<h3>'+p.title+'</h3>'+
    '<div class="tile__badge">'+p.badge+'</div>'+
    '<div class="tile__tags">'+p.tags.slice(0,TILE_TAGS).join(' &middot; ')+
      (extra>0?' <span class="more">+'+extra+'</span>':'')+'</div>'+
    '<div class="tile__foot"><span>Open write up</span>'+
      (VIDEOS[i]?'<span class="rec">video</span>':'')+
      (REPOS[i]?'<span class="rec">code</span>':'')+'</div>';
  b.addEventListener('click',function(){openSheet(i);});
  grid.appendChild(b);
});
