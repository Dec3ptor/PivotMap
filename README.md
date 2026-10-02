# PivotMap: Consent Renewals

Finds New Zealand resource consents that are about to expire — renewal work for WSP NZ
teams — and shows the land parcel, titles and every other consent at the site.

It covers about 189,000 consents from eight councils: Bay of Plenty (BOPRC), Hawke's Bay (HBDC),
Northland (NRC), Horizons (HRC), Waikato (WRC), Taranaki (TRC), Greater Wellington (GWRC)
and Gisborne (GDC).

**Live site:** https://dec3ptor.github.io/PivotMap/ (after the one-time setup below)

## Using it

1. **Pick a time window** (6 months to 5 years, or *All*). The list shows current consents
   expiring in that window, soonest first; the map colours them by how soon they expire.
2. **Narrow it down** with four dropdowns: council, type of work (wastewater, water takes,
   stormwater, coastal, energy and quarries, roads…), type of holder (councils and government,
   utilities, companies, individuals) and *More* for the law-change options. Small jobs
   (moorings, domestic bores, septic tanks) and farm effluent are hidden until you tick them.
3. **Open a consent** for its renewal deadline (RMA s124 *lodge by* date), council documents,
   the land parcel it's on and other consents within 60 m.
4. **Click anywhere on the map** (zoomed in) for the property there: legal description, area,
   records of title, addresses and every consent on that parcel. Parcel boundaries appear
   when zoomed right in. The search box also finds addresses and places (press Enter).
5. **Star** consents to shortlist them with your own notes, and **Export** any list as a
   spreadsheet. The **Holders** tab ranks holders by how many consents they have in your
   selection.

### Law changes the app accounts for

- **RMA s123C** (December 2025) extended most consents that were due to expire before
  31 December 2027 to that date, so thousands of consents share it. They're tagged
  *31 Dec 2027 extension*, and *More → Hide 31 Dec 2027 extension dates* removes them.
- The **Planning Act 2026** is expected to extend most consents again (to about two years
  after the national transition period, around 2031).
- Freshwater consents at their **35-year maximum term** and **wastewater network** consents
  aren't extended, so they're tagged *Firm date* (*More → Only firm expiry dates*).

The rules live in `LAW` and `enrich()` in [`public/js/consents.js`](public/js/consents.js).
The app is a guide, not legal advice.

### Property information

Parcel, title and address details come from Toitū Te Whenua LINZ open data (CC BY 4.0),
read live from public ArcGIS services listed in `PROPERTY_SERVICES` in
[`public/js/property.js`](public/js/property.js) (Esri NZ's hosted LINZ layers, falling back
to MPI's cadastral service). **Owner names aren't shown**: LINZ only releases them under the
LINZ Licence for Personal Data, which doesn't allow unsolicited direct marketing — use a
title search or your licensed property tools when you need the owner.

## Publishing on GitHub Pages

The site is plain HTML, CSS and JavaScript modules in [`public/`](public/), with no build step.
It's published by the [Deploy to GitHub Pages](.github/workflows/deploy.yml) workflow.

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
keeps its previous data and the run's summary shows a warning. The **Data** button in the
app shows when each council was last updated and flags any more than three days old.
If no region can be refreshed at all, the run fails so you get GitHub's failure email.

GitHub pauses scheduled workflows in public repositories after 60 days without
repository activity. If that happens, re-enable it from the **Actions** tab.

### Councils not currently refreshing

As of October 2026 two councils' daily downloads fail, so the app shows their April 2026 data:

- **Hawke's Bay** (`gis.hbrc.govt.nz`): connections from GitHub's servers fail ("fetch failed"),
  which suggests the council blocks overseas or cloud traffic. Running
  `npm run update-data -- --region HBDC` from a New Zealand connection should work.
- **Gisborne** (`maps.gdc.govt.nz/hosting/.../resource_consents_ext/MapServer/0`): the layer
  now returns "404 Layer not found". The council has moved or renamed it; find the new layer
  URL in the council's ArcGIS services directory and update `scripts/regions.mjs`.

## Running it locally

You need [Node.js](https://nodejs.org/) 20 or later. There are no dependencies to install.

```sh
npm start              # serve the site at http://localhost:8080/
npm test               # run the tests
npm run update-data    # download fresh data for every region into public/data/
npm run update-data -- --region NRC,WRC    # refresh only some regions
```

Opening `public/index.html` directly from disk won't work: browsers block pages opened
from `file://` from loading the data files, so use `npm start` (or any static web server).

## How it fits together

```
public/                    the website (deployed as-is)
  index.html, styles.css
  js/main.js               the app: filters, lists, consent and property panels
  js/consents.js           consent logic: expiry timing, law changes, work and holder types
  js/property.js           LINZ parcel, title and address lookups
  js/map.js                Leaflet map, markers, clusters and parcel boundaries
  js/shortlist.js          starred consents and notes (browser storage)
  js/format.js             HTML escaping and date/number formatting
  data/manifest.json       list of regions: file, record count, download time, source URL
  data/<region>.json       one file per council, already normalised for the app
scripts/
  regions.mjs              each council's ArcGIS endpoint and field mapping
  arcgis.mjs               pages through an ArcGIS REST layer's /query endpoint
  update-data.mjs          downloads, normalises and writes public/data/
  serve.mjs                local web server used by `npm start`
test/                      tests (node:test) for the pipeline and the app's logic
docs/schema_reference.html field-by-field notes on each council's source data
```

Each council publishes different fields under different names. `scripts/regions.mjs`
maps them onto one common schema (consent ID, status, holder, address, purpose,
subtype, category, dates…), converts dates to `YYYY-MM-DD` and normalises status words
("Active" and "Granted" become "Current").

In the browser, `public/js/consents.js` works out what each consent means for renewals:
whether it's current, days to expiry, the s124 lodge-by date, the law-change flags, and
which **type of work** and **type of holder** it is. Work and holder types come from ordered
keyword rules over each council's own wording (`WORK_RULES`, `HOLDER_NAME_RULES`), tested
against real examples in [`test/consents.test.mjs`](test/consents.test.mjs) — add a case
there when you adjust a rule.

The region files are compact: a list of `fields`, `constants` shared by every record,
and one `[longitude, latitude, ...values]` row per consent, one row per line, so
`git diff` shows which consents changed from day to day.

### Adding a council

1. Add an entry to `REGIONS` in [`scripts/regions.mjs`](scripts/regions.mjs) with its
   ArcGIS layer URL (ending in `/MapServer/<n>` or `/FeatureServer/<n>`) and a
   `normalize` function mapping its fields.
2. Run `npm run update-data -- --region <ID>` and check the result with `npm start`.
   If the council describes activities differently, check the *Type of work* counts and
   add rules or test cases in `public/js/consents.js`.
3. Commit `scripts/regions.mjs` and the new files in `public/data/`.

The council filter, the data sources panel and the scheduled refresh all read from the
manifest, so nothing else needs changing.

## Notes

- Consent data belongs to the councils and comes from their public ArcGIS services.
  Check each council's licence terms before reusing it, and check with the council
  before relying on a record. Only Bay of Plenty and Waikato publish holder names;
  Northland publishes no expiry dates; Taranaki publishes current consents only.
- Map tiles come from LINZ Basemaps, OpenStreetMap, OpenTopoMap and CARTO; place search
  uses OpenStreetMap's Nominatim. The LINZ Basemaps key in `public/js/map.js` is visible to
  every visitor, as is normal for browser map keys. You can get your own free key from
  [LINZ Basemaps](https://basemaps.linz.govt.nz/).
- Shortlists, notes and filter choices are saved in each visitor's browser
  (`localStorage`). Consents starred in the previous version's watchlist folders are
  carried over automatically. Use **Export** to share a shortlist as a spreadsheet.
