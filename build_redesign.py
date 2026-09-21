"""Generate redesign.html from index.html.

Left vertical sidebar carries identity, navigation, and contact. The main
column opens directly on the project tile grid. Project write-ups are carried
over verbatim from index.html so nothing is retyped.
"""
import io, re

src = io.open("index.html", encoding="utf-8").read()
def grab(n): return re.search(r'const %s=(\[.*?\]);' % n, src, re.S).group(1)
PROJECTS, REPOS, VIDEOS = grab("PROJECTS"), grab("REPOS"), grab("VIDEOS")

DOC = r"""<!doctype html>
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
  --paper:#F2F0EA; --surface:#FCFBF9; --sunk:#EEEBE3;
  --ink:#15171B; --ink-2:#565B62; --ink-3:#878D95;
  --rule:#DCD8D0; --rule-2:#B9B4A9; --met:#1B4D8F; --missed:#B3261E;
  --serif:'Newsreader',Georgia,serif; --mono:'IBM Plex Mono',ui-monospace,Menlo,monospace;
  --side:252px;
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

/* ---------- left rail ---------- */
.rail{position:fixed;top:0;left:0;bottom:0;width:var(--side);z-index:30;
  background:var(--surface);border-right:1px solid var(--rule-2);
  display:flex;flex-direction:column;padding:26px 22px 22px;overflow-y:auto}
.rail__name{font-size:22px;font-weight:500;letter-spacing:-0.018em;text-decoration:none;line-height:1.2}
.rail__role{margin-top:9px;font-size:14px;color:var(--ink-2);line-height:1.45}
.rail nav{margin-top:26px;display:flex;flex-direction:column;gap:1px}
.rail nav a{font-size:15.5px;color:var(--ink-2);text-decoration:none;padding:6px 9px;margin-left:-9px}
.rail nav a:hover{color:var(--ink);background:var(--sunk)}
.rail__spacer{flex:1;min-height:26px}
.rail__c{border-top:1px solid var(--rule);padding-top:14px}
.rail__c h2{font-size:12.2px;color:var(--ink-3);font-family:var(--mono);margin-bottom:8px}
.rail__c a,.rail__c span{display:block;font-size:13.6px;line-height:1.75;
  color:var(--ink-2);text-decoration:none;word-break:break-word}
.rail__c a{color:var(--met)}
.rail__c a:hover{text-decoration:underline;text-underline-offset:2px}
.rail__c span{color:var(--ink-3);font-family:var(--mono);font-size:12.2px;margin-top:7px}

/* ---------- main ---------- */
.main{margin-left:var(--side);padding:26px clamp(16px,2.6vw,38px) 0}
.sec{padding:30px 0;border-top:1px solid var(--rule-2)}
.sec:first-child{padding-top:0;border-top:0}
.sec > h2{font-size:20px;margin-bottom:18px}

/* ---------- tiles: separated objects, clear division ---------- */
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(322px,1fr));gap:18px}
.tile{background:var(--surface);border:1px solid var(--rule-2);
  padding:16px 17px 15px;display:flex;flex-direction:column;
  text-align:left;font:inherit;color:inherit;cursor:pointer;width:100%}
.tile:hover{border-color:var(--met)}
.tile:hover h3{color:var(--met)}
.tile__meta{font-family:var(--mono);font-size:11.5px;color:var(--ink-3);line-height:1.55}
.tile h3{font-size:18px;margin:8px 0 10px;letter-spacing:-0.012em}
.tile__badge{font-family:var(--mono);font-size:12.3px;color:var(--ink);background:var(--sunk);
  border-left:2px solid var(--met);padding:8px 10px;line-height:1.65}
.tile__tags{margin-top:11px;font-family:var(--mono);font-size:11.3px;color:var(--ink-3);
  line-height:1.7;flex:1}
.tile__foot{margin-top:12px;padding-top:10px;border-top:1px solid var(--rule);
  display:flex;flex-wrap:wrap;gap:4px 12px;font-family:var(--mono);font-size:11.4px;color:var(--met)}
.tile__foot .rec{color:var(--ink-3)}

/* ---------- overlay ---------- */
.ov{position:fixed;inset:0;z-index:40;display:none;background:rgba(21,23,27,.45)}
.ov.on{display:block}
.sheet{position:absolute;inset:0;margin:auto;max-width:1000px;width:calc(100% - 48px);
  max-height:92vh;overflow:auto;background:var(--paper);
  border:1px solid var(--rule-2);padding:clamp(20px,3vw,38px)}
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

.body h4{font-size:17px;margin:22px 0 7px;letter-spacing:-0.01em}
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

/* ---------- roles ---------- */
.job{background:var(--surface);border:1px solid var(--rule-2);padding:20px 22px;margin-bottom:18px}
.job__t{display:flex;flex-wrap:wrap;align-items:baseline;gap:5px 14px}
.job h3{font-size:20px}
.job__o{color:var(--ink-2);font-size:14.5px}
.job__w{margin-left:auto;font-family:var(--mono);font-size:12.2px;color:var(--ink-3)}
.job__s{margin:13px 0 0;display:grid;grid-template-columns:repeat(auto-fit,minmax(168px,1fr));
  gap:1px;background:var(--rule);border:1px solid var(--rule)}
.job__s div{background:var(--paper);padding:9px 12px}
.job__s dt{font-size:12px;color:var(--ink-3)}
.job__s dd{margin:2px 0 0;font-family:var(--mono);font-size:14.5px;color:var(--met);line-height:1.4}
.job__b{margin-top:14px}
.job__b p{margin:0 0 10px;font-size:15.2px;color:var(--ink-2);max-width:96ch}
.job__b p:last-child{margin-bottom:0}

.skills{display:grid;grid-template-columns:repeat(auto-fill,minmax(285px,1fr));gap:16px 26px}
.skills h3{font-size:13.6px;margin-bottom:4px}
.skills p{font-family:var(--mono);font-size:12.1px;color:var(--ink-2);line-height:1.75}

.twoup{display:grid;grid-template-columns:repeat(auto-fit,minmax(330px,1fr));gap:18px}
.ent{background:var(--surface);border:1px solid var(--rule-2);padding:17px 19px}
.ent h3{font-size:17.5px}
.ent__o{color:var(--ink-2);font-size:14.2px;margin-top:3px}
.ent__w{font-family:var(--mono);font-size:12.1px;color:var(--ink-3);margin-top:3px}
.ent p{margin-top:9px;font-size:14.8px;color:var(--ink-2)}

.tail{padding:26px 0 60px;border-top:1px solid var(--rule-2);
  font-family:var(--mono);font-size:12.2px;color:var(--ink-3)}

@media (max-width:900px){
  .rail{position:static;width:auto;flex-direction:column;border-right:0;
    border-bottom:1px solid var(--rule-2);padding:18px 16px}
  .rail nav{flex-direction:row;flex-wrap:wrap;gap:4px 14px;margin-top:16px}
  .rail nav a{margin-left:0;padding:3px 0}
  .rail__spacer{display:none}
  .rail__c{margin-top:16px}
  .rail__c a,.rail__c span{display:inline-block;margin-right:18px}
  .main{margin-left:0;padding:20px 16px 0}
  .job__w{margin-left:0;width:100%}
  .grid{grid-template-columns:1fr}
  .sheet{width:100%;max-height:100vh;border:0}
}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
</style>
</head>
<body>

<aside class="rail">
  <a class="rail__name" href="#">Tanay Pratap Singh</a>
  <p class="rail__role">Applied data scientist. Retrieval and evaluation systems, guardrails,
    streaming ingestion, and the dbt warehouse layer underneath them.</p>
  <nav>
    <a href="#projects">Projects</a>
    <a href="#exp">Experience</a>
    <a href="#skills">Technical skills</a>
    <a href="#edu">Education</a>
  </nav>
  <div class="rail__spacer"></div>
  <div class="rail__c">
    <h2>Contact</h2>
    <a href="mailto:tanayyps@gmail.com">tanayyps@gmail.com</a>
    <a href="mailto:tsingh13@syr.edu">tsingh13@syr.edu</a>
    <a href="https://github.com/TanayPratapSingh">github.com/TanayPratapSingh</a>
    <a href="Tanay_Pratap_Singh_Resume_MLE.pdf">Resume (PDF)</a>
    <span>Syracuse, NY<br>Open to ML / data / analytics engineering</span>
  </div>
</aside>

<main class="main">

  <section class="sec" id="projects">
    <div class="grid" id="grid"></div>
  </section>

  <section class="sec" id="exp">
    <h2>Experience</h2>

    <article class="job">
      <div class="job__t"><h3>Research Assistant, Gravity Spy 2.0</h3>
        <span class="job__o">Syracuse University &middot; NSF funded</span>
        <span class="job__w">Feb 2026 to present</span></div>
      <dl class="job__s">
        <div><dt>Classifications parsed</dt><dd>276,000+</dd></div>
        <div><dt>Glitch subjects</dt><dd>25,104</dd></div>
        <div><dt>Auxiliary channels</dt><dd>8,293</dd></div>
        <div><dt>Spectrograms retrieved</dt><dd>49,000</dd></div>
        <div><dt>Validation AUC</dt><dd>0.89</dd></div>
        <div><dt>Calibration error</dt><dd>0.10 to 0.05</dd></div>
      </dl>
      <div class="job__b">
        <p>NSF funded citizen science supporting LIGO. The scientific goal is causal inference on
          detector noise: identifying which auxiliary subsystems produce the transient glitches that
          contaminate gravitational wave strain data, so detector commissioners fix the responsible
          hardware instead of chasing symptoms.</p>
        <p>Built the ingestion pipeline in Python with pandas and the Zooniverse Panoptes API, parsing
          276,000+ volunteer classifications across 23 months of observations. The engineering work was
          reconciling five undocumented subject metadata schemas across project iterations, spanning
          25,104 glitch subjects and 8,293 auxiliary detector channels, and filtering roughly 38 science
          team accounts out of the volunteer population.</p>
        <p>Engineered an OpenCV workflow that retrieved 49,000 spectrograms through batch API calls,
          transforming 1200x1200 mosaics into paired 224x224 channel heatmaps suitable for deep learning
          input. The pipeline emits three outputs: a subject level flat file with aggregated volunteer
          labels, a separate file for subjects missing GPS metadata, and a GPS time by auxiliary channel
          pivot matrix covering 455 LIGO subsystems including PEM, SUS, LSC, ISI, ASC, and CAL.</p>
        <p>Trained a two input CNN with a shared MobileNetV2 backbone in TensorFlow and Keras to predict
          volunteer similarity labels directly from paired spectrograms, reaching 0.89 validation AUC on a
          held out 2,000 subject set. The result that matters more is calibration: label smoothing, AdamW,
          and AUC based early stopping brought Expected Calibration Error from 0.10 down to 0.05.</p>
        <p>Alongside the modeling, ran the descriptive analysis: volunteer effort is heavily right tailed,
          with the top ten volunteers accounting for 50% of all classifications, and inter volunteer
          agreement reaches 52% perfect consensus on multi classified subjects. Code is committed to the
          Syracuse CCDS GravitySpy Classifier repository.</p>
      </div>
    </article>

    <article class="job">
      <div class="job__t"><h3>Process Improvement Analyst</h3>
        <span class="job__o">JMA Wireless &middot; Liverpool, NY</span>
        <span class="job__w">Jan 2026 to May 2026</span></div>
      <dl class="job__s">
        <div><dt>Annualized impact</dt><dd>~$355K recovered</dd></div>
        <div><dt>Data pipeline</dt><dd>31 GB JSON to 5 MB</dd></div>
        <div><dt>KPIs standardized</dt><dd>4 across 2 lines</dd></div>
        <div><dt>Team and duration</dt><dd>5 analysts, 15 weeks</dd></div>
      </dl>
      <div class="job__b">
        <p>Client sponsored Lean Six Sigma capstone with a US manufacturer of 5G cell tower transmitters
          and active wireless infrastructure. Full DMAIC engagement for the Jumper Department with weekly
          on site stakeholder access, sponsored by the SVP of Global Operations.</p>
        <p>Ran the complete cycle: authored the project charter, SIPOC, and CTQC tree in Define; agreed
          sponsor approved definitions for four KPIs (Parts per Labor Hour, Uptime, First Time Throughput,
          Schedule Attainment) across one manual and one automated assembly line in Measure; then used
          Pareto and fishbone analysis to isolate material flow, not equipment availability, as the root
          cause of the automated line's shortfall.</p>
        <p>Built the data pipeline that made the analysis possible. The automated cell emitted deeply
          nested JSON, two datasets totalling 31 GB that would not open in Power BI. Using pandas
          <code>json_normalize</code> with explicit record paths and openpyxl, I flattened it to a wide
          format Excel file under 5 MB that loads instantly, casting types, computing cycle time, and
          processing a full week in under 30 seconds.</p>
        <p>Quantified impact: closing the automated line's schedule attainment gap recovers roughly 27,000
          cables per year at no added labor, about $324,000 at a $12 per cable margin, and the dashboard
          removes approximately 48 analyst hours per week of manual reporting, about $31,200. Combined
          recurring value is roughly $355,000 per year from a single department pilot.</p>
      </div>
    </article>

    <article class="job">
      <div class="job__t"><h3>Cybersecurity Teaching Assistant</h3>
        <span class="job__o">Syracuse University iSchool</span>
        <span class="job__w">Summer 2025</span></div>
      <dl class="job__s">
        <div><dt>Labs delivered</dt><dd>15+ hands on</dd></div>
        <div><dt>Domains</dt><dd>Crypto, network, pentest, forensics</dd></div>
        <div><dt>Toolchain</dt><dd>Wireshark, Kali, Nmap, OpenSSL, Metasploit</dd></div>
        <div><dt>VM stack</dt><dd>Kali, Win 10/Server, CentOS, Metasploitable</dd></div>
      </dl>
      <div class="job__b">
        <p>Graduate teaching assistant for the cybersecurity course, developing and delivering hands on
          labs across four domains: cryptography, network security, penetration testing, and digital
          forensics. Each lab walks students through the full attacker workflow, from OSINT reconnaissance
          and port scanning to exploitation and post compromise enumeration, then flips to the defensive
          reading of the same evidence.</p>
        <p>Built and maintained the multi VM lab environments the course runs on, using Kali Linux as the
          attacker platform against Windows 10, Windows Server, CentOS, and Metasploitable targets. Kept
          images, network configuration, and tooling reproducible so a full section could work through the
          same exercises without environment drift derailing the lesson.</p>
        <p>Technical coverage spans symmetric and asymmetric cryptography and hashing with OpenSSL
          (SHA 256, SHA 512), scanning and enumeration with Nmap, traffic capture and protocol analysis
          with Wireshark, and exploitation with Metasploit against intentionally vulnerable targets. On the
          forensics side, students practice evidence handling, file and metadata analysis, and writing
          findings up as a report.</p>
        <p>Held office hours debugging students' own attack chains, and graded labs and incident analysis
          reports with feedback on methodology rather than only the final answer, since in security the
          reasoning and the chain of evidence matter as much as the result. Reinforced scope,
          authorization, and responsible handling of tools throughout.</p>
      </div>
    </article>

    <article class="job">
      <div class="job__t"><h3>Data and Product Analyst Intern</h3>
        <span class="job__o">ProProfs &middot; Noida, India</span>
        <span class="job__w">Jul 2023 to Aug 2023</span></div>
      <dl class="job__s">
        <div><dt>SaaS users analyzed</dt><dd>5,000+</dd></div>
        <div><dt>Customer records</dt><dd>2,000 clients</dd></div>
        <div><dt>Features benchmarked</dt><dd>100 to 150</dd></div>
        <div><dt>Churn reduction</dt><dd>5%</dd></div>
        <div><dt>Rating lift</dt><dd>4.2 to 4.6</dd></div>
      </dl>
      <div class="job__b">
        <p>Product and customer analytics in Python across SaaS products serving 5,000+ users. Delivered
          SWOT analyses, competitive feature benchmarking against Zoho and Salesforce comparing 100 to 150
          features, and Ideal Customer Profile analyses to inform product strategy and prioritization.</p>
        <p>Analyzed customer datasets covering 2,000 clients using Python and Excel pivot tables to surface
          behavior patterns, pain points, and conversion drivers. Findings let the product team prioritize
          two high impact features for the next release that measurably lifted trial to paid conversion.
          Built interactive Tableau dashboards sourced from SQL and Excel, identifying under used features
          and reducing churn by 5 percent.</p>
      </div>
    </article>
  </section>

  <section class="sec" id="skills">
    <h2>Technical skills</h2>
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
    <h2>Education and certification</h2>
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
        <p>Full DMAIC project at JMA Wireless sponsored by the SVP of Global Operations: standardized KPI
          framework, Python ETL pipeline, and Power BI dashboard.</p></div>
    </div>
  </section>

  <div class="tail">Built and maintained by hand. Source on GitHub.</div>
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

out = DOC.replace("__PROJECTS__", PROJECTS).replace("__REPOS__", REPOS).replace("__VIDEOS__", VIDEOS)
io.open("redesign.html", "w", encoding="utf-8").write(out)
print("wrote redesign.html:", len(out), "bytes")
