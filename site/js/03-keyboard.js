ov.addEventListener('click',function(e){ if(e.target===ov) closeSheet(); });
document.addEventListener('keydown',function(e){ if(e.key==='Escape'&&ov.classList.contains('on')) closeSheet(); });
ov.addEventListener('keydown',function(e){
  if(e.key!=='Tab')return;
  const f=sheet.querySelectorAll('a[href],button,video,[tabindex]:not([tabindex="-1"])');
  if(!f.length)return;
  const first=f[0], lastEl=f[f.length-1];
  if(e.shiftKey&&document.activeElement===first){e.preventDefault();lastEl.focus();}
  else if(!e.shiftKey&&document.activeElement===lastEl){e.preventDefault();first.focus();}
});
