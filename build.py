"""Assemble index.html from the modules in site/.

Project write-ups live in site/data/projects.js; the page shell is composed
from site/css, site/partials, and site/js so no file holds the whole site.
"""
import io, json, pathlib, re

ROOT = pathlib.Path(__file__).parent
SITE = ROOT / "site"
OUT  = ROOT / "index.html"

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
        read(p / "fun.html").rstrip(),
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

if __name__ == "__main__":
    print("wrote index.html:", build(), "bytes")
