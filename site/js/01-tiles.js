const grid=document.getElementById('grid');
PROJECTS.forEach(function(p,i){
  const b=document.createElement('button');
  b.className='tile'; b.type='button'; b.setAttribute('aria-haspopup','dialog');
  b.innerHTML='<div class="tile__meta">'+p.meta+'</div>'+
    '<h3>'+p.title+'</h3>'+
    '<div class="tile__badge">'+p.badge+'</div>'+
    '<div class="tile__tags">'+p.tags.join(' &middot; ')+'</div>'+
    '<div class="tile__foot"><span>Open write up</span>'+
      (VIDEOS[i]?'<span class="rec">walkthrough recorded</span>':'')+
      (REPOS[i]?'<span class="rec">code public</span>':'')+'</div>';
  b.addEventListener('click',function(){openSheet(i);});
  grid.appendChild(b);
});
