"""Assemble index.html and town.html from the modules in site/.

Project write-ups live in site/data/projects.js; the classic page shell is
composed from site/css, site/partials, and site/js so no file holds the whole
site. town.html is the visual version: site/town/ holds its map, styles and
script, and it reads the same project data and partials, so the two pages
cannot drift apart.
"""
import importlib.util, io, json, pathlib, re

ROOT = pathlib.Path(__file__).parent
SITE = ROOT / "site"
OUT  = ROOT / "index.html"
TOWN = ROOT / "town.html"

def read(p):
    return io.open(p, encoding="utf-8").read()

def concat(folder, suffix):
    parts = sorted(p for p in (SITE / folder).iterdir() if p.suffix == suffix)
    return "\n".join(read(p).rstrip() for p in parts)

def build():
    p = SITE / "partials"
    page = "\n".join([
        read(p / "head.html").rstrip(),
        "<style>",
        concat("css", ".css"),
        "</style>",
        "</head>",
        "<body>",
        "",
        read(p / "rail.html").rstrip(),
        "",
        read(p / "projects.html").rstrip(),
        "",
        read(p / "experience.html").rstrip(),
        "",
        read(p / "skills.html").rstrip(),
        "",
        read(p / "education.html").rstrip(),
        "",
        read(p / "footer.html").rstrip(),
        "",
        read(p / "overlay.html").rstrip(),
        "",
        "<script>",
        read(SITE / "data" / "projects.js").rstrip(),
        concat("js", ".js"),
        "</script>",
        "</body>",
        "</html>",
        "",
    ])
    io.open(OUT, "w", encoding="utf-8").write(page)
    return len(page)

def check_town(town, projects, experience):
    """Every project sits in exactly one building and every job has a plain line."""
    keys = [pr["title"].split(":")[0].strip() for pr in projects]
    placed = [k for b in town["buildings"] for k in b.get("projects", [])]
    jobs = re.findall(r'<div class="job__t"><h3>(.*?)</h3>', experience)
    problems = {
        "projects in no building": sorted(set(keys) - set(placed)),
        "buildings naming unknown projects": sorted(set(placed) - set(keys)),
        "projects in two buildings": sorted({k for k in placed if placed.count(k) > 1}),
        "projects with no plain line": sorted(set(keys) - set(town["plain"])),
        "jobs with no plain line": sorted(set(jobs) - set(town["jobs"])),
    }
    problems = {k: v for k, v in problems.items() if v}
    if problems:
        raise SystemExit("town.json is out of step with the site: %s" % problems)

def build_town():
    t, p = SITE / "town", SITE / "partials"
    spec = importlib.util.spec_from_file_location("town_map", t / "map.py")
    town_map = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(town_map)

    town = json.loads(read(t / "town.json"))
    data = read(SITE / "data" / "projects.js").rstrip()
    line = next(l for l in data.split("\n") if l.startswith("const PROJECTS="))
    check_town(town, json.loads(line[len("const PROJECTS="):].rstrip(";")), read(p / "experience.html"))

    short = town["short"]
    labels = {b["id"]: "%s: %s" % (b["name"], ", ".join(short.get(k, k) for k in b["projects"]) if b.get("projects") else b["about"])
              for b in town["buildings"]}
    templates = "\n".join('<template id="t-%s">\n%s\n</template>' % (name, read(p / f).rstrip())
                          for name, f in [("rail", "rail.html"), ("exp", "experience.html"),
                                          ("skills", "skills.html"), ("edu", "education.html")])
    scripts = "\n".join([data, "const TOWN=" + json.dumps(town, ensure_ascii=False) + ";", read(t / "town.js").rstrip()])
    page = read(t / "shell.html")
    for slot, value in [("{{CSS}}", read(t / "town.css").rstrip()), ("{{MAP}}", town_map.render(labels)),
                        ("{{TEMPLATES}}", templates), ("{{SCRIPTS}}", scripts)]:
        page = page.replace(slot, value)
    io.open(TOWN, "w", encoding="utf-8").write(page)
    return len(page)

if __name__ == "__main__":
    print("wrote index.html:", build(), "bytes")
    print("wrote town.html:", build_town(), "bytes")
