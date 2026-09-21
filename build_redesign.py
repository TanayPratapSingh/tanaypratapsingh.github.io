"""Generate redesign.html from index.html.

Keeps the original architecture (tile grid, click opens a detail overlay) and
the original project write-ups verbatim. Only the shell, the styling, and the
render functions are new.
"""
import io, re, json

src = io.open("index.html", encoding="utf-8").read()
def grab(name):
    return re.search(r'const %s=(\[.*?\]);' % name, src, re.S).group(1)
PROJECTS, REPOS, VIDEOS = grab("PROJECTS"), grab("REPOS"), grab("VIDEOS")

HEAD = r"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>Tanay Pratap Singh</title>
<meta name="description" content="Applied data scientist. Retrieval, evaluation harnesses, guardrails, and the warehouse layer underneath them.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Newsreader:ital,opsz,wght@0,6..72,300;0,6..72,400;0,6..72,500;0,6..72,600;1,6..72,400&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
:root{
  --paper:#F7F6F2; --surface:#FCFBF9; --sunk:#F1EFE9;
  --ink:#15171B; --ink-2:#565B62; --ink-3:#878D95;
  --rule:#DEDBD4; --rule-2:#C7C3BA; --met:#1B4D8F; --missed:#B3261E;
  --serif:'Newsreader',Georgia,serif; --mono:'IBM Plex Mono',ui-monospace,Menlo,monospace;
  --gut:clamp(16px,3.4vw,46px);
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--paper);color:var(--ink);
  font-family:var(--serif);font-size:16.5px;line-height:1.5;
  font-variant-numeric:tabular-nums;-webkit-font-smoothing:antialiased}
body.locked{overflow:hidden}
h1,h2,h3,h4{font-weight:400;margin:0;line-height:1.15;letter-spacing:-0.013em}
p{margin:0}
a{color:inherit}
:focus-visible{outline:2px solid var(--met);outline-offset:3px}
.wrap{max-width:1320px;margin:0 auto;padding:0 var(--gut)}

.top{position:sticky;top:0;z-index:20;background:rgba(247,246,242,.95);
  backdrop-filter:blur(6px);border-bottom:1px solid var(--rule-2)}
.top__in{display:flex;align-items:baseline;justify-content:space-between;gap:18px;padding:12px 0}
.wordmark{font-size:17.5px;font-weight:500;text-decoration:none}
.nav{display:flex;gap:20px;font-size:14px}
.nav a{color:var(--ink-2);text-decoration:none}
.nav a:hover{color:var(--ink)}

/* spec sheet header: facts, no pitch */
.spec{padding:clamp(26px,3.4vw,42px) 0 clamp(20px,2.6vw,30px)}
.spec h1{font-size:clamp(21px,2.4vw,27px);font-weight:400;max-width:70ch;letter-spacing:-0.016em}
.spec h1 b{font-weight:500}
.specgrid{margin-top:20px;display:grid;grid-template-columns:repeat(auto-fit,minmax(178px,1fr));
  gap:1px;background:var(--rule);border:1px solid var(--rule)}
.specgrid div{background:var(--surface);padding:10px 13px}
.specgrid dt{font-size:12.2px;color:var(--ink-3)}
.specgrid dd{margin:3px 0 0;font-family:var(--mono);font-size:14.5px;color:var(--met);line-height:1.4}
.stackline{margin-top:14px;font-family:var(--mono);font-size:12.4px;color:var(--ink-3);line-height:1.8}

.sec{padding:clamp(26px,3.2vw,40px) 0;border-top:1px solid var(--rule-2)}
.sec__h{display:flex;align-items:baseline;gap:13px;margin-bottom:18px}
.sec__h h2{font-size:20px}
.sec__h span{font-family:var(--mono);font-size:12.2px;color:var(--ink-3)}

/* tile grid */
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(316px,1fr));
  gap:1px;background:var(--rule);border:1px solid var(--rule)}
.tile{background:var(--surface);padding:15px 16px 14px;display:flex;flex-direction:column;
  text-align:left;border:0;font:inherit;color:inherit;cursor:pointer;width:100%}
.tile:hover{background:var(--sunk)}
.tile__meta{font-family:var(--mono);font-size:11.6px;color:var(--ink-3);line-height:1.55}
.tile h3{font-size:18px;margin:8px 0 9px;letter-spacing:-0.012em}
.tile__badge{font-family:var(--mono);font-size:12.3px;color:var(--ink);background:var(--sunk);
  border-left:2px solid var(--met);padding:7px 9px;line-height:1.65}
.tile__tags{margin-top:10px;font-family:var(--mono);font-size:11.4px;color:var(--ink-3);
  line-height:1.7;flex:1}
.tile__foot{margin-top:11px;display:flex;align-items:baseline;gap:10px;
  font-family:var(--mono);font-size:11.6px;color:var(--met)}
.tile__foot .rec{color:var(--ink-3)}

/* overlay */
.ov{position:fixed;inset:0;z-index:40;display:none;background:rgba(21,23,27,.45)}
.ov.on{display:block}
.sheet{position:absolute;inset:0;margin:auto;max-width:1000px;width:calc(100% - 2*var(--gut));
  max-height:92vh;overflow:auto;background:var(--paper);border:1px solid var(--rule-2);
  padding:clamp(20px,3vw,38px)}
.sheet__x{float:right;margin-left:16px;background:var(--surface);border:1px solid var(--rule-2);
  color:var(--ink);font:inherit;font-size:13.5px;padding:5px 12px;cursor:pointer}
.sheet__x:hover{border-color:var(--met);color:var(--met)}
.sheet__meta{font-family:var(--mono);font-size:12.2px;color:var(--ink-3)}
.sheet h3{font-size:clamp(23px,2.7vw,31px);margin:7px 0 12px;max-width:34ch}
.sheet__badge{font-family:var(--mono);font-size:13px;background:var(--sunk);
  border-left:2px solid var(--met);padding:9px 11px;line-height:1.7;margin-bottom:12px}
.sheet__tags{font-family:var(--mono);font-size:11.8px;color:var(--ink-3);line-height:1.8;margin-bottom:16px}
.sheet__code{display:inline-block;font-family:var(--mono);font-size:13px;color:var(--met);
  text-decoration:none;border:1px solid var(--met);padding:6px 13px;margin-bottom:18px}
.sheet__code:hover{background:var(--met);color:var(--paper)}
.sheet video{width:100%;display:block;background:#000;border:1px solid var(--rule-2);margin-bottom:20px}

/* write-up typography */
.body h4{font-size:17px;margin:22px 0 7px;color:var(--ink);letter-spacing:-0.01em}
.body p{margin:0 0 11px;max-width:80ch;color:var(--ink-2)}
.body strong{color:var(--ink);font-weight:600}
.body code{font-family:var(--mono);font-size:.88em;background:var(--sunk);padding:1px 4px}
.body ul,.body ol{margin:0 0 12px;padding-left:20px;max-width:80ch;color:var(--ink-2)}
.body li{margin-bottom:5px}
.body pre{font-family:var(--mono);font-size:12.4px;background:var(--sunk);border:1px solid var(--rule);
  padding:12px;overflow-x:auto;line-height:1.6;margin:0 0 14px}
.body table{width:100%;border-collapse:collapse;font-size:14px;margin:0 0 16px}
.body th{text-align:left;font-weight:500;font-size:12.6px;color:var(--ink-3);
  padding:0 12px 7px 0;border-bottom:1px solid var(--ink)}
.body td{padding:8px 12px 8px 0;border-bottom:1px solid var(--rule);color:var(--ink-2);vertical-align:top}
.body .metric{font-family:var(--mono);font-size:13px;background:var(--sunk);
  border-left:2px solid var(--met);padding:9px 11px;line-height:1.7;margin:0 0 14px;color:var(--ink)}
.body .callout{border-left:2px solid var(--rule-2);padding:2px 0 2px 14px;margin:0 0 14px;
  font-style:italic;color:var(--ink-2)}
.body .winner{border-left-color:var(--met)}
.body figure{margin:0 0 16px}
.body .project-figure img{width:100%;display:block;border:1px solid var(--rule)}
.body figcaption{font-size:12.8px;color:var(--ink-3);margin-top:6px}
.body .figure-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px}

/* experience */
.job{padding:16px 0;border-top:1px solid var(--rule)}
.sec .job:first-of-type{border-top:0;padding-top:0}
.job__t{display:flex;flex-wrap:wrap;align-items:baseline;gap:5px 13px}
.job h3{font-size:19px}
.job__o{color:var(--ink-2);font-size:14.2px}
.job__w{margin-left:auto;font-family:var(--mono);font-size:12.2px;color:var(--ink-3)}
.job__s{margin:10px 0 0;display:grid;grid-template-columns:repeat(auto-fit,minmax(146px,1fr));
  gap:1px;background:var(--rule);border:1px solid var(--rule)}
.job__s div{background:var(--surface);padding:8px 11px}
.job__s dt{font-size:12px;color:var(--ink-3)}
.job__s dd{margin:2px 0 0;font-family:var(--mono);font-size:15px;color:var(--met)}
.job p{margin-top:9px;font-size:15px;color:var(--ink-2);max-width:92ch}

.skills{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:15px 24px}
.skills h3{font-size:13.6px;margin-bottom:4px}
.skills p{font-family:var(--mono);font-size:12.1px;color:var(--ink-2);line-height:1.75}

.twoup{display:grid;grid-template-columns:repeat(auto-fit,minmax(330px,1fr));gap:24px}
.ent{border-top:1px solid var(--rule);padding-top:11px}
.ent h3{font-size:17px}
.ent__o{color:var(--ink-2);font-size:14px;margin-top:2px}
.ent__w{font-family:var(--mono);font-size:12.1px;color:var(--ink-3);margin-top:3px}
.ent p{margin-top:7px;font-size:14.6px;color:var(--ink-2)}

.foot{padding:clamp(26px,3vw,40px) 0 64px;border-top:1px solid var(--rule-2);
  display:flex;flex-wrap:wrap;gap:12px 30px;align-items:baseline;font-size:15.5px}
.foot a{color:var(--met);text-decoration:none;border-bottom:1px solid currentColor}
.foot span{color:var(--ink-3);font-family:var(--mono);font-size:12.4px}

@media (max-width:900px){ .job__w{margin-left:0;width:100%} }
@media (max-width:620px){
  .top__in{flex-direction:column;align-items:flex-start;gap:8px}
  .nav{flex-wrap:wrap;gap:13px;font-size:13.2px}
  .grid{grid-template-columns:1fr}
  .sec__h{flex-direction:column;align-items:flex-start;gap:3px}
  .sheet{width:100%;max-height:100vh;border:0}
}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
</style>
</head>
<body>

<header class="top"><div class="wrap top__in">
  <a class="wordmark" href="#">Tanay Pratap Singh</a>
  <nav class="nav">
    <a href="#projects">Projects</a><a href="#exp">Experience</a>
    <a href="#skills">Skills</a><a href="#edu">Education</a><a href="#contact">Contact</a>
  </nav>
</div></header>

<main class="wrap">

  <section class="spec">
    <h1>Applied data scientist working on <b>retrieval and evaluation systems</b>: RAG pipelines,
      guardrails, calibration, streaming ingestion, and the dbt warehouse layer underneath them.
      Every project below publishes the measurements it was graded on, including the ones it failed.</h1>
    <dl class="specgrid">
      <div><dt>Degree</dt><dd>MS Applied Data Science</dd></div>
      <div><dt>Institution</dt><dd>Syracuse University</dd></div>
      <div><dt>Projects documented</dt><dd>15</dd></div>
      <div><dt>Walkthroughs recorded</dt><dd>5</dd></div>
      <div><dt>LIGO classifications parsed</dt><dd>276,000+</dd></div>
      <div><dt>Open to</dt><dd>ML / data / analytics eng</dd></div>
    </dl>
    <p class="stackline">Python · SQL · R · C++ &nbsp;|&nbsp; RAG · LangChain · ChromaDB · BM25 · agent orchestration · guardrails · calibration (ECE)
      &nbsp;|&nbsp; TensorFlow · Keras · scikit-learn · XGBoost · CatBoost · SHAP
      &nbsp;|&nbsp; Kafka · Avro · dbt · DuckDB · BigQuery · Spark · Airflow · MLflow · Docker · Kubernetes</p>
  </section>

  <section class="sec" id="projects">
    <div class="sec__h"><h2>Projects</h2><span>15 documented &middot; select a tile for the full write up</span></div>
    <div class="grid" id="grid"></div>
  </section>
"""

TAIL = r"""
  <section class="sec" id="exp">
    <div class="sec__h"><h2>Experience</h2><span>4 roles</span></div>
    <article class="job">
      <div class="job__t"><h3>Research Assistant, Gravity Spy 2.0</h3>
        <span class="job__o">Syracuse University &middot; NSF funded</span>
        <span class="job__w">Feb 2026 to present</span></div>
      <dl class="job__s">
        <div><dt>Classifications parsed</dt><dd>276,000+</dd></div>
        <div><dt>Glitch subjects</dt><dd>25,104</dd></div>
        <div><dt>Auxiliary channels</dt><dd>8,293</dd></div>
        <div><dt>Validation AUC</dt><dd>0.89</dd></div>
        <div><dt>Calibration error</dt><dd>0.10 to 0.05</dd></div>
      </dl>
      <p>Causal inference on LIGO detector noise: identifying which auxiliary subsystems produce the
        transient glitches that contaminate gravitational wave strain data, so commissioners fix the
        responsible hardware rather than chasing symptoms. Built the ingestion pipeline in Python
        against the Zooniverse Panoptes API, reconciling five undocumented subject metadata schemas
        across 23 months of observations.</p>
    </article>
    <article class="job">
      <div class="job__t"><h3>Process Improvement Analyst</h3>
        <span class="job__o">JMA Wireless &middot; Liverpool, NY</span>
        <span class="job__w">Jan 2026 to May 2026</span></div>
      <dl class="job__s">
        <div><dt>Annualized impact</dt><dd>~$355K</dd></div>
        <div><dt>Data pipeline</dt><dd>31 GB to 5 MB</dd></div>
        <div><dt>KPIs standardized</dt><dd>4</dd></div>
      </dl>
      <p>Full DMAIC engagement at a US 5G infrastructure manufacturer, sponsored by the SVP of Global
        Operations. Delivered a standardized KPI framework, a Python ETL pipeline, and a Power BI
        dashboard.</p>
    </article>
    <article class="job">
      <div class="job__t"><h3>Cybersecurity Teaching Assistant</h3>
        <span class="job__o">Syracuse University Labs</span>
        <span class="job__w">Summer 2025</span></div>
      <dl class="job__s"><div><dt>Hands on labs delivered</dt><dd>15+</dd></div></dl>
      <p>Lab sessions across Wireshark, Kali, Nmap, OpenSSL, and Metasploit, maintaining the virtual
        machine stack students worked in.</p>
    </article>
    <article class="job">
      <div class="job__t"><h3>Data and Product Analyst Intern</h3>
        <span class="job__o">ProProfs &middot; Noida, India</span>
        <span class="job__w">Jul 2023 to Aug 2023</span></div>
      <dl class="job__s">
        <div><dt>SaaS users analyzed</dt><dd>5,000+</dd></div>
        <div><dt>Customer records</dt><dd>2,000</dd></div>
        <div><dt>Churn reduction</dt><dd>5%</dd></div>
        <div><dt>Rating lift</dt><dd>4.2 to 4.5</dd></div>
      </dl>
      <p>Product analytics across a SaaS user base, focused on churn drivers and the review pipeline
        feeding the public product rating.</p>
    </article>
  </section>

  <section class="sec" id="skills">
    <div class="sec__h"><h2>Technical skills</h2><span>grouped by where they get used</span></div>
    <div class="skills">
      <div><h3>Languages</h3><p>Python · SQL · R · C++ · Java · JavaScript · HTML5 · CSS3 · LaTeX</p></div>
      <div><h3>LLM and generative AI</h3><p>RAG · LangChain · OpenAI API · ChromaDB · vector databases · BM25 · agent orchestration · tool calling · state graphs · LLM gateway · guardrails · prompt injection defense · jailbreak detection · LLM evaluation · calibration (ECE) · human in the loop · PII redaction · responsible AI · VADER · TF-IDF</p></div>
      <div><h3>MLOps and deployment</h3><p>MLflow · Apache Airflow · Docker · Docker Compose · Kubernetes · GitHub Actions · CI/CD · model registry · REST APIs</p></div>
      <div><h3>Deep learning</h3><p>LSTM · RNN · CNN · multimodal CNN · NLP · computer vision · transfer learning · MobileNetV2 · backpropagation · feature engineering · data imputation · SHAP interpretability</p></div>
      <div><h3>ML and data science libraries</h3><p>pandas · NumPy · scikit-learn · TensorFlow · Keras · XGBoost · CatBoost · SHAP · SciPy · OpenCV · Astropy · openpyxl · Matplotlib · Seaborn · Plotly · Spark</p></div>
      <div><h3>Databases and data engineering</h3><p>MySQL · BigQuery · DuckDB · Apache Kafka · Avro · dbt · Hadoop · Hive · HDFS · ksqlDB · MapReduce · ETL pipelines · star schema · dimensional modeling · stored procedures</p></div>
    </div>
  </section>

  <section class="sec" id="edu">
    <div class="sec__h"><h2>Education and certification</h2></div>
    <div class="twoup">
      <div class="ent"><h3>Master of Science, Applied Data Science</h3>
        <div class="ent__o">Syracuse University</div>
        <div class="ent__w">Jan 2025 to Dec 2026 · Syracuse, NY</div>
        <p>Deep learning (CNNs, LSTMs, RNNs, word embeddings, reinforcement learning), machine learning
          (ensemble methods, SVMs, HDBSCAN, DBSCAN, GMM, hyperparameter optimization), data engineering
          (Spark, Kafka, ksqlDB, Hive, HDFS, MapReduce), advanced databases (Neo4j with Cypher, Redis,
          Cassandra, Apache Drill), statistical analysis, applied research methods.</p></div>
      <div class="ent"><h3>Bachelor of Technology, Computer Science</h3>
        <div class="ent__o">JSSATE Noida</div>
        <div class="ent__w">Dec 2020 to May 2024 · Noida, India</div>
        <p>Data structures and algorithms, operating systems, computer networks, database management
          systems, software engineering, discrete mathematics. Capstone in machine learning and
          distributed systems.</p></div>
      <div class="ent"><h3>Lean Six Sigma Green Belt</h3>
        <div class="ent__o">Syracuse University, Whitman School of Management</div>
        <div class="ent__w">SCM 755 · Spring 2026</div>
        <p>Full DMAIC project at JMA Wireless sponsored by the SVP of Global Operations: standardized
          KPI framework, Python ETL pipeline, and Power BI dashboard.</p></div>
    </div>
  </section>

  <div class="foot" id="contact">
    <a href="mailto:tanayyps@gmail.com">tanayyps@gmail.com</a>
    <a href="https://github.com/TanayPratapSingh">github.com/TanayPratapSingh</a>
    <a href="Tanay_Pratap_Singh_Resume_MLE.pdf">Resume (PDF)</a>
    <span>Syracuse, NY</span>
  </div>

</main>

<div class="ov" id="ov" role="dialog" aria-modal="true" aria-labelledby="sheetTitle">
  <div class="sheet" id="sheet" tabindex="-1"></div>
</div>

<script>
const PROJECTS=__PROJECTS__;
const REPOS=__REPOS__;
const VIDEOS=__VIDEOS__;

const grid=document.getElementById('grid');
PROJECTS.forEach(function(p,i){
  const b=document.createElement('button');
  b.className='tile'; b.type='button';
  b.setAttribute('aria-haspopup','dialog');
  b.innerHTML='<div class="tile__meta">'+p.meta+'</div>'+
    '<h3>'+p.title+'</h3>'+
    '<div class="tile__badge">'+p.badge+'</div>'+
    '<div class="tile__tags">'+p.tags.join(' &middot; ')+'</div>'+
    '<div class="tile__foot"><span>Open write up</span>'+
      (VIDEOS[i]?'<span class="rec">walkthrough recorded</span>':'')+
      (REPOS[i]?'<span class="rec">code public</span>':'')+'</div>';
  b.addEventListener('click',function(){open(i);});
  grid.appendChild(b);
});

const ov=document.getElementById('ov'), sheet=document.getElementById('sheet');
let last=null;

function open(i){
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
</script>
</body>
</html>
"""

out = HEAD + TAIL
out = out.replace("__PROJECTS__", PROJECTS).replace("__REPOS__", REPOS).replace("__VIDEOS__", VIDEOS)
io.open("redesign.html", "w", encoding="utf-8").write(out)
print("wrote redesign.html:", len(out), "bytes")
