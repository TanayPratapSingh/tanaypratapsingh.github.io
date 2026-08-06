# tanaypratapsingh.github.io

Source for my personal site: [tanaypratapsingh.github.io](https://tanaypratapsingh.github.io)

An applied data science portfolio covering projects, experience, skills and education.

## Contents

| Section | Covers |
| --- | --- |
| Projects | Case studies with visuals, including aurora forecasting, energy demand, Formula 1 strategy, travel and wealth analysis |
| Experience | Research Assistant on Gravity Spy 2.0, Cybersecurity Teaching Assistant, Data and Product Analyst Intern |
| Technical Skills | Languages, frameworks and tooling |
| Certifications | Lean Six Sigma Green Belt |
| Education | MS in Applied Data Science and BTech in Computer Science and Engineering |
| Let's Connect | Contact links |

## Implementation

A single `index.html` of about 3,150 lines. Everything is inline: markup, styles and behaviour, with
no build step, no framework and no dependencies. It deploys straight from this repository through
GitHub Pages, so a push to `main` is a deploy.

## Repository layout

```
index.html          The entire site
images/             Project imagery
Resume *.pdf        Dated resume versions (April, May and July 2026)
```

## Note on duplicated images

All 16 images currently exist twice, once at the repository root and once inside `images/`. For
example `aurora_-000.jpg` and `images/aurora_-000.jpg` are the same file.

`index.html` references the `images/` copies exclusively, so the root level duplicates are unused
and safe to delete.
