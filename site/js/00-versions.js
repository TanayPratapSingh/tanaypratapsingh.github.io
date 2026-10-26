// Every write up reads three ways: the technical text, a plain language one, and a flowchart.
// Shared by index.html and town.html; each page passes its own write up class and default.
const VERSIONS=[['tech','Technical'],['simple','Simple'],['flow','Flowchart']];
const FC_KIND={start:'Question',data:'Data',step:'Step',check:'Check',result:'Result',limit:'Caveat',end:'Reading'};
let verPick=null; // the reader's last choice, kept while the page is open

function fcNode(n){
  if(n.k==='split') return '<div class="fc__split"><p class="fc__st">'+n.t+'</p><div class="fc__lanes">'+
    n.lanes.map(function(l){return '<ol class="fc fc--lane">'+l.map(function(x){return '<li>'+fcNode(x)+'</li>';}).join('')+'</ol>';}).join('')+
    '</div></div>';
  return '<div class="fc__n fc__n--'+n.k+'"><span class="fc__k">'+FC_KIND[n.k]+'</span><p class="fc__t">'+n.t+'</p>'+
    (n.d?'<p class="fc__d">'+n.d+'</p>':'')+'</div>'+
    (n.k==='check'?'<div class="fc__yn"><p><b>Yes.</b> '+n.yes+'</p><p><b>No.</b> '+n.no+'</p></div>':'');
}
function flowHtml(flow){
  return '<div class="fc__legend" aria-hidden="true">'+Object.keys(FC_KIND).map(function(k){
      return '<span><i class="fc__sw fc__n--'+k+'"></i>'+FC_KIND[k]+'</span>';}).join('')+'</div>'+
    '<ol class="fc">'+flow.map(function(n){return '<li>'+fcNode(n)+'</li>';}).join('')+'</ol>';
}
function versionsHtml(p,cls,first){
  const pick=verPick||first, html={tech:p.body,simple:p.simple,flow:flowHtml(p.flow)};
  return '<div class="ver" role="tablist" aria-label="Read this write up as">'+VERSIONS.map(function(v){
      const on=v[0]===pick;
      return '<button type="button" role="tab" class="ver__t" id="vt-'+v[0]+'" aria-controls="vp-'+v[0]+'" aria-selected="'+on+
        '" tabindex="'+(on?0:-1)+'" data-ver="'+v[0]+'">'+v[1]+'</button>';}).join('')+'</div>'+
    VERSIONS.map(function(v){
      return '<div class="'+cls+' ver__p ver__p--'+v[0]+'" role="tabpanel" id="vp-'+v[0]+'" aria-labelledby="vt-'+v[0]+'"'+
        (v[0]===pick?'':' hidden')+'>'+html[v[0]]+'</div>';}).join('');
}
function pickVersion(tab){
  verPick=tab.dataset.ver;
  tab.parentNode.querySelectorAll('[data-ver]').forEach(function(t){
    const on=t===tab;
    t.setAttribute('aria-selected',String(on)); t.tabIndex=on?0:-1;
    document.getElementById(t.getAttribute('aria-controls')).hidden=!on;
  });
}
document.addEventListener('click',function(e){
  const t=e.target.closest&&e.target.closest('[data-ver]'); if(t)pickVersion(t);
});
// arrow keys move between the three tabs, as the tab role promises
document.addEventListener('keydown',function(e){
  const t=e.target.closest&&e.target.closest('[data-ver]'); if(!t)return;
  const tabs=[].slice.call(t.parentNode.children), i=tabs.indexOf(t);
  const n={ArrowRight:i+1,ArrowLeft:i-1,Home:0,End:tabs.length-1}[e.key];
  if(n===undefined)return;
  e.preventDefault();
  const next=tabs[(n+tabs.length)%tabs.length];
  pickVersion(next); next.focus();
});
