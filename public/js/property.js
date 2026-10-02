// === Property lookups ===
// Parcel, title and address details from Toitū Te Whenua LINZ open data (CC BY 4.0), read from
// public ArcGIS services, plus the geometry helpers the map needs. No DOM here, so it runs
// under Node for the tests.
//
// Owner names are deliberately left out: LINZ publishes them only under the LINZ Licence for
// Personal Data, which rules out unsolicited direct marketing.

const ESRI_NZ = 'https://services.arcgis.com/xdsHIIxuCWByZiCB/arcgis/rest/services';

// Each list is tried in order until one answers.
export const PROPERTY_SERVICES = {
    parcels: [
        `${ESRI_NZ}/LINZ_NZ_Primary_Parcels/FeatureServer/0`,
        'https://maps.mpi.govt.nz/wss/service/arcgis1/guest/TERRESTRIAL/PROD_TERRESTRIAL_Cadastral/MapServer/1'
    ],
    titles: [`${ESRI_NZ}/LINZ_NZ_Property_Titles/FeatureServer/0`],
    addresses: [`${ESRI_NZ}/LINZ_NZ_Addresses_Pilot/FeatureServer/0`]
};

export const PROPERTY_ATTRIBUTION = 'Property data: Toitū Te Whenua LINZ, CC BY 4.0';

const REQUEST_TIMEOUT_MS = 15000;

// --- ArcGIS REST ---
export function queryUrl(layerUrl, params) {
    const search = new URLSearchParams({ ...params, f: 'json' });
    return `${layerUrl.replace(/\/+$/, '')}/query?${search}`;
}

export function pointQueryParams(lng, lat, extra = {}) {
    return {
        geometry: JSON.stringify({ x: lng, y: lat, spatialReference: { wkid: 4326 } }),
        geometryType: 'esriGeometryPoint',
        inSR: '4326',
        spatialRel: 'esriSpatialRelIntersects',
        outFields: '*',
        returnGeometry: 'true',
        outSR: '4326',
        ...extra
    };
}

export function envelopeQueryParams({ west, south, east, north }, extra = {}) {
    return {
        geometry: JSON.stringify({ xmin: west, ymin: south, xmax: east, ymax: north, spatialReference: { wkid: 4326 } }),
        geometryType: 'esriGeometryEnvelope',
        inSR: '4326',
        spatialRel: 'esriSpatialRelIntersects',
        returnGeometry: 'true',
        outSR: '4326',
        ...extra
    };
}

function timeoutSignal(signal, ms) {
    if (typeof AbortSignal === 'undefined' || !AbortSignal.timeout) return signal;
    const timeout = AbortSignal.timeout(ms);
    if (!signal) return timeout;
    return AbortSignal.any ? AbortSignal.any([signal, timeout]) : signal;
}

// GET an ArcGIS query and return its features. ArcGIS reports errors as HTTP 200 with an
// { error } body, so those throw too.
export async function arcgisQuery(url, { fetch = globalThis.fetch, signal } = {}) {
    const res = await fetch(url, { signal: timeoutSignal(signal, REQUEST_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    if (body && body.error) throw new Error(body.error.message || `ArcGIS error ${body.error.code}`);
    return Array.isArray(body.features) ? body.features : [];
}

// Try each service in turn; returns { features, source }.
export async function queryFirstAvailable(layerUrls, params, options = {}) {
    let lastError = new Error('No service configured');
    for (const layerUrl of layerUrls) {
        if (options.signal && options.signal.aborted) throw options.signal.reason || new Error('Aborted');
        try {
            return { features: await arcgisQuery(queryUrl(layerUrl, params), options), source: layerUrl };
        } catch (err) {
            if (err && err.name === 'AbortError' && options.signal && options.signal.aborted) throw err;
            lastError = err;
        }
    }
    throw lastError;
}

// --- Geometry ---
// Signed area of a ring in degrees² (positive when counter-clockwise).
export function ringSignedArea(ring) {
    let sum = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        sum += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
    }
    return sum / 2;
}

export function pointInRing(x, y, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i];
        const [xj, yj] = ring[j];
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
}

// Esri polygons are a flat list of rings: clockwise outer rings, counter-clockwise holes.
// Returns GeoJSON (Polygon or MultiPolygon), or null.
export function esriPolygonToGeoJSON(geometry) {
    const rings = geometry && Array.isArray(geometry.rings) ? geometry.rings.filter(r => r.length >= 4) : [];
    if (!rings.length) return null;
    const outers = [];
    const holes = [];
    for (const ring of rings) (ringSignedArea(ring) < 0 ? outers : holes).push(ring);
    // Some services don't follow the winding rule; then treat every ring as an outer ring.
    if (!outers.length) return rings.length === 1 ? { type: 'Polygon', coordinates: [rings[0]] }
        : { type: 'MultiPolygon', coordinates: rings.map(r => [r]) };
    const polygons = outers.map(outer => [outer]);
    for (const hole of holes) {
        const [x, y] = hole[0];
        const owner = polygons.find(poly => pointInRing(x, y, poly[0])) || polygons[0];
        owner.push(hole);
    }
    return polygons.length === 1 ? { type: 'Polygon', coordinates: polygons[0] } : { type: 'MultiPolygon', coordinates: polygons };
}

function polygonsOf(geojson) {
    if (!geojson) return [];
    return geojson.type === 'Polygon' ? [geojson.coordinates] : geojson.type === 'MultiPolygon' ? geojson.coordinates : [];
}

export function pointInGeometry(lng, lat, geojson) {
    return polygonsOf(geojson).some(([outer, ...holes]) =>
        pointInRing(lng, lat, outer) && !holes.some(hole => pointInRing(lng, lat, hole)));
}

export function geometryBounds(geojson) {
    let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
    for (const polygon of polygonsOf(geojson)) {
        for (const [x, y] of polygon[0]) {
            if (x < west) west = x;
            if (x > east) east = x;
            if (y < south) south = y;
            if (y > north) north = y;
        }
    }
    return west === Infinity ? null : { west, south, east, north };
}

// Approximate area in m² (good to a fraction of a percent at parcel scale).
export function approximateAreaM2(geojson) {
    const bounds = geometryBounds(geojson);
    if (!bounds) return 0;
    const metresPerDegree = 111320;
    const scale = metresPerDegree * metresPerDegree * Math.cos(((bounds.south + bounds.north) / 2) * Math.PI / 180);
    let area = 0;
    for (const [outer, ...holes] of polygonsOf(geojson)) {
        area += Math.abs(ringSignedArea(outer));
        for (const hole of holes) area -= Math.abs(ringSignedArea(hole));
    }
    return area * scale;
}

// --- Attributes ---
// Field names vary in case between services, so look them up case-insensitively.
export function attr(attributes, ...names) {
    if (!attributes) return null;
    const keys = Object.keys(attributes);
    for (const name of names) {
        const key = keys.find(k => k.toLowerCase() === name.toLowerCase());
        if (key && attributes[key] != null && attributes[key] !== '') return attributes[key];
    }
    return null;
}

export function splitTitles(value) {
    if (!value) return [];
    return [...new Set(String(value).split(/[,;]/).map(t => t.trim()).filter(Boolean))];
}

const NZ_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Auckland', year: 'numeric', month: '2-digit', day: '2-digit' });

// ArcGIS dates are epoch milliseconds; read them as the New Zealand calendar date, which is
// right whether the service stored UTC midnight or NZ midnight.
function toIsoDay(value) {
    if (value == null || value === '') return '';
    if (typeof value === 'number') return Number.isFinite(value) ? NZ_DATE.format(new Date(value)) : '';
    const m = String(value).match(/^(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : '';
}

const toNumber = (value) => (value == null || value === '' || Number.isNaN(Number(value)) ? null : Number(value));

export function normaliseParcel(feature) {
    const a = feature.attributes || {};
    const geometry = esriPolygonToGeoJSON(feature.geometry);
    const surveyArea = toNumber(attr(a, 'survey_area'));
    const calcArea = toNumber(attr(a, 'calc_area', 'shape_area', 'shape__area'));
    return {
        id: attr(a, 'id', 'parcel_id'),
        appellation: attr(a, 'appellation', 'legal_description') || '',
        intent: attr(a, 'parcel_intent', 'intent') || '',
        landDistrict: attr(a, 'land_district') || '',
        titles: splitTitles(attr(a, 'titles', 'title_no')),
        statutoryActions: attr(a, 'statutory_actions') || '',
        surveys: attr(a, 'affected_surveys') || '',
        area: surveyArea || calcArea || (geometry ? Math.round(approximateAreaM2(geometry)) : null),
        areaSource: surveyArea ? 'survey' : (calcArea ? 'calculated' : 'estimated'),
        geometry
    };
}

export function normaliseTitle(feature) {
    const a = feature.attributes || {};
    return {
        titleNo: attr(a, 'title_no') || '',
        status: attr(a, 'status') || '',
        type: attr(a, 'type') || '',
        landDistrict: attr(a, 'land_district') || '',
        issued: toIsoDay(attr(a, 'issue_date')),
        estate: attr(a, 'estate_description') || '',
        owners: toNumber(attr(a, 'number_owners'))
    };
}

export function normaliseAddress(feature) {
    const a = feature.attributes || {};
    const g = feature.geometry || {};
    return {
        text: attr(a, 'full_address', 'address', 'full_address_ascii') || '',
        lng: toNumber(g.x),
        lat: toNumber(g.y)
    };
}

// --- Lookups ---
// Everything known about the land parcel at a point:
//   { parcel, otherParcels, titles, addresses, problems }
// parcel is null when no parcel covers the point (e.g. out at sea). Titles and addresses are
// best-effort: if their services fail the parcel is still returned, with a note in `problems`.
export async function lookupProperty(lng, lat, { fetch, signal, services = PROPERTY_SERVICES } = {}) {
    const options = { fetch, signal };
    const { features } = await queryFirstAvailable(services.parcels, pointQueryParams(lng, lat), options);
    const parcels = features.map(normaliseParcel).filter(p => p.geometry);
    if (!parcels.length) return { parcel: null, otherParcels: [], titles: [], addresses: [], problems: [] };
    // Where parcels overlap (e.g. a road over a hydro parcel), the smallest is the most specific.
    parcels.sort((a, b) => (a.area || Infinity) - (b.area || Infinity));
    const [parcel, ...otherParcels] = parcels;
    const problems = [];

    const titlesTask = parcel.titles.length
        ? queryFirstAvailable(services.titles, {
            where: `title_no IN (${parcel.titles.slice(0, 50).map(t => `'${t.replace(/'/g, "''")}'`).join(',')})`,
            outFields: '*',
            returnGeometry: 'false'
        }, options).then(r => r.features.map(normaliseTitle))
        : Promise.resolve([]);
    const bounds = geometryBounds(parcel.geometry);
    const addressesTask = queryFirstAvailable(services.addresses, envelopeQueryParams(bounds, {
        outFields: '*', resultRecordCount: '100'
    }), options).then(r => r.features.map(normaliseAddress)
        .filter(a => a.text && a.lng != null && pointInGeometry(a.lng, a.lat, parcel.geometry)));

    const [titles, addresses] = await Promise.all([
        titlesTask.catch(err => { problems.push(`Title details unavailable (${err.message})`); return []; }),
        addressesTask.catch(err => { problems.push(`Addresses unavailable (${err.message})`); return []; })
    ]);
    // Keep the parcel's title order, and list numbers the titles service didn't return.
    const byNumber = new Map(titles.map(t => [t.titleNo, t]));
    const orderedTitles = parcel.titles.map(no => byNumber.get(no) || { titleNo: no });
    const uniqueAddresses = [...new Map(addresses.map(a => [a.text, a])).values()]
        .sort((a, b) => a.text.localeCompare(b.text, 'en', { numeric: true }));
    return { parcel, otherParcels, titles: orderedTitles, addresses: uniqueAddresses, problems };
}

// --- Boundary tiles ---
// Parcel outlines are fetched in fixed web-map tiles so panning reuses earlier requests.
export const BOUNDARY_TILE_ZOOM = 16;

export function lngToTileX(lng, z) {
    return Math.floor(((lng + 180) / 360) * 2 ** z);
}

export function latToTileY(lat, z) {
    const rad = (lat * Math.PI) / 180;
    return Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** z);
}

export function tileEnvelope(x, y, z) {
    const n = 2 ** z;
    const lng = (tx) => (tx / n) * 360 - 180;
    const lat = (ty) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * ty) / n))) * 180) / Math.PI;
    return { west: lng(x), south: lat(y + 1), east: lng(x + 1), north: lat(y) };
}

export function tilesForBounds({ west, south, east, north }, z = BOUNDARY_TILE_ZOOM, maxTiles = 40) {
    const x0 = lngToTileX(west, z), x1 = lngToTileX(east, z);
    const y0 = latToTileY(north, z), y1 = latToTileY(south, z);
    const tiles = [];
    for (let x = x0; x <= x1; x++) {
        for (let y = y0; y <= y1; y++) tiles.push({ x, y, z, key: `${z}/${x}/${y}` });
    }
    // Nearest the centre first, so a capped list still covers the middle of the view.
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    tiles.sort((a, b) => Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy));
    return tiles.slice(0, maxTiles);
}

// Parcel outlines intersecting one tile, as GeoJSON geometries.
export async function fetchBoundaryTile(tile, { fetch, signal, services = PROPERTY_SERVICES } = {}) {
    const { features } = await queryFirstAvailable(services.parcels, envelopeQueryParams(tileEnvelope(tile.x, tile.y, tile.z), {
        geometryPrecision: '6',
        maxAllowableOffset: '0.000005',
        resultRecordCount: '2000'
    }), { fetch, signal });
    return features.map(f => esriPolygonToGeoJSON(f.geometry)).filter(Boolean);
}

// --- Formatting ---
export function formatArea(m2) {
    if (m2 == null || !Number.isFinite(m2)) return '';
    if (m2 >= 10000) {
        const ha = m2 / 10000;
        return `${ha.toLocaleString('en-NZ', { maximumFractionDigits: ha < 100 ? 2 : 0 })} ha`;
    }
    return `${Math.round(m2).toLocaleString('en-NZ')} m²`;
}
