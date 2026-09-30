#!/usr/bin/env node
// === Refresh the consent data served by the site ===
// Downloads each region from its council's ArcGIS service, normalises it to the
// app's schema and writes public/data/<region>.json plus public/data/manifest.json.
//
//   node scripts/update-data.mjs                   refresh every region
//   node scripts/update-data.mjs --region NRC,WRC  refresh only these regions
//   node scripts/update-data.mjs --source-dir DIR  read DIR/<region>.geojson instead of downloading
//
// A region that fails to download, or comes back with far fewer consents than last
// time, keeps its previous data file, so one council's outage never breaks the site.

import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { downloadLayer } from './arcgis.mjs';
import { COMMON_FIELDS, REGIONS, normalizeRegion } from './regions.mjs';

export const MANIFEST_VERSION = 1;
// Reject a refresh that returns less than this fraction of the previous record count.
const MIN_RETAINED_FRACTION = 0.5;
const DEFAULT_OUT_DIR = fileURLToPath(new URL('../public/data/', import.meta.url));

const compareText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// Encode normalised records as a compact region file:
//   { region, fields, constants, records: [[lng, lat, ...values in `fields` order], ...] }
// Fields with the same value on every record move to `constants`; fields empty on every
// record are dropped; GlobalID is dropped when it is always "<region>:<ConsentID>".
// Records are sorted and written one per line so day-to-day diffs stay readable.
export function encodeRegionData(regionId, records) {
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

    const globalIdDerivable = sorted.every(r => r.fields.GlobalID === `${regionId}:${r.fields.ConsentID}`);
    const fields = [];
    const constants = {};
    for (const key of keys) {
        if (key === 'GlobalID' && globalIdDerivable) continue;
        const firstValue = sorted.length ? (sorted[0].fields[key] ?? '') : '';
        if (sorted.every(r => (r.fields[key] ?? '') === firstValue)) {
            if (firstValue !== '') constants[key] = firstValue;
        } else {
            fields.push(key);
        }
    }

    const header = JSON.stringify({ region: regionId, fields, constants });
    const rows = sorted.map(r => JSON.stringify([r.lng, r.lat, ...fields.map(k => r.fields[k] ?? '')]));
    return `${header.slice(0, -1)},"records":[\n${rows.join(',\n')}\n]}\n`;
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
    download = downloadLayer
} = {}) {
    await mkdir(outDir, { recursive: true });
    const manifestPath = join(outDir, 'manifest.json');
    const entries = new Map((await readManifest(manifestPath)).regions.map(entry => [entry.id, entry]));
    const selected = only ? regions.filter(r => only.includes(r.id)) : regions;
    const results = [];

    for (const region of selected) {
        const started = Date.now();
        const previous = entries.get(region.id);
        const previousCount = previous ? previous.count : null;
        log(`\n=== ${region.id} — ${region.name}`);
        try {
            const geojson = sourceDir
                ? await readJson(join(sourceDir, `${region.id.toLowerCase()}.geojson`))
                : await download(region.url, { log });
            const records = normalizeRegion(region, geojson);
            if (!records.length) throw new Error('No consents with a valid location were returned');
            if (previousCount && !force && records.length < previousCount * MIN_RETAINED_FRACTION) {
                throw new Error(`Only ${records.length} consents vs ${previousCount} last time; `
                    + 'keeping previous data (re-run with --force to accept)');
            }

            const file = `${region.id.toLowerCase()}.json`;
            const text = encodeRegionData(region.id, records);
            await writeFileAtomic(join(outDir, file), text);
            entries.set(region.id, {
                id: region.id,
                name: region.name,
                file,
                count: records.length,
                hash: createHash('sha256').update(text).digest('hex').slice(0, 12),
                fetchedAt: fetchedAt || new Date().toISOString(),
                source: region.url
            });
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

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch(err => {
        console.error(err);
        process.exitCode = 1;
    });
}
