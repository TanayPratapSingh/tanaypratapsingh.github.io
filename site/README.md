# site/

Source modules for `redesign.html`. Nothing here is served directly; `build.py`
at the repository root assembles them into the single page the site ships.

```
site/
  css/        one stylesheet per concern, concatenated in filename order
  partials/   page markup, one file per region
  js/         tile rendering, overlay behaviour, keyboard handling
```

## Why it is generated

The project write-ups live in `index.html` inside the `PROJECTS` array, and
they are the longest and most valuable content on the site, averaging over five
thousand characters each. Duplicating them into a second page would guarantee
the two drift apart. `build.py` reads `PROJECTS`, `REPOS`, and `VIDEOS` straight
out of `index.html`, so a project edited in one place appears correctly in both.

## Rebuilding

```bash
python3 build.py
```

Writes `redesign.html`. CSS files are concatenated in sorted filename order, so
the numeric prefixes are load order, not decoration: tokens must precede the
rules that reference them, and the responsive modules must come last.
