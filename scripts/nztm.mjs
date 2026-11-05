// === NZTM2000 → WGS84 ===
// New Zealand Transverse Mercator (EPSG:2193) eastings/northings to longitude/latitude.
// Some council servers ignore the request for WGS84 coordinates and answer in NZTM metres
// (Gisborne's did in late 2026), so the data refresh converts them.
// This is the inverse Transverse Mercator series LINZ publishes (accurate to well under
// a millimetre within New Zealand). NZGD2000 and WGS84 differ by far less than the
// precision kept in the data files, so no datum shift is needed.

const A = 6378137;                 // GRS80 semi-major axis (m)
const F = 1 / 298.257222101;       // GRS80 flattening
const E2 = 2 * F - F * F;          // eccentricity squared
const CENTRAL_MERIDIAN = 173 * Math.PI / 180;
const SCALE = 0.9996;
const FALSE_EASTING = 1600000;
const FALSE_NORTHING = 10000000;
const DEG = 180 / Math.PI;

// Latitude whose meridian arc length is `m` (the "foot-point" latitude).
function footPointLatitude(m) {
    const n = F / (2 - F), n2 = n * n, n3 = n2 * n, n4 = n2 * n2;
    const g = A * (1 - n) * (1 - n2) * (1 + 9 * n2 / 4 + 225 * n4 / 64);
    const sig = m / g;
    return sig
        + (3 * n / 2 - 27 * n3 / 32) * Math.sin(2 * sig)
        + (21 * n2 / 16 - 55 * n4 / 32) * Math.sin(4 * sig)
        + (151 * n3 / 96) * Math.sin(6 * sig)
        + (1097 * n4 / 512) * Math.sin(8 * sig);
}

// Returns [longitude, latitude] in degrees.
export function nztmToWgs84(easting, northing) {
    const phi = footPointLatitude((northing - FALSE_NORTHING) / SCALE);
    const sinPhi = Math.sin(phi), cosPhi = Math.cos(phi);
    const w = 1 - E2 * sinPhi * sinPhi;
    const eta = A / Math.sqrt(w);         // radius of curvature in the prime vertical
    const rho = eta * (1 - E2) / w;       // radius of curvature in the meridian
    const psi = eta / rho;
    const e = easting - FALSE_EASTING;
    const x = e / (eta * SCALE);
    const x2 = x * x;
    const t = sinPhi / cosPhi, t2 = t * t, t4 = t2 * t2;

    let trm1 = 1 / 2;
    let trm2 = ((-4 * psi + 9 * (1 - t2)) * psi + 12 * t2) / 24;
    let trm3 = ((((8 * (11 - 24 * t2) * psi - 12 * (21 - 71 * t2)) * psi
        + 15 * ((15 * t2 - 98) * t2 + 15)) * psi + 180 * ((-3 * t2 + 5) * t2)) * psi + 360 * t4) / 720;
    let trm4 = (((1575 * t2 + 4095) * t2 + 3633) * t2 + 1385) / 40320;
    const lat = phi + (t * x * e / (SCALE * rho)) * (((trm4 * x2 - trm3) * x2 + trm2) * x2 - trm1);

    trm1 = 1;
    trm2 = (psi + 2 * t2) / 6;
    trm3 = (((-4 * (1 - 6 * t2) * psi + (9 - 68 * t2)) * psi + 72 * t2) * psi + 24 * t4) / 120;
    trm4 = (((720 * t2 + 1320) * t2 + 662) * t2 + 61) / 5040;
    const lng = CENTRAL_MERIDIAN - (x / cosPhi) * (((trm4 * x2 - trm3) * x2 + trm2) * x2 - trm1);

    return [lng * DEG, lat * DEG];
}

// True for a coordinate pair that can only be NZTM metres around New Zealand.
export function looksLikeNztm(x, y) {
    return Number.isFinite(x) && Number.isFinite(y)
        && x >= 900000 && x <= 2300000 && y >= 4500000 && y <= 6400000;
}
