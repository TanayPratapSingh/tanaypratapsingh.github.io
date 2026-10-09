# live/

Four dashboards that run on real public data, entirely in the browser. Each one
connects straight to its source, keeps what it needs in memory, and computes
every number on the page as the data arrives. There is no backend and nothing
is stored between visits.

| Page | Source | How data arrives | What it checks itself against |
| --- | --- | --- | --- |
| [Edit stream](wiki.html) | Wikimedia EventStreams `recentchange` | Server sent events, resumed with Last-Event-ID | Exact counters running beside HyperLogLog, Count-Min and Space-Saving |
| [Order book](book.html) | Kraken WebSocket API v2 | Snapshot, then incremental updates | The exchange's CRC32 checksum on every update |
| [Earthquakes](quakes.html) | USGS GeoJSON summary feeds | Polled every minute, merged, revisions logged | Synthetic catalogs with known b-value and Omori parameters |
| [Space weather](sun.html) | NOAA SWPC JSON products, nine feeds | Polled on each feed's cadence, joined on time | Published reference values for the Shue, Newell and pressure formulas |

[`index.html`](index.html) is the overview, with one live reading per dashboard.

## Run it

Any static file server works. From the repository root:

```bash
python3 -m http.server 8765
```

Then open `http://localhost:8765/live/`. ES modules do not load from `file://`.

## Tests

The analytic code for each dashboard lives in a module with no DOM access, so
node can test it directly:

```bash
node --test live/tests/*.test.mjs
```

Node 22 or newer. There is no package.json and nothing to install. The suite has 87 tests: 24 for the edit stream, 16 for the order book, 27 for the earthquake statistics and 20 for space weather.

Two slower calibration checks for the earthquake statistics live in `tests/sim/` and run on their own:

```bash
node live/tests/sim/quakes_b_coverage.mjs
node live/tests/sim/quakes_omori_spread.mjs
```

## Layout

```
live/
  index.html, wiki.html, book.html, quakes.html, sun.html
  assets/
    live.css      tokens (light and dark), layout, cards, the stage, disclosures
    util.js       formatting, ring buffers, EWMA, OLS, quantiles, seeded RNG, axis ticks
    ui.js         theme, palette, feed health, polling, the paint scheduler, table views
    charts.js     canvas TimeChart, Columns and Scatter with hover and keyboard focus
    hub.js        live readings for the overview cards
  wiki/   sketch.js (pure) + app.js
  book/   book.js (pure) + app.js
  quakes/ seismo.js (pure) + app.js
  sun/    helio.js (pure) + app.js
  tests/  one test file per dashboard, a captured Kraken book fixture, and sim/ calibration scripts
  runs/   logs of the live runs behind every number quoted in the portfolio write ups
  img/    screenshots used on the overview page
```

Rendering is decoupled from ingestion. Message handlers only mutate state; every
chart registers a paint function with one scheduler in `ui.js`, which paints at a
fixed rate and stops while the tab is hidden or the display is paused. The order
book takes more than a hundred messages a second this way without the page
falling behind.

## Where the numbers come from

Every figure quoted in the portfolio write ups traces to a file in `runs/`:

| Log | What it records |
| --- | --- |
| `2026-10-08-wiki-run1..3.txt` | Sketch estimates against exact counts on the live stream (118 to 297 s) |
| `2026-10-08-book-run1.txt`, `-run2.txt` | 330 s runs on BTC/USD at depth 100: checksums, OFI regression, realized volatility |
| `2026-10-08-book-symbol-switch.txt` | Checksums across BTC/USD, ETH/USD and SOL/USD switches |
| `2026-10-08-quakes-run.txt` | Per region completeness, b-value, bootstrap interval, aftershock candidates |
| `2026-10-08-quakes-poll.txt` | 45 minutes of polling: every new event, revision and id change |
| `2026-10-08-quakes-simulations.txt` | Bootstrap coverage of b over 300 synthetic catalogs, and the spread of the Omori exponent at two sample sizes |
| `2026-10-08-sun.txt` | One pass over all nine NOAA feeds with every derived quantity |

These runs used the same modules the pages load, driven from node. The overview and write up screenshots were captured from the live pages with headless Chrome on the same day.

## External code and data

Pinned, loaded at runtime from jsDelivr, and used only by the two map views:

- `d3-geo@3.1.1`, `topojson-client@3.1.0`
- `world-atlas@2.0.2/land-110m.json` (Natural Earth, public domain)
- Plate boundaries from `fraxen/tectonicplates` at commit `339b0c5`, ODC-BY 1.0, after Bird (2003); credit Hugo Ahlenius, Nordpil and Peter Bird

If the CDN is unreachable the maps show a message and every number is still computed.

## Color

The categorical slots are the validated eight hue order from the dataviz method,
checked against this site's surfaces with its validator. On the light surface
(`#FCFBF9`) every check passes and three slots fall under 3:1 contrast, so those
are always paired with labels or a table view. On the dark surface (`#18191C`)
every check passes outright. Blue and orange, the pair used for every two way
split (humans and bots, bids and asks, buys and sells), passes the all pairs
check for color vision deficiency.

## Data terms

Wikimedia EventStreams data is public. Kraken market data comes from its public
API under Kraken's terms; nothing here is investment advice. USGS and NOAA data
are U.S. government works in the public domain.
