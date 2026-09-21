"""Assemble index.html from the modules in site/.

Project write-ups live in site/data/projects.js; the page shell is composed
from site/css, site/partials, and site/js so no file holds the whole site.
"""
import io, pathlib

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

if __name__ == "__main__":
    print("wrote index.html:", build(), "bytes")
