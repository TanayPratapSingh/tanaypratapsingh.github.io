// back to top: shown once the page has scrolled a screen down, and it brings keyboard focus back up too
const totop=document.getElementById('totop');
let totopQueued=false;
addEventListener('scroll',function(){
  if(totopQueued)return; totopQueued=true;
  requestAnimationFrame(function(){ totopQueued=false; totop.classList.toggle('show',scrollY>innerHeight*0.8); });
},{passive:true});
totop.addEventListener('click',function(){
  const still=matchMedia('(prefers-reduced-motion: reduce)').matches;
  scrollTo({top:0,behavior:still?'auto':'smooth'});
  document.querySelector('.rail__name').focus({preventScroll:true});
});
