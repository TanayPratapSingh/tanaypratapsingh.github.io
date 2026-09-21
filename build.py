"""Assemble redesign.html from the modules in site/.

Content is single sourced: the project write-ups come straight out of
index.html, and the page shell is composed from site/css, site/partials, and
site/js so no file has to hold the whole site at once.
"""
import io, re, pathlib

ROOT = pathlib.Path(__file__).parent
SITE = ROOT / "site"

def read(p):
    return io.open(p, encoding="utf-8").read()

def concat(folder, suffix):
    parts = sorted(p for p in (SITE / folder).iterdir() if p.suffix == suffix)
    return "\n".join(read(p).rstrip() for p in parts)

def project_data():
    src = read(ROOT / "index.html")
    grab = lambda n: re.search(r"const %s=(\[.*?\]);" % n, src, re.S).group(1)
    return grab("PROJECTS"), grab("REPOS"), grab("VIDEOS")

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
        concat("js", ".js"),
        "</script>",
        "</body>",
        "</html>",
        "",
    ])
    projects, repos, videos = project_data()
    page = (page.replace("__PROJECTS__", projects)
                .replace("__REPOS__", repos)
                .replace("__VIDEOS__", videos))
    io.open(ROOT / "redesign.html", "w", encoding="utf-8").write(page)
    return len(page)

if __name__ == "__main__":
    print("wrote redesign.html:", build(), "bytes")
