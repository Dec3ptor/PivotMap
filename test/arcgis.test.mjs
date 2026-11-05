import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { downloadHubExport, downloadLayer } from '../scripts/arcgis.mjs';

// A tiny stand-in for an ArcGIS layer's /query endpoint.
// Each layer is served at /<name>/query with its own paging quirks.
function makeFeatures(n) {
    return Array.from({ length: n }, (_, i) => ({
        type: 'Feature', id: i + 1,
        geometry: { type: 'Point', coordinates: [175 + i / 100, -38] },
        properties: { OBJECTID: i + 1 }
    }));
}

const layers = {
    // MapServer: exceededTransferLimit at the root, server caps pages at 3
    mapserver: { features: makeFeatures(7), maxRecordCount: 3, flag: 'root' },
    // FeatureServer: exceededTransferLimit inside `properties`
    featureserver: { features: makeFeatures(5), maxRecordCount: 2, flag: 'properties' },
    // Omits the flag entirely; the client must keep going while pages are full
    noflag: { features: makeFeatures(4), maxRecordCount: 1000, flag: 'none' },
    // First two requests fail with HTTP 500
    flaky: { features: makeFeatures(3), maxRecordCount: 1000, flag: 'root', failFirst: 2 },
    // Reports more records than it actually returns
    truncated: { features: makeFeatures(3), maxRecordCount: 1000, flag: 'root', countOverride: 50 },
    // Ignores resultOffset and always returns the first page
    nooffset: { features: makeFeatures(10), maxRecordCount: 2, flag: 'root', ignoreOffset: true },
    // Always answers with an ArcGIS error body
    broken: { error: { code: 400, message: 'Invalid query parameters.', details: ['bad where'] } },
    // Answers with an HTML error page (e.g. a firewall block)
    html: { html: '<html><body>Access denied</body></html>' }
};

// ArcGIS Hub exports: item id → how the download API answers.
const HUB_ITEMS = {
    ['a'.repeat(32)]: { pending: 2 },                                // ready on the third ask
    ['b'.repeat(32)]: { resultUrl: 'https://elsewhere.test/data' }, // points off-site
    ['c'.repeat(32)]: { status: 'Failed', message: 'Export failed' }
};

function hubAnswer(url, send) {
    const download = /^\/api\/download\/v1\/items\/([0-9a-f]{32})\/geojson$/.exec(url.pathname);
    if (download) {
        const item = HUB_ITEMS[download[1]];
        if (!item) return send(404, { error: { code: 404, message: 'Item not found' } });
        if (item.status) return send(200, { status: item.status, message: item.message });
        if (item.pending) {
            item.pending--;
            return send(200, { status: 'Pending', message: 'Export in progress' });
        }
        return send(200, { status: 'Completed', resultUrl: item.resultUrl || `/api/v3/datasets/${download[1]}_${url.searchParams.get('layers')}/downloads/data?format=geojson` });
    }
    if (url.pathname.endsWith('/downloads/data')) {
        return send(200, { type: 'FeatureCollection', features: makeFeatures(2) }, 'application/json', { 'Last-Modified': 'Tue, 27 Oct 2026 01:50:33 GMT' });
    }
    return send(404, { error: { code: 404, message: 'Not found' } });
}

let server;
let baseUrl;
const requests = [];

before(async () => {
    server = createServer((req, res) => {
        const url = new URL(req.url, 'http://localhost');
        requests.push(url);
        const name = url.pathname.split('/')[1];
        const layer = layers[name];
        const send = (status, body, type = 'application/json', headers = {}) => {
            res.writeHead(status, { 'Content-Type': type, ...headers });
            res.end(typeof body === 'string' ? body : JSON.stringify(body));
        };
        if (name === 'api') return hubAnswer(url, send);
        if (!layer || !url.pathname.endsWith('/query')) return send(404, { error: { code: 404, message: 'Not found' } });
        if (layer.failFirst) {
            layer.failFirst--;
            return send(500, 'Internal error', 'text/plain');
        }
        if (layer.error) return send(200, { error: layer.error });
        if (layer.html) return send(200, layer.html, 'text/html');
        if (url.searchParams.get('returnCountOnly') === 'true') {
            return send(200, { count: layer.countOverride ?? layer.features.length });
        }
        const offset = layer.ignoreOffset ? 0 : Number(url.searchParams.get('resultOffset') || 0);
        const count = Math.min(Number(url.searchParams.get('resultRecordCount') || 1000), layer.maxRecordCount);
        const page = layer.features.slice(offset, offset + count);
        const exceeded = layer.ignoreOffset || offset + page.length < layer.features.length;
        const body = { type: 'FeatureCollection', features: page };
        if (layer.flag === 'root' && exceeded) body.exceededTransferLimit = true;
        if (layer.flag === 'properties') body.properties = { exceededTransferLimit: exceeded };
        return send(200, body);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

const fast = { pauseMs: 0, retryDelayMs: 1 };
const ids = (fc) => fc.features.map(f => f.id);

describe('downloadLayer', () => {
    it('pages through a MapServer layer that caps page size', async () => {
        const fc = await downloadLayer(`${baseUrl}/mapserver/`, { ...fast, pageSize: 2000 });
        assert.equal(fc.type, 'FeatureCollection');
        assert.deepEqual(ids(fc), [1, 2, 3, 4, 5, 6, 7]);
    });

    it('sends the expected query parameters', async () => {
        requests.length = 0;
        await downloadLayer(`${baseUrl}/featureserver`, { ...fast, pageSize: 2 });
        const pageRequests = requests.filter(u => u.searchParams.get('f') === 'geojson');
        assert.deepEqual(pageRequests.map(u => u.searchParams.get('resultOffset')), ['0', '2', '4']);
        for (const u of pageRequests) {
            assert.equal(u.searchParams.get('where'), '1=1');
            assert.equal(u.searchParams.get('outFields'), '*');
            assert.equal(u.searchParams.get('outSR'), '4326');
            assert.equal(u.searchParams.get('resultRecordCount'), '2');
        }
    });

    it('can ask for chosen fields without geometry', async () => {
        requests.length = 0;
        await downloadLayer(`${baseUrl}/featureserver`, { ...fast, pageSize: 2, outFields: 'ConsentNo,ActivityText', returnGeometry: false, where: "Status='Current'" });
        const pageRequests = requests.filter(u => u.searchParams.get('f') === 'geojson');
        assert.ok(pageRequests.length > 0);
        for (const u of pageRequests) {
            assert.equal(u.searchParams.get('outFields'), 'ConsentNo,ActivityText');
            assert.equal(u.searchParams.get('returnGeometry'), 'false');
            assert.equal(u.searchParams.get('where'), "Status='Current'");
        }
        const countRequest = requests.find(u => u.searchParams.get('returnCountOnly') === 'true');
        assert.equal(countRequest.searchParams.get('where'), "Status='Current'");
    });

    it('reads exceededTransferLimit from FeatureServer properties', async () => {
        const fc = await downloadLayer(`${baseUrl}/featureserver`, { ...fast, pageSize: 2 });
        assert.deepEqual(ids(fc), [1, 2, 3, 4, 5]);
    });

    it('keeps paging while pages are full even without the flag', async () => {
        const fc = await downloadLayer(`${baseUrl}/noflag`, { ...fast, pageSize: 2 });
        assert.deepEqual(ids(fc), [1, 2, 3, 4]);
    });

    it('retries transient HTTP errors', async () => {
        const fc = await downloadLayer(`${baseUrl}/flaky`, fast);
        assert.deepEqual(ids(fc), [1, 2, 3]);
    });

    it('fails when fewer features arrive than the server counted', async () => {
        await assert.rejects(downloadLayer(`${baseUrl}/truncated`, fast), /Incomplete download: received 3 of 50/);
    });

    it('fails instead of looping when the server ignores resultOffset', async () => {
        await assert.rejects(downloadLayer(`${baseUrl}/nooffset`, { ...fast, pageSize: 2 }), /Paging stopped advancing/);
    });

    it('surfaces ArcGIS error bodies', async () => {
        await assert.rejects(downloadLayer(`${baseUrl}/broken`, fast), /ArcGIS error 400: Invalid query parameters\. bad where/);
    });

    it('surfaces non-JSON responses', async () => {
        await assert.rejects(downloadLayer(`${baseUrl}/html`, fast), /Expected JSON but received: <html>/);
    });

    it('surfaces unreachable servers', async () => {
        await assert.rejects(downloadLayer('http://127.0.0.1:1/layer', { ...fast, retries: 1 }));
    });
});

describe('downloadHubExport', () => {
    const hub = () => ({ hubUrl: baseUrl, pollMs: 1, retryDelayMs: 1 });

    it('waits for the export, downloads it and reports when Hub last refreshed it', async () => {
        const { geojson, source, sourceDate } = await downloadHubExport({ itemId: 'a'.repeat(32), layer: 1 }, hub());
        assert.equal(geojson.features.length, 2);
        assert.equal(source, `${baseUrl}/api/v3/datasets/${'a'.repeat(32)}_1/downloads/data?format=geojson`);
        assert.equal(sourceDate, '2026-10-27T01:50:33.000Z');
    });

    it('refuses a download location on another site', async () => {
        await assert.rejects(downloadHubExport({ itemId: 'b'.repeat(32) }, hub()), /Unexpected Hub download location/);
    });

    it('surfaces failed exports, unknown items and bad ids', async () => {
        await assert.rejects(downloadHubExport({ itemId: 'c'.repeat(32) }, hub()), /Hub export failed: Export failed/);
        await assert.rejects(downloadHubExport({ itemId: 'd'.repeat(32) }, { ...hub(), retries: 1 }), /HTTP 404/);
        await assert.rejects(downloadHubExport({ itemId: '../../etc' }, hub()), /Invalid Hub item id/);
    });
});
