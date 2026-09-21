const ov=document.getElementById('ov'), sheet=document.getElementById('sheet');
let last=null;
function openSheet(i){
  const p=PROJECTS[i];
  sheet.innerHTML=
    '<button class="sheet__x" type="button" onclick="closeSheet()">Close</button>'+
    '<div class="sheet__meta">'+p.meta+'</div>'+
    '<h3 id="sheetTitle">'+p.title+'</h3>'+
    '<div class="sheet__badge">'+p.badge+'</div>'+
    '<div class="sheet__tags">'+p.tags.join(' &middot; ')+'</div>'+
    (REPOS[i]?'<a class="sheet__code" href="'+REPOS[i]+'" target="_blank" rel="noopener">View code on GitHub</a>':'')+
    (VIDEOS[i]?'<video src="'+VIDEOS[i]+'" poster="'+VIDEOS[i].replace(/\.mp4$/,'.jpg')+'" controls preload="none" playsinline></video>':'')+
    '<div class="body">'+p.body+'</div>';
  last=document.activeElement;
  ov.classList.add('on'); document.body.classList.add('locked');
  sheet.scrollTop=0; sheet.focus();
}
function closeSheet(){
  const v=sheet.querySelector('video'); if(v){v.pause();}
  ov.classList.remove('on'); document.body.classList.remove('locked');
  if(last&&last.focus)last.focus();
}
