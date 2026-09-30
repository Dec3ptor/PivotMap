// === ArcGIS REST download ===
// Pages through a MapServer or FeatureServer layer's /query endpoint and returns
// every feature as a single GeoJSON FeatureCollection (WGS84).

const REQUEST_HEADERS = {
    'User-Agent': 'PivotMap-data-refresh (+https://github.com/Dec3ptor/PivotMap)',
    'Accept': 'application/geo+json, application/json;q=0.9, */*;q=0.1'
};

// Safety stop for servers that ignore resultOffset (1000 pages = 2 million features at 2000/page).
const MAX_PAGES = 1000;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// GET a URL and parse it as JSON, retrying transient failures.
// ArcGIS reports query errors as HTTP 200 with an { error } body, so those count as failures too.
export async function fetchJson(url, { retries = 3, retryDelayMs = 3000, timeoutMs = 120000, log = () => {} } = {}) {
    let lastError;
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const res = await fetch(url, { headers: REQUEST_HEADERS, signal: AbortSignal.timeout(timeoutMs) });
            const text = await res.text();
            if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`.trim());
            let body;
            try {
                body = JSON.parse(text);
            } catch {
                throw new Error(`Expected JSON but received: ${text.slice(0, 120).replace(/\s+/g, ' ')}`);
            }
            if (body && body.error) {
                const { code = '', message = 'unknown error', details = [] } = body.error;
                throw new Error(`ArcGIS error ${code}: ${[message, ...details].join(' ')}`.trim());
            }
            return body;
        } catch (err) {
            lastError = err;
            if (attempt < retries) {
                log(`    attempt ${attempt} failed (${err.message}); retrying`);
                await sleep(retryDelayMs * attempt);
            }
        }
    }
    throw lastError;
}

// Download every feature from an ArcGIS layer, e.g.
//   https://host/arcgis/rest/services/Folder/Service/MapServer/0
export async function downloadLayer(layerUrl, { pageSize = 2000, pauseMs = 300, log = () => {}, ...fetchOptions } = {}) {
    const base = layerUrl.replace(/\/+$/, '');
    const requestOptions = { log, ...fetchOptions };

    // Expected total, used to detect a truncated download. Optional: some servers don't support it.
    let expected = null;
    try {
        const countParams = new URLSearchParams({ where: '1=1', returnCountOnly: 'true', f: 'json' });
        const { count } = await fetchJson(`${base}/query?${countParams}`, requestOptions);
        if (Number.isFinite(count)) expected = count;
    } catch (err) {
        log(`  count query failed (${err.message}); continuing without a completeness check`);
    }

    const features = [];
    const seenIds = new Set();
    let offset = 0;
    for (let page = 1; ; page++) {
        const params = new URLSearchParams({
            where: '1=1',
            outFields: '*',
            returnGeometry: 'true',
            outSR: '4326',
            resultOffset: String(offset),
            resultRecordCount: String(pageSize),
            f: 'geojson'
        });
        const data = await fetchJson(`${base}/query?${params}`, requestOptions);
        const batch = Array.isArray(data.features) ? data.features : [];

        let added = 0;
        for (const feature of batch) {
            const id = feature && feature.id;
            if (id !== undefined && id !== null) {
                if (seenIds.has(id)) continue;
                seenIds.add(id);
            }
            features.push(feature);
            added++;
        }
        log(`  page ${page}: ${batch.length} features (offset ${offset})`);

        // FeatureServer reports exceededTransferLimit inside `properties`; MapServer at the root.
        const exceeded = data.exceededTransferLimit === true
            || (data.properties && data.properties.exceededTransferLimit === true);
        // Keep paging while the server says there's more, or while pages come back full
        // (some servers omit the flag).
        if (batch.length === 0 || (!exceeded && batch.length < pageSize)) break;
        if (added === 0 || page >= MAX_PAGES) {
            throw new Error(`Paging stopped advancing at offset ${offset} (server may not support resultOffset)`);
        }
        offset += batch.length;
        if (pauseMs) await sleep(pauseMs);
    }

    if (expected !== null && features.length < expected) {
        const missing = expected - features.length;
        // Allow a little slack for records deleted while the download was running.
        if (missing > Math.max(10, expected * 0.005)) {
            throw new Error(`Incomplete download: received ${features.length} of ${expected} features`);
        }
        log(`  note: received ${features.length} of ${expected} features`);
    }

    return { type: 'FeatureCollection', features };
}
