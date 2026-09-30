# PivotMap: Regional Resource Consents Viewer

A map and table for searching the resource consents published by New Zealand regional
councils, with expiry alerts, filters, CSV export and personal watchlists.

It covers about 188,000 consents from eight councils: Bay of Plenty (BOPRC), Hawke's Bay (HBDC),
Northland (NRC), Horizons (HRC), Waikato (WRC), Taranaki (TRC), Greater Wellington (GWRC)
and Gisborne (GDC).

**Live site:** https://dec3ptor.github.io/PivotMap/ (after the one-time setup below)

## Publishing on GitHub Pages

The site is plain HTML, CSS and JavaScript in [`public/`](public/). It's published by
the [Deploy to GitHub Pages](.github/workflows/deploy.yml) workflow.

**One-time setup:** in the repository go to **Settings → Pages → Build and deployment**
and set **Source** to **GitHub Actions**. Then either push to `main`, or open the
**Actions** tab, pick **Deploy to GitHub Pages** and click **Run workflow**.

After that:

- **Every push to `main`** redeploys the site with the data currently in `public/data/`.
- **Every day at about 4–5am NZ time** the workflow downloads fresh data from each
  council, commits it to `public/data/` ("Update consent data" commits by
  `github-actions[bot]`) and redeploys. Pull before pushing your own changes.
- **To refresh the data right now**, run the workflow by hand (**Run workflow** with
  *Download fresh consent data* ticked).

If a council's service is down or returns far fewer consents than last time, that region
keeps its previous data and the run's summary shows a warning. The **Data** button
above the map shows visitors when each region was last downloaded.
If no region can be refreshed at all, the run fails so you get GitHub's failure email.

GitHub pauses scheduled workflows in public repositories after 60 days without
repository activity. If that happens, re-enable it from the **Actions** tab.

## Running it locally

You need [Node.js](https://nodejs.org/) 20 or later. There are no dependencies to install.

```sh
npm start              # serve the site at http://localhost:8080/
npm test               # run the data pipeline tests
npm run update-data    # download fresh data for every region into public/data/
npm run update-data -- --region NRC,WRC    # refresh only some regions
```

Opening `public/index.html` directly from disk won't work: browsers block pages opened
from `file://` from loading the data files, so use `npm start` (or any static web server).

## How it fits together

```
public/                  the website (deployed as-is)
  index.html, app.js, styles.css
  data/manifest.json     list of regions: file, record count, download time, source URL
  data/<region>.json     one file per council, already normalised for the app
scripts/
  regions.mjs            each council's ArcGIS endpoint and field mapping
  arcgis.mjs             pages through an ArcGIS REST layer's /query endpoint
  update-data.mjs        downloads, normalises and writes public/data/
  serve.mjs              local web server used by `npm start`
test/                    tests for the data pipeline (node:test)
docs/schema_reference.html   field-by-field notes on each council's source data
```

Each council publishes different fields under different names. `scripts/regions.mjs`
maps them onto one common schema (consent ID, status, holder, address, purpose,
subtype, category, dates…), converts dates to `YYYY-MM-DD` and normalises status words
("Active" and "Granted" become "Current"). The app then only has to load and display.

The region files are compact: a list of `fields`, `constants` shared by every record,
and one `[longitude, latitude, ...values]` row per consent, one row per line, so
`git diff` shows which consents changed from day to day.

### Adding a council

1. Add an entry to `REGIONS` in [`scripts/regions.mjs`](scripts/regions.mjs) with its
   ArcGIS layer URL (ending in `/MapServer/<n>` or `/FeatureServer/<n>`) and a
   `normalize` function mapping its fields.
2. Run `npm run update-data -- --region <ID>` and check the result with `npm start`.
3. Commit `scripts/regions.mjs` and the new files in `public/data/`.

The region filter, the data sources panel and the scheduled refresh all read from the
manifest, so nothing else needs changing.

## Notes

- Consent data belongs to the councils and comes from their public ArcGIS services.
  Check each council's licence terms before reusing it, and check with the council
  before relying on a record.
- Map tiles come from OpenStreetMap, OpenTopoMap, CARTO and LINZ Basemaps. The LINZ
  API key in `public/app.js` is visible to every visitor, as is normal for browser
  map keys. You can get your own free key from [LINZ Basemaps](https://basemaps.linz.govt.nz/).
- Watchlists are saved in each visitor's browser (`localStorage`). Use **Export** and
  **Import** in the Watchlist panel to move them between browsers or share them.
