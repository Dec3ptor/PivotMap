import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { looksLikeNztm, nztmToWgs84 } from '../scripts/nztm.mjs';

const close = (actual, expected, tolerance = 1e-6) =>
    assert.ok(Math.abs(actual - expected) < tolerance, `${actual} is not within ${tolerance} of ${expected}`);

describe('nztmToWgs84', () => {
    it("matches LINZ's published test point", () => {
        const [lng, lat] = nztmToWgs84(1576041.150, 6188574.240);
        close(lng, 172.739194);
        close(lat, -34.444066);
    });

    it('puts a Gisborne consent where the council previously published it in WGS84', () => {
        const [lng, lat] = nztmToWgs84(2030138, 5706422);
        close(lng, 177.944306);
        close(lat, -38.686259);
    });

    it('has the central meridian at 173°E', () => {
        assert.equal(nztmToWgs84(1600000, 5430000)[0], 173);
    });
});

describe('looksLikeNztm', () => {
    it('tells NZTM metres from degrees', () => {
        assert.equal(looksLikeNztm(2030138, 5706422), true);
        assert.equal(looksLikeNztm(1325070, 4898548), true);
        assert.equal(looksLikeNztm(177.94, -38.68), false);
        assert.equal(looksLikeNztm(19800000, -4600000), false); // Web Mercator
        assert.equal(looksLikeNztm(NaN, 5706422), false);
    });
});
