#!/usr/bin/env node
// === Refresh the consent data served by the site ===
// Downloads each region from its council's ArcGIS service, normalises it to the
// app's schema and writes public/data/<region>.json plus public/data/manifest.json.
//
//   node scripts/update-data.mjs                   refresh every region
//   node scripts/update-data.mjs --region NRC,WRC  refresh only these regions
//   node scripts/update-data.mjs --source-dir DIR  read DIR/<region>.geojson instead of downloading
//                                                  (extra layers: <region>-2.geojson…, joined
//                                                  details: <region>-details.geojson)
//
// A region that fails to download, or comes back with far fewer consents than last
// time, keeps its previous data file, so one council's outage never breaks the site.

import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { fillLink } from '../public/js/consents.js';
import { downloadHubExport, downloadLayer } from './arcgis.mjs';
import { COMMON_FIELDS, HISTORY_YEARS, REGIONS, keepRecord, normalizeRegion } from './regions.mjs';

export const MANIFEST_VERSION = 1;
// Reject a refresh whose download is less than this fraction of the previous one's: a sign
// the council's server returned only part of its data.
const MIN_RETAINED_FRACTION = 0.5;
const DEFAULT_OUT_DIR = fileURLToPath(new URL('../public/data/', import.meta.url));

const compareText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// Encode normalised records as a compact region file:
//   { region, fields, constants, links?, records: [[lng, lat, ...values in `fields` order], ...] }
// Fields with the same value on every record move to `constants`; fields empty on every
// record are dropped; GlobalID is stored only where it isn't "<region>:<ConsentID>".
// `links` maps a field to a pattern (see fillLink in js/consents.js): when every record's value follows it,
// the values are left out and the app rebuilds them, which keeps long URLs out of the file.
// Records are sorted and written one per line so day-to-day diffs stay readable.
export function encodeRegionData(regionId, records, { links = {} } = {}) {
    const sorted = [...records].sort((a, b) =>
        compareText(a.fields.ConsentID || '', b.fields.ConsentID || '')
        || compareText(a.fields.GlobalID || '', b.fields.GlobalID || '')
        || a.lng - b.lng || a.lat - b.lat);

    const keys = [...COMMON_FIELDS];
    for (const record of sorted) {
        for (const key of Object.keys(record.fields)) {
            if (!keys.includes(key)) keys.push(key);
        }
    }

    const usedLinks = Object.fromEntries(Object.entries(links).filter(([key, pattern]) =>
        sorted.length && sorted.every(r => (r.fields[key] ?? '') === fillLink(pattern, r.fields))));
    const valueOf = (record, key) => {
        if (key in usedLinks) return '';
        if (key === 'GlobalID' && record.fields.GlobalID === `${regionId}:${record.fields.ConsentID}`) return '';
        return record.fields[key] ?? '';
    };

    const fields = [];
    const constants = {};
    for (const key of keys) {
        const firstValue = sorted.length ? valueOf(sorted[0], key) : '';
        if (sorted.every(r => valueOf(r, key) === firstValue)) {
            if (firstValue !== '') constants[key] = firstValue;
        } else {
            fields.push(key);
        }
    }

    const header = { region: regionId, fields, constants };
    if (Object.keys(usedLinks).length) header.links = usedLinks;
    const rows = sorted.map(r => JSON.stringify([r.lng, r.lat, ...fields.map(k => valueOf(r, k))]));
    return `${JSON.stringify(header).slice(0, -1)},"records":[\n${rows.join(',\n')}\n]}\n`;
}

// Attach each feature's rows from a details layer (attributes only), joined on `key`:
// feature.properties[as] = [{ ...fields }, ...].
async function joinDetails(features, { url, key, fields, as }, download, options, log) {
    log(`  joining ${url}`);
    const rows = await download(url, { ...options, outFields: [key, ...fields].join(','), returnGeometry: false });
    const byKey = new Map();
    for (const row of rows.features) {
        const p = row.properties || {};
        const id = p[key];
        if (id === null || id === undefined || id === '') continue;
        let list = byKey.get(id);
        if (!list) byKey.set(id, list = []);
        list.push(Object.fromEntries(fields.map(f => [f, p[f] ?? null])));
    }
    for (const feature of features) {
        if (!feature.properties) feature.properties = {};
        feature.properties[as] = byKey.get(feature.properties[key]) || [];
    }
}

// Download one region: its layer, any extra layers (appended) and joined details. If the
// council's server fails and the region has an ArcGIS Hub copy, that is used instead.
// Returns { geojson, copy, sourceDate }: when the Hub copy was used, its URL and when Hub
// last refreshed it (it can be days behind the council).
export async function fetchRegion(region, { download = downloadLayer, downloadHub = downloadHubExport, log = () => {} } = {}) {
    const options = region.pageSize ? { log, pageSize: region.pageSize } : { log };
    // With a copy to fall back on, don't spend long on a server that may be unreachable.
    if (region.fallback) Object.assign(options, { retries: 2, timeoutMs: 60000 });
    try {
        const features = [...(await download(region.url, options)).features];
        for (const url of region.layers || []) {
            log(`  adding ${url}`);
            features.push(...(await download(url, options)).features);
        }
        if (region.details) await joinDetails(features, region.details, download, options, log);
        return { geojson: { type: 'FeatureCollection', features }, copy: null, sourceDate: null };
    } catch (err) {
        if (!region.fallback) throw err;
        log(`  ${err.message}; trying the ArcGIS Hub copy`);
        try {
            const hub = await downloadHub({ itemId: region.fallback.hubItemId, layer: region.fallback.layer }, { log });
            return { geojson: hub.geojson, copy: hub.source, sourceDate: hub.sourceDate };
        } catch (hubError) {
            throw new Error(`${err.message}; the ArcGIS Hub copy failed too: ${hubError.message}`);
        }
    }
}

// --source-dir: the region's layers come from local files instead of the network.
function localDownload(region, sourceDir) {
    const base = region.id.toLowerCase();
    const files = new Map([[region.url, `${base}.geojson`]]);
    (region.layers || []).forEach((url, i) => files.set(url, `${base}-${i + 2}.geojson`));
    if (region.details) files.set(region.details.url, `${base}-details.geojson`);
    return async (url) => readJson(join(sourceDir, files.get(url)));
}

async function readJson(path) {
    return JSON.parse(await readFile(path, 'utf8'));
}

async function readManifest(path) {
    try {
        const manifest = await readJson(path);
        return Array.isArray(manifest.regions) ? manifest : { regions: [] };
    } catch (err) {
        if (err.code === 'ENOENT') return { regions: [] };
        throw err;
    }
}

// Write via a temp file so an interrupted run never leaves a half-written file behind.
async function writeFileAtomic(path, text) {
    const tmp = `${path}.tmp`;
    await writeFile(tmp, text);
    await rename(tmp, path);
}

// Refresh data for `only` (region IDs; default: all) and rewrite the manifest.
// Returns one result per attempted region: { id, ok, count, previousCount, error, seconds }.
export async function updateData({
    regions = REGIONS,
    only = null,
    outDir = DEFAULT_OUT_DIR,
    sourceDir = null,
    fetchedAt = null,
    force = false,
    log = console.log,
    download = downloadLayer,
    downloadHub = downloadHubExport
} = {}) {
    await mkdir(outDir, { recursive: true });
    const manifestPath = join(outDir, 'manifest.json');
    const entries = new Map((await readManifest(manifestPath)).regions.map(entry => [entry.id, entry]));
    const selected = only ? regions.filter(r => only.includes(r.id)) : regions;
    const results = [];
    // Consents that ended before this date are left out (see keepRecord)
    const asOf = fetchedAt ? new Date(fetchedAt) : new Date();
    const cutoff = `${asOf.getUTCFullYear() - HISTORY_YEARS}-${String(asOf.getUTCMonth() + 1).padStart(2, '0')}-${String(asOf.getUTCDate()).padStart(2, '0')}`;

    for (const region of selected) {
        const started = Date.now();
        const previous = entries.get(region.id);
        const previousCount = previous ? previous.count : null;
        // Compare raw download sizes, so changes to merging or the history kept don't trip the check
        const previousDownloaded = previous ? (previous.downloaded ?? previous.count) : null;
        log(`\n=== ${region.id} — ${region.name}`);
        try {
            const { geojson, copy, sourceDate } = sourceDir
                ? await fetchRegion(region, { download: localDownload(region, sourceDir), log })
                : await fetchRegion(region, { download, downloadHub, log });
            const all = normalizeRegion(region, geojson);
            if (!all.length) throw new Error('No consents with a valid location were returned');
            const downloaded = geojson.features.length;
            if (previousDownloaded && !force && downloaded < previousDownloaded * MIN_RETAINED_FRACTION) {
                throw new Error(`Only ${downloaded} consents vs ${previousDownloaded} last time; `
                    + 'keeping previous data (re-run with --force to accept)');
            }
            const records = all.filter(r => keepRecord(r.fields, cutoff));
            if (!records.length) throw new Error(`None of the consents is current or ended in the last ${HISTORY_YEARS} years`);
            log(`  ${downloaded} rows → ${all.length} consents`
                + (records.length < all.length ? `, ${all.length - records.length} that ended over ${HISTORY_YEARS} years ago left out` : ''));

            const file = `${region.id.toLowerCase()}.json`;
            const text = encodeRegionData(region.id, records, { links: region.links });
            await writeFileAtomic(join(outDir, file), text);
            const entry = {
                id: region.id,
                name: region.name,
                file,
                count: records.length,
                downloaded,
                hash: createHash('sha256').update(text).digest('hex').slice(0, 12),
                fetchedAt: fetchedAt || new Date().toISOString(),
                source: region.url
            };
            // From a copy: where it came from and how old its data is
            if (copy) entry.copy = copy;
            if (sourceDate) entry.sourceDate = sourceDate;
            entries.set(region.id, entry);
            if (copy) log(`  used the copy at ${copy}${sourceDate ? `, last refreshed ${sourceDate}` : ''}`);
            const seconds = (Date.now() - started) / 1000;
            log(`  => ${records.length} consents written to ${file} (${seconds.toFixed(1)}s)`);
            results.push({ id: region.id, ok: true, count: records.length, previousCount, seconds });
        } catch (err) {
            const seconds = (Date.now() - started) / 1000;
            log(`  FAILED: ${err.message}${previous ? ' (keeping previous data)' : ''}`);
            results.push({ id: region.id, ok: false, error: err.message, previousCount, seconds });
        }
    }

    const manifest = {
        version: MANIFEST_VERSION,
        regions: regions.map(r => entries.get(r.id)).filter(Boolean)
    };
    await writeFileAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    return results;
}

function formatSummary(results) {
    const lines = [
        '| Region | Result | Consents | Change | Time |',
        '| --- | --- | ---: | ---: | ---: |'
    ];
    for (const r of results) {
        const change = r.ok && r.previousCount != null ? r.count - r.previousCount : null;
        lines.push(`| ${r.id} | ${r.ok ? 'Updated' : `Failed: ${r.error.replace(/\|/g, '\\|')}`} | `
            + `${r.ok ? r.count.toLocaleString('en-NZ') : '—'} | `
            + `${change == null ? '—' : (change > 0 ? '+' : '') + change.toLocaleString('en-NZ')} | `
            + `${r.seconds.toFixed(1)}s |`);
    }
    return lines.join('\n');
}

async function main() {
    const { values } = parseArgs({
        options: {
            region: { type: 'string' },
            'source-dir': { type: 'string' },
            'fetched-at': { type: 'string' },
            out: { type: 'string' },
            force: { type: 'boolean', default: false },
            help: { type: 'boolean', short: 'h', default: false }
        }
    });
    if (values.help) {
        console.log('Usage: node scripts/update-data.mjs [--region ID,ID] [--source-dir DIR] '
            + '[--fetched-at ISO-DATE] [--out DIR] [--force]');
        return;
    }

    const only = values.region ? values.region.split(',').map(s => s.trim().toUpperCase()).filter(Boolean) : null;
    const unknown = (only || []).filter(id => !REGIONS.some(r => r.id === id));
    if (unknown.length) {
        console.error(`Unknown region(s): ${unknown.join(', ')}. Known: ${REGIONS.map(r => r.id).join(', ')}`);
        process.exitCode = 2;
        return;
    }
    let fetchedAt = null;
    if (values['fetched-at']) {
        const d = new Date(values['fetched-at']);
        if (Number.isNaN(d.getTime())) {
            console.error(`Invalid --fetched-at date: ${values['fetched-at']}`);
            process.exitCode = 2;
            return;
        }
        fetchedAt = d.toISOString();
    }

    const results = await updateData({
        only,
        outDir: values.out || DEFAULT_OUT_DIR,
        sourceDir: values['source-dir'] || null,
        fetchedAt,
        force: values.force
    });

    const summary = formatSummary(results);
    console.log(`\n${summary}\n`);
    if (process.env.GITHUB_STEP_SUMMARY) {
        await appendFile(process.env.GITHUB_STEP_SUMMARY, `## Consent data refresh\n\n${summary}\n`);
    }
    const failed = results.filter(r => !r.ok);
    if (process.env.GITHUB_ACTIONS === 'true') {
        for (const r of failed) console.log(`::warning title=${r.id} data not refreshed::${r.error}`);
    }
    // Fail only when nothing could be refreshed; partial failures keep the previous data.
    if (results.length && failed.length === results.length) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch(err => {
        console.error(err);
        process.exitCode = 1;
    });
}
