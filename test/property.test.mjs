import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    approximateAreaM2, attr, esriPolygonToGeoJSON, fetchBoundaryTile, formatArea, geometryBounds,
    latToTileY, lngToTileX, lookupProperty, pointInGeometry, queryUrl, ringSignedArea, splitTitles,
    tileEnvelope, tilesForBounds
} from '../public/js/property.js';

// Squares as Esri rings: clockwise outer ring, counter-clockwise hole.
const cw = (x0, y0, x1, y1) => [[x0, y0], [x0, y1], [x1, y1], [x1, y0], [x0, y0]];
const ccw = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];

const SERVICES = {
    parcels: ['https://primary.test/parcels/FeatureServer/0', 'https://fallback.test/parcels/MapServer/1'],
    titles: ['https://titles.test/FeatureServer/0'],
    addresses: ['https://addresses.test/FeatureServer/0']
};

// A fetch stand-in: `routes` maps a URL prefix to a handler returning a body (or throwing).
function fakeFetch(routes) {
    const calls = [];
    const fetch = async (url) => {
        calls.push(url);
        const prefix = Object.keys(routes).find(p => url.startsWith(p));
        if (!prefix) return { ok: false, status: 404, json: async () => ({}) };
        const body = await routes[prefix](new URL(url));
        return { ok: true, status: 200, json: async () => body };
    };
    return { fetch, calls };
}

const PARCEL = {
    attributes: { id: 3954221, appellation: 'Lot 2 DP 12345', parcel_intent: 'Fee Simple Title', land_district: 'South Auckland', titles: 'SA12B/345, SA12B/346', survey_area: 1012, calc_area: 1011.6 },
    geometry: { rings: [cw(176.10, -37.70, 176.11, -37.69)] }
};
const BIG_PARCEL = {
    attributes: { ID: 1, APPELLATION: 'Section 5 Block II', CALC_AREA: 250000 },
    geometry: { rings: [cw(176.0, -37.8, 176.2, -37.6)] }
};

describe('geometry', () => {
    it('knows ring orientation', () => {
        assert.ok(ringSignedArea(ccw(0, 0, 1, 1)) > 0);
        assert.ok(ringSignedArea(cw(0, 0, 1, 1)) < 0);
    });

    it('converts Esri rings with holes and multiple parts to GeoJSON', () => {
        const single = esriPolygonToGeoJSON({ rings: [cw(0, 0, 10, 10), ccw(4, 4, 6, 6)] });
        assert.equal(single.type, 'Polygon');
        assert.equal(single.coordinates.length, 2);
        assert.equal(pointInGeometry(1, 1, single), true);
        assert.equal(pointInGeometry(5, 5, single), false); // in the hole
        assert.equal(pointInGeometry(11, 5, single), false);

        const multi = esriPolygonToGeoJSON({ rings: [cw(0, 0, 1, 1), cw(5, 5, 6, 6)] });
        assert.equal(multi.type, 'MultiPolygon');
        assert.equal(pointInGeometry(5.5, 5.5, multi), true);
        assert.equal(esriPolygonToGeoJSON({ rings: [] }), null);
        assert.equal(esriPolygonToGeoJSON(null), null);
    });

    it('measures bounds and approximate area', () => {
        const square = esriPolygonToGeoJSON({ rings: [cw(176.10, -37.70, 176.11, -37.69)] });
        assert.deepEqual(geometryBounds(square), { west: 176.10, south: -37.70, east: 176.11, north: -37.69 });
        const area = approximateAreaM2(square); // ~1.11 km × 0.88 km
        assert.ok(area > 970000 && area < 990000, String(area));
    });
});

describe('attributes', () => {
    it('reads fields case-insensitively and skips empty values', () => {
        assert.equal(attr({ APPELLATION: 'Lot 1' }, 'appellation'), 'Lot 1');
        assert.equal(attr({ a: '', b: 'x' }, 'a', 'b'), 'x');
        assert.equal(attr(null, 'a'), null);
    });

    it('splits title lists', () => {
        assert.deepEqual(splitTitles('SA12B/345, SA12B/346;SA12B/345'), ['SA12B/345', 'SA12B/346']);
        assert.deepEqual(splitTitles(null), []);
    });

    it('formats areas', () => {
        assert.equal(formatArea(1011.6), '1,012 m²');
        assert.equal(formatArea(25000), '2.5 ha');
        assert.equal(formatArea(2500000), '250 ha');
        assert.equal(formatArea(null), '');
    });
});

describe('lookupProperty', () => {
    it('returns the parcel, its titles and the addresses inside it', async () => {
        const { fetch, calls } = fakeFetch({
            'https://primary.test/': () => ({ features: [BIG_PARCEL, PARCEL] }),
            'https://titles.test/': (url) => {
                assert.match(url.searchParams.get('where'), /title_no IN \('SA12B\/345','SA12B\/346'\)/);
                return { features: [{ attributes: { title_no: 'SA12B/345', type: 'Freehold', estate_description: 'Fee Simple, 1/1, Lot 2 Deposited Plan 12345, 1,012 m2', issue_date: 891345600000, number_owners: 2 } }] };
            },
            'https://addresses.test/': () => ({
                features: [
                    { attributes: { full_address: '12 Example Street, Tauranga' }, geometry: { x: 176.105, y: -37.695 } },
                    { attributes: { full_address: '14 Example Street, Tauranga' }, geometry: { x: 176.2, y: -37.5 } } // outside the parcel
                ]
            })
        });
        const result = await lookupProperty(176.105, -37.695, { fetch, services: SERVICES });
        assert.equal(result.parcel.appellation, 'Lot 2 DP 12345');
        assert.equal(result.parcel.area, 1012);
        assert.equal(result.parcel.areaSource, 'survey');
        assert.equal(result.otherParcels[0].appellation, 'Section 5 Block II');
        assert.deepEqual(result.titles.map(t => [t.titleNo, t.type, t.issued, t.owners]), [
            ['SA12B/345', 'Freehold', '1998-04-01', 2],
            ['SA12B/346', undefined, undefined, undefined]
        ]);
        assert.deepEqual(result.addresses.map(a => a.text), ['12 Example Street, Tauranga']);
        assert.deepEqual(result.problems, []);

        const pointQuery = new URL(calls[0]);
        assert.equal(pointQuery.searchParams.get('geometryType'), 'esriGeometryPoint');
        assert.equal(pointQuery.searchParams.get('outSR'), '4326');
        assert.equal(pointQuery.searchParams.get('f'), 'json');
    });

    it('falls back to the next parcel service and survives title/address failures', async () => {
        const { fetch, calls } = fakeFetch({
            'https://primary.test/': () => ({ error: { code: 500, message: 'Service unavailable' } }),
            'https://fallback.test/': () => ({ features: [PARCEL] }),
            'https://titles.test/': () => { throw new Error('boom'); },
            'https://addresses.test/': () => ({ features: [] })
        });
        const result = await lookupProperty(176.105, -37.695, { fetch, services: SERVICES });
        assert.ok(calls[1].startsWith('https://fallback.test/parcels/MapServer/1/query?'));
        assert.equal(result.parcel.appellation, 'Lot 2 DP 12345');
        assert.deepEqual(result.titles.map(t => t.titleNo), ['SA12B/345', 'SA12B/346']);
        assert.equal(result.problems.length, 1);
        assert.match(result.problems[0], /Title details unavailable/);
    });

    it('returns no parcel where there is none, and throws when every service fails', async () => {
        const empty = fakeFetch({ 'https://primary.test/': () => ({ features: [] }) });
        assert.equal((await lookupProperty(176, -37, { fetch: empty.fetch, services: SERVICES })).parcel, null);
        const down = fakeFetch({});
        await assert.rejects(lookupProperty(176, -37, { fetch: down.fetch, services: SERVICES }), /HTTP 404/);
    });
});

describe('boundary tiles', () => {
    it('converts between coordinates and tiles', () => {
        const x = lngToTileX(176.1, 16), y = latToTileY(-37.7, 16);
        const env = tileEnvelope(x, y, 16);
        assert.ok(env.west <= 176.1 && 176.1 < env.east);
        assert.ok(env.south < -37.7 && -37.7 <= env.north);
    });

    it('lists the tiles covering a view, centre first and capped', () => {
        // About a zoom-17 view: 1.2 km × 0.8 km
        const tiles = tilesForBounds({ west: 176.100, south: -37.704, east: 176.113, north: -37.697 }, 16);
        assert.ok(tiles.length >= 4 && tiles.length <= 12, String(tiles.length));
        assert.equal(new Set(tiles.map(t => t.key)).size, tiles.length);
        assert.equal(tilesForBounds({ west: 170, south: -45, east: 178, north: -35 }, 16, 10).length, 10);
    });

    it('fetches a tile of parcel outlines', async () => {
        const { fetch, calls } = fakeFetch({ 'https://primary.test/': () => ({ features: [PARCEL, { geometry: null }] }) });
        const shapes = await fetchBoundaryTile({ x: 64000, y: 40000, z: 16 }, { fetch, services: SERVICES });
        assert.equal(shapes.length, 1);
        assert.equal(new URL(calls[0]).searchParams.get('geometryType'), 'esriGeometryEnvelope');
    });

    it('builds query URLs', () => {
        assert.equal(queryUrl('https://x.test/FeatureServer/0/', { where: '1=1' }), 'https://x.test/FeatureServer/0/query?where=1%3D1&f=json');
    });
});
