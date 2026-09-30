import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { COMMON_FIELDS } from '../scripts/regions.mjs';
import { encodeRegionData, updateData } from '../scripts/update-data.mjs';

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
        } finally {
            await rm(src, { recursive: true, force: true });
        }
    });
});
