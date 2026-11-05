import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { expandRegionData } from '../public/js/consents.js';
import { COMMON_FIELDS } from '../scripts/regions.mjs';
import { encodeRegionData, fetchRegion, updateData } from '../scripts/update-data.mjs';

// Decodes a region file the same way public/app.js does.
function decode(data) {
    return data.records.map(row => {
        const p = Object.fromEntries(COMMON_FIELDS.map(f => [f, '']));
        Object.assign(p, data.constants);
        data.fields.forEach((field, i) => { p[field] = row[i + 2]; });
        if (!p.GlobalID) p.GlobalID = `${data.region}:${p.ConsentID}`;
        return { lng: row[0], lat: row[1], p };
    });
}

const record = (lng, lat, fields) => ({ lng, lat, fields });

describe('encodeRegionData', () => {
    const records = [
        record(175.2, -38.2, { ConsentID: 'B', Status: 'Expired', Purpose: 'Irrigation', LocalAuthority: 'Test Council', GlobalID: 'X:B', Extra: true }),
        record(175.1, -38.1, { ConsentID: 'A', Status: 'Current', Purpose: '', LocalAuthority: 'Test Council', GlobalID: 'X:A', Extra: true })
    ];
    const data = JSON.parse(encodeRegionData('X', records));

    it('stores varying fields as columns and shared values as constants', () => {
        assert.equal(data.region, 'X');
        assert.deepEqual(data.fields, ['ConsentID', 'Status', 'Purpose']);
        assert.deepEqual(data.constants, { LocalAuthority: 'Test Council', Extra: true });
    });

    it('sorts records and round-trips through the app decoder', () => {
        const decoded = decode(data);
        assert.deepEqual(decoded.map(r => [r.lng, r.lat, r.p.ConsentID, r.p.GlobalID]), [
            [175.1, -38.1, 'A', 'X:A'],
            [175.2, -38.2, 'B', 'X:B']
        ]);
        assert.equal(decoded[1].p.Purpose, 'Irrigation');
        assert.equal(decoded[1].p.Extra, true);
        assert.equal(decoded[1].p.ExpiryDate, '');
    });

    it('keeps GlobalID when it cannot be derived from the consent ID', () => {
        const withGuid = JSON.parse(encodeRegionData('X', [
            record(1, 1, { ConsentID: 'A', GlobalID: '{GUID-1}' }),
            record(2, 2, { ConsentID: 'B', GlobalID: 'X:B' })
        ]));
        assert.ok(withGuid.fields.includes('GlobalID'));
        assert.deepEqual(decode(withGuid).map(r => r.p.GlobalID), ['{GUID-1}', 'X:B']);
    });

    it('writes one record per line', () => {
        const text = encodeRegionData('X', records);
        assert.equal(text.split('\n').length, 5); // header, 2 records, closing bracket, trailing newline
    });

    it('stores only the GlobalIDs that differ from "<region>:<ConsentID>"', () => {
        const data = JSON.parse(encodeRegionData('X', [
            record(1, 1, { ConsentID: 'A', GlobalID: 'X:A' }),
            record(2, 2, { ConsentID: 'A', GlobalID: 'X:A#2' })
        ]));
        assert.ok(data.fields.includes('GlobalID'));
        assert.deepEqual(data.records.map(row => row[2 + data.fields.indexOf('GlobalID')]), ['', 'X:A#2']);
        assert.deepEqual(expandRegionData(data).map(p => p.GlobalID), ['X:A', 'X:A#2']);
    });

    it('leaves out links that follow the region\'s pattern, for the app to rebuild', () => {
        const links = { PublicDocumentsLink: 'https://council.test/consents?id={ProjectNumber}' };
        const linked = [
            record(1, 1, { ConsentID: 'A', ProjectNumber: '7/00/0003', PublicDocumentsLink: 'https://council.test/consents?id=7/00/0003' }),
            record(2, 2, { ConsentID: 'B', ProjectNumber: 'U1 2', PublicDocumentsLink: 'https://council.test/consents?id=U1%202' })
        ];
        const text = encodeRegionData('X', linked, { links });
        assert.ok(!text.includes('council.test/consents?id=7'), 'link values are left out');
        const data = JSON.parse(text);
        assert.deepEqual(data.links, links);
        assert.deepEqual(expandRegionData(data).map(p => p.PublicDocumentsLink), linked.map(r => r.fields.PublicDocumentsLink));

        // One link that doesn't follow the pattern: every link is stored as it is
        const odd = [...linked, record(3, 3, { ConsentID: 'C', ProjectNumber: 'C1', PublicDocumentsLink: 'https://elsewhere.test/C1' })];
        const plain = JSON.parse(encodeRegionData('X', odd, { links }));
        assert.equal(plain.links, undefined);
        assert.deepEqual(expandRegionData(plain).map(p => p.PublicDocumentsLink), odd.map(r => r.fields.PublicDocumentsLink));
    });
});

describe('fetchRegion', () => {
    const fc = (...features) => ({ type: 'FeatureCollection', features });
    const feature = (properties) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [175, -38] }, properties });
    const quiet = () => {};

    it('adds extra layers and joins a details layer', async () => {
        const calls = [];
        const region = {
            url: 'https://x.test/MapServer/1',
            layers: ['https://x.test/MapServer/2'],
            details: { url: 'https://x.test/MapServer/0', key: 'No', fields: ['Kind'], as: 'Activities' },
            pageSize: 3000
        };
        const { geojson, copy, sourceDate } = await fetchRegion(region, {
            log: quiet,
            download: async (url, options) => {
                calls.push([url, options.pageSize, options.outFields, options.returnGeometry]);
                if (url.endsWith('/1')) return fc(feature({ No: 'A' }));
                if (url.endsWith('/2')) return fc(feature({ No: 'B' }));
                return fc({ properties: { No: 'A', Kind: 'Take' } }, { properties: { No: 'A', Kind: 'Use' } }, { properties: { No: null, Kind: 'x' } });
            }
        });
        assert.deepEqual(calls, [
            ['https://x.test/MapServer/1', 3000, undefined, undefined],
            ['https://x.test/MapServer/2', 3000, undefined, undefined],
            ['https://x.test/MapServer/0', 3000, 'No,Kind', false]
        ]);
        assert.deepEqual(geojson.features.map(f => [f.properties.No, f.properties.Activities]), [
            ['A', [{ Kind: 'Take' }, { Kind: 'Use' }]],
            ['B', []]
        ]);
        assert.equal(copy, null);
        assert.equal(sourceDate, null);
    });

    it("falls back to the region's ArcGIS Hub copy when the council's server fails", async () => {
        const region = { url: 'https://down.test/MapServer/1', fallback: { hubItemId: 'a'.repeat(32), layer: 1 } };
        const hubCalls = [];
        const tries = [];
        const result = await fetchRegion(region, {
            log: quiet,
            download: async (url, options) => { tries.push([options.retries, options.timeoutMs]); throw new Error('fetch failed'); },
            downloadHub: async (item) => {
                hubCalls.push(item);
                return { geojson: fc(feature({ id: 1 })), source: 'https://hub.test/data', sourceDate: '2026-10-27T01:50:33.000Z' };
            }
        });
        assert.deepEqual(tries, [[2, 60000]]); // little time spent on a server that may be unreachable
        assert.deepEqual(hubCalls, [{ itemId: 'a'.repeat(32), layer: 1 }]);
        assert.equal(result.copy, 'https://hub.test/data');
        assert.equal(result.sourceDate, '2026-10-27T01:50:33.000Z');

        await assert.rejects(fetchRegion(region, {
            log: quiet,
            download: async () => { throw new Error('fetch failed'); },
            downloadHub: async () => { throw new Error('HTTP 503'); }
        }), /fetch failed; the ArcGIS Hub copy failed too: HTTP 503/);
        await assert.rejects(fetchRegion({ url: region.url }, { log: quiet, download: async () => { throw new Error('nope'); } }), /^Error: nope$/);
    });
});

describe('updateData', () => {
    let dir;
    const regions = [
        { id: 'AAA', name: 'Alpha Council', url: 'https://example.test/alpha/MapServer/0', normalize: (p) => ({ ConsentID: p.id, Status: 'Current' }) },
        { id: 'BBB', name: 'Beta Council', url: 'https://example.test/beta/FeatureServer/0', normalize: (p) => ({ ConsentID: p.id, Status: 'Current' }) }
    ];
    const collection = (n) => ({
        type: 'FeatureCollection',
        features: Array.from({ length: n }, (_, i) => ({
            type: 'Feature', geometry: { type: 'Point', coordinates: [175, -38 - i / 100] }, properties: { id: `C${i}` }
        }))
    });
    const quiet = () => {};
    const readManifest = async () => JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));

    before(async () => { dir = await mkdtemp(join(tmpdir(), 'pivotmap-data-')); });
    after(async () => { await rm(dir, { recursive: true, force: true }); });

    it('writes a data file per region and a manifest', async () => {
        const results = await updateData({
            regions, outDir: dir, log: quiet, fetchedAt: '2026-01-01T00:00:00.000Z',
            download: async (url) => collection(url.includes('alpha') ? 10 : 4)
        });
        assert.deepEqual(results.map(r => [r.id, r.ok, r.count]), [['AAA', true, 10], ['BBB', true, 4]]);
        const manifest = await readManifest();
        assert.equal(manifest.version, 1);
        assert.deepEqual(manifest.regions.map(r => [r.id, r.name, r.file, r.count, r.fetchedAt, r.source]), [
            ['AAA', 'Alpha Council', 'aaa.json', 10, '2026-01-01T00:00:00.000Z', 'https://example.test/alpha/MapServer/0'],
            ['BBB', 'Beta Council', 'bbb.json', 4, '2026-01-01T00:00:00.000Z', 'https://example.test/beta/FeatureServer/0']
        ]);
        assert.match(manifest.regions[0].hash, /^[0-9a-f]{12}$/);
        const alpha = JSON.parse(await readFile(join(dir, 'aaa.json'), 'utf8'));
        assert.equal(alpha.records.length, 10);
    });

    it('keeps the previous data when a region fails to download', async () => {
        const before = await readFile(join(dir, 'bbb.json'), 'utf8');
        const results = await updateData({
            regions, outDir: dir, log: quiet,
            download: async (url) => {
                if (url.includes('beta')) throw new Error('connect ETIMEDOUT');
                return collection(11);
            }
        });
        assert.deepEqual(results.map(r => [r.id, r.ok]), [['AAA', true], ['BBB', false]]);
        assert.match(results[1].error, /ETIMEDOUT/);
        assert.equal(await readFile(join(dir, 'bbb.json'), 'utf8'), before);
        const [alpha, beta] = (await readManifest()).regions;
        assert.deepEqual([alpha.id, alpha.count, beta.id, beta.count], ['AAA', 11, 'BBB', 4]);
        assert.notEqual(alpha.fetchedAt, '2026-01-01T00:00:00.000Z'); // refreshed now
        assert.equal(beta.fetchedAt, '2026-01-01T00:00:00.000Z');     // still the last good download
    });

    it('rejects a refresh that shrinks by more than half unless forced', async () => {
        const shrunk = await updateData({ regions, only: ['AAA'], outDir: dir, log: quiet, download: async () => collection(3) });
        assert.equal(shrunk[0].ok, false);
        assert.match(shrunk[0].error, /Only 3 consents vs 11 last time/);
        assert.equal((await readManifest()).regions[0].count, 11);

        const forced = await updateData({ regions, only: ['AAA'], outDir: dir, log: quiet, force: true, download: async () => collection(3) });
        assert.equal(forced[0].ok, true);
        assert.equal((await readManifest()).regions[0].count, 3);
    });

    it('refreshes only the requested regions and leaves the rest untouched', async () => {
        const manifestBefore = await readManifest();
        const results = await updateData({ regions, only: ['BBB'], outDir: dir, log: quiet, download: async () => collection(5) });
        assert.deepEqual(results.map(r => r.id), ['BBB']);
        const manifest = await readManifest();
        assert.deepEqual(manifest.regions[0], manifestBefore.regions[0]);
        assert.equal(manifest.regions[1].count, 5);
    });

    it('treats a collection with no usable points as a failure', async () => {
        const results = await updateData({ regions, only: ['BBB'], outDir: dir, log: quiet, download: async () => ({ features: [] }) });
        assert.equal(results[0].ok, false);
        assert.match(results[0].error, /No consents with a valid location/);
    });

    it('leaves out consents that ended over ten years ago and records the download size', async () => {
        const dated = {
            id: 'CCC', name: 'Gamma Council', url: 'https://example.test/gamma/MapServer/0',
            normalize: (p) => ({ ConsentID: p.id, Status: p.status, ExpiryDate: p.expiry })
        };
        const results = await updateData({
            regions: [dated], outDir: dir, log: quiet, fetchedAt: '2026-11-05T00:00:00.000Z',
            download: async () => ({ type: 'FeatureCollection', features: [
                ['A', 'Current', '2001-01-01'], ['B', 'Expired', '2017-01-01'], ['C', 'Expired', '2015-01-01'], ['C', 'Expired', '2015-01-01']
            ].map(([id, status, expiry], i) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [175, -38 - i / 100] }, properties: { id, status, expiry } })) })
        });
        assert.equal(results[0].count, 2);
        const entry = (await readManifest()).regions.find(r => r.id === 'CCC');
        assert.equal(entry.count, 2);
        assert.equal(entry.downloaded, 4);
        assert.equal(entry.sourceDate, undefined);
    });

    it('compares download sizes, not kept consents, when checking for a partial download', async () => {
        const out = await mkdtemp(join(tmpdir(), 'pivotmap-shrink-'));
        try {
            const def = [{ id: 'CCC', name: 'Gamma Council', url: 'https://example.test/gamma/MapServer/0',
                normalize: (p) => ({ ConsentID: p.id, Status: p.status, ExpiryDate: '1990-01-01' }) }];
            const rows = (n, current) => ({ features: Array.from({ length: n }, (_, i) => ({
                type: 'Feature', geometry: { type: 'Point', coordinates: [175, -38 - i / 100] },
                properties: { id: `C${i}`, status: i < current ? 'Current' : 'Expired' } })) });
            const run = (data) => updateData({ regions: def, outDir: out, log: quiet, download: async () => data });

            assert.equal((await run(rows(10, 10)))[0].count, 10);
            // Same download, most of it long ended: far fewer consents kept, but nothing is missing
            assert.equal((await run(rows(10, 2)))[0].count, 2);
            // Less than half the rows of last time: a partial download
            assert.match((await run(rows(4, 4)))[0].error, /Only 4 consents vs 10 last time/);
            // Nothing current or recent left: keep the previous data
            assert.match((await run(rows(10, 0)))[0].error, /None of the consents is current or ended in the last 10 years/);
        } finally {
            await rm(out, { recursive: true, force: true });
        }
    });

    it('records when a fallback copy was last refreshed', async () => {
        const hubbed = [{ id: 'DDD', name: 'Delta Council', url: 'https://down.test/MapServer/1', fallback: { hubItemId: 'b'.repeat(32), layer: 0 },
            normalize: (p) => ({ ConsentID: p.id, Status: 'Current' }) }];
        const results = await updateData({
            regions: hubbed, outDir: dir, log: quiet,
            download: async () => { throw new Error('connection reset'); },
            downloadHub: async () => ({ geojson: collection(2), source: 'https://hub.test/data', sourceDate: '2026-10-27T01:50:33.000Z' })
        });
        assert.equal(results[0].ok, true);
        const entry = (await readManifest()).regions.find(r => r.id === 'DDD');
        assert.equal(entry.source, 'https://down.test/MapServer/1'); // the council's own service, for people to follow
        assert.equal(entry.copy, 'https://hub.test/data');
        assert.equal(entry.sourceDate, '2026-10-27T01:50:33.000Z');
    });

    it('reads local GeoJSON files with sourceDir', async () => {
        const src = await mkdtemp(join(tmpdir(), 'pivotmap-src-'));
        try {
            await writeFile(join(src, 'aaa.geojson'), JSON.stringify(collection(6)));
            const results = await updateData({
                regions, only: ['AAA'], outDir: dir, sourceDir: src, log: quiet,
                download: async () => { throw new Error('should not download'); }
            });
            assert.equal(results[0].ok, true);
            assert.equal(results[0].count, 6);

            // Extra layers come from <region>-2.geojson…, details from <region>-details.geojson
            const layered = [{ ...regions[1], layers: ['https://example.test/beta/FeatureServer/1'],
                details: { url: 'https://example.test/beta/FeatureServer/2', key: 'id', fields: ['kind'], as: 'Kinds' },
                normalize: (p) => ({ ConsentID: p.id, Status: 'Current', Purpose: p.Kinds.map(k => k.kind).join(', ') }) }];
            const second = collection(2);
            second.features.forEach((f, i) => { f.properties.id = `D${i}`; });
            await writeFile(join(src, 'bbb.geojson'), JSON.stringify(collection(1)));
            await writeFile(join(src, 'bbb-2.geojson'), JSON.stringify(second));
            await writeFile(join(src, 'bbb-details.geojson'), JSON.stringify({ features: [{ properties: { id: 'C0', kind: 'Take' } }] }));
            const out = await updateData({ regions: layered, outDir: dir, sourceDir: src, log: quiet, force: true });
            assert.deepEqual(out.map(r => [r.ok, r.count]), [[true, 3]]);
            const data = JSON.parse(await readFile(join(dir, 'bbb.json'), 'utf8'));
            assert.deepEqual(decode(data).map(r => [r.p.ConsentID, r.p.Purpose]), [['C0', 'Take'], ['D0', ''], ['D1', '']]);
        } finally {
            await rm(src, { recursive: true, force: true });
        }
    });
});
