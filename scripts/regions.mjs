// === Regional consent sources ===
// Where each council publishes its resource consents (an ArcGIS REST layer),
// and how that council's fields map onto the app's common consent schema.
// To add a region: add an entry to REGIONS, then run `npm run update-data`.

// Fields every consent record has once loaded in the app ('' when unknown).
export const COMMON_FIELDS = [
    'ConsentID', 'ProjectNumber', 'Status', 'PrimaryConsentHolder', 'HolderDisplay',
    'PrimaryConsentHolderAddress', 'LocalAuthority', 'SiteAddress', 'Purpose', 'Subtype',
    'Category', 'WaterManagementZone', 'WaterManagementArea', 'ComplianceOfficer',
    'GrantedDate', 'LodgedDate', 'ExpiryDate', 'StatusDate', 'CapID', 'FactorySupplyNumber',
    'PublicDocumentsLink', 'DeemedPermitted', 'GlobalID'
];

// --- Value helpers ---

// First non-empty value, as a string ('' if none). Mirrors the `a || b || ''` chains
// the app originally used, so IDs derived from it stay identical.
function first(...values) {
    for (const v of values) {
        if (v) return String(v);
    }
    return '';
}

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&#039;': "'", '&apos;': "'" };

// Like first(), for descriptive text: decodes HTML entities some councils leave in
// ("R Smith &amp; G Jones") and collapses line breaks and repeated spaces.
export function text(...values) {
    return first(...values)
        .replace(/&(amp|lt|gt|quot|apos|#0?39);/g, m => ENTITIES[m])
        .replace(/\s+/g, ' ')
        .trim();
}

const NZ_DATE_PARTS = new Intl.DateTimeFormat('en-NZ', {
    timeZone: 'Pacific/Auckland', year: 'numeric', month: '2-digit', day: '2-digit'
});

// ArcGIS epoch-milliseconds → 'YYYY-MM-DD', or '' if missing/invalid.
// Uses the New Zealand calendar date: BOPRC stores NZ-local midnight (11:00/12:00 UTC)
// while the other councils store UTC midnight, and both land on the intended NZ date.
export function timestampToIsoDate(value) {
    if (value === null || value === undefined || value === '') return '';
    const ms = typeof value === 'string' && /^-?\d+$/.test(value.trim()) ? Number(value) : value;
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return '';
    const parts = Object.fromEntries(NZ_DATE_PARTS.formatToParts(d).map(p => [p.type, p.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
}

// 'DD/MM/YYYY' (as used by GWRC and some HBDC fields) → 'YYYY-MM-DD', or '' if invalid.
export function ddmmyyyyToIsoDate(value) {
    if (typeof value !== 'string') return '';
    const m = value.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!m) return '';
    const day = Number(m[1]), month = Number(m[2]), year = Number(m[3]);
    const d = new Date(Date.UTC(year, month - 1, day));
    if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return '';
    return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

// Normalise source-specific status words to a single canonical label where appropriate.
// Different councils use different words for the same concepts — map them here once so
// every downstream filter, badge, stat and CSV export sees consistent labels.
export function canonicalizeStatus(raw) {
    const s = String(raw || '').trim();
    switch (s.toLowerCase()) {
        case 'active':   // GWRC, GDC → same concept as BOPRC "Current"
        case 'granted':  // GDC → decision made, consent live
            return 'Current';
        case 'lapsed consent': // GDC full label → match surrendered family
            return 'Lapsed';
        default:
            return s;
    }
}

// --- Regions ---
// normalize(properties, index) returns the record's fields; anything omitted is ''.
// `index` is the feature's position among the region's valid point features, used only
// for fallback IDs when a source record has none.

export const REGIONS = [
    {
        id: 'BOPRC',
        name: 'Bay of Plenty Regional Council',
        url: 'https://gis.boprc.govt.nz/server2/rest/services/BayOfPlentyMaps/ConsentsandCompliance/MapServer/45',
        normalize: (p, index) => ({
            ConsentID: first(p.ConsentID, `BOPRC-${index + 1}`),
            ProjectNumber: first(p.ProjectNumber),
            Status: canonicalizeStatus(p.Status),
            PrimaryConsentHolder: text(p.PrimaryConsentHolder),
            HolderDisplay: text(p.PrimaryConsentHolder),
            PrimaryConsentHolderAddress: text(p.PrimaryConsentHolderAddress),
            LocalAuthority: first(p.LocalAuthority),
            SiteAddress: text(p.SiteAddress),
            Purpose: text(p.Purpose),
            Subtype: first(p.Subtype),
            Category: first(p.Category),
            WaterManagementZone: first(p.WaterManagementZone),
            WaterManagementArea: first(p.WaterManagementArea),
            ComplianceOfficer: first(p.ComplianceOfficer),
            GrantedDate: timestampToIsoDate(p.GrantedDate),
            LodgedDate: timestampToIsoDate(p.LodgedDate),
            ExpiryDate: timestampToIsoDate(p.ExpiryDate),
            StatusDate: timestampToIsoDate(p.StatusDate),
            CapID: first(p.CapID),
            FactorySupplyNumber: first(p.FactorySupplyNumber),
            PublicDocumentsLink: first(p.PublicDocumentsLink),
            DeemedPermitted: first(p.DeemedPermitted),
            GlobalID: first(p.GlobalID, `BOPRC:${first(p.ConsentID, `BOPRC-${index + 1}`)}`)
        })
    },
    {
        id: 'HBDC',
        name: "Hawke's Bay Regional Council",
        url: 'https://gis.hbrc.govt.nz/server/rest/services/ExternalServices/Regulatory/MapServer/1',
        normalize: (p, index) => ({
            ConsentID: first(p.AuthorisationIRISID, p.ApplicationHistoricID, `HBDC-${index + 1}`),
            ProjectNumber: first(p.WorkflowID, p.ApplicationHistoricID),
            Status: canonicalizeStatus(p.AuthorisationCurrentStatus),
            // LocalAuthority is the district the consent is in; Hawke's Bay doesn't publish holders.
            LocalAuthority: first(p.LocalAuthority),
            SiteAddress: text(p.AuthorisationPropertyAddress),
            Purpose: text(p.AuthPrimaryPurpose, p.ActPrimaryPurpose),
            Subtype: first(p.AuthorisationType),
            Category: first(p.AuthPrimaryIndustry, p.ActPrimaryIndustry),
            GrantedDate: timestampToIsoDate(p.DecisionServedDate),
            ExpiryDate: timestampToIsoDate(p.ExpiryDate),
            CapID: first(p.ApplicationHistoricID),
            FactorySupplyNumber: first(p.WellNumber),
            PublicDocumentsLink: first(p.DocumentLink),
            DeemedPermitted: p.AuthorisationType === 'Deemed Permitted Activity' ? 'Yes' : '',
            GlobalID: `HBDC:${first(p.AuthorisationIRISID, p.WorkflowID, p.GisObjectID, p.ESRI_OID, index + 1)}`,
            // HBDC-only fields shown in the detail panel
            ApplicationHistoricID: first(p.ApplicationHistoricID),
            WorkflowID: first(p.WorkflowID),
            AuthPrimaryIndustry: first(p.AuthPrimaryIndustry),
            ActPrimaryIndustry: first(p.ActPrimaryIndustry),
            AuthSecondaryIndustry: first(p.AuthSecondaryIndustry),
            ActSecondaryIndustry: first(p.ActSecondaryIndustry),
            AuthorisationLegal1: first(p.AuthorisationLegal1),
            AuthorisationLegal2: first(p.AuthorisationLegal2),
            WaterMeterRequired: first(p.WaterMeterRequired),
            WaterMeterInstalled: first(p.WaterMeterInstalled),
            DateWaterMeterRequired: ddmmyyyyToIsoDate(p.DateWaterMeterRequired) || timestampToIsoDate(p.DateWaterMeterRequired),
            WellNumber: first(p.WellNumber)
        })
    },
    {
        id: 'NRC',
        name: 'Northland Regional Council',
        url: 'https://services2.arcgis.com/J8errK5dyxu7Xjf7/arcgis/rest/services/Resource_Consents_/FeatureServer/0',
        normalize: (p, index) => {
            const consentId = first(p.IRISID, `NRC-${index + 1}`);
            return {
                ConsentID: consentId,
                Status: canonicalizeStatus(p.CurrentStatus),
                Purpose: first(p.ActivityType),
                Subtype: first(p.ActivitySubType),
                GlobalID: `NRC:${consentId}`,
                LocalAuthority: 'Northland Regional Council',
                // NRC does not publish expiry dates; the app trusts its Status field directly
                NoExpiryDateAvailable: true
            };
        }
    },
    {
        id: 'HRC',
        name: 'Horizons Regional Council',
        url: 'https://services1.arcgis.com/VuN78wcRdq1Oj69W/ArcGIS/rest/services/OpenData_RegulatoryActivity/FeatureServer/3',
        normalize: (p, index) => {
            const consentId = first(p.ATH_BUSID, `HRC-${index + 1}`);
            return {
                ConsentID: consentId,
                Status: canonicalizeStatus(p.ATH_STATUS),
                Purpose: text(p.ATH_PURPRIM),
                Subtype: first(p.ATH_TYPE),
                Category: first(p.ATH_INDPRIM),
                GrantedDate: timestampToIsoDate(p.ATH_GRANTED),
                ExpiryDate: timestampToIsoDate(p.ATH_EXPIRY),
                GlobalID: `HRC:${consentId}`,
                LocalAuthority: 'Horizons Regional Council'
            };
        }
    },
    {
        id: 'WRC',
        name: 'Waikato Regional Council',
        url: 'https://services.arcgis.com/2bzQ0Ix3iO7MItUa/arcgis/rest/services/WDP_AUTH_ACTIVE_RESOURCE_CONSENTS_EXT/FeatureServer/0',
        normalize: (p, index) => {
            const consentId = first(p.AUTHORISATIONIRISID, `WRC-${index + 1}`);
            return {
                ConsentID: consentId,
                ProjectNumber: first(p.APPLICATIONIRISID),
                Status: canonicalizeStatus(p.STATUS),
                PrimaryConsentHolder: text(p.HOLDERS),
                HolderDisplay: text(p.HOLDERS),
                SiteAddress: text(p.AUTHORISATION_ADDRESS),
                Purpose: text(p.PRIMARY_INDUSTRY_PURPOSE),
                Subtype: first(p.ACTIVITY_TYPE),
                Category: first(p.ACTIVITY_SUBTYPE),
                GrantedDate: timestampToIsoDate(p.COMMENCEMENT_DATE),
                ExpiryDate: timestampToIsoDate(p.EXPIRY_DATE),
                GlobalID: `WRC:${consentId}`,
                LocalAuthority: 'Waikato Regional Council'
            };
        }
    },
    {
        id: 'TRC',
        name: 'Taranaki Regional Council',
        url: 'https://services.arcgis.com/MMPHUPU6MnEt0lEK/arcgis/rest/services/Ressource_Consents/FeatureServer/7',
        normalize: (p, index) => {
            const consentId = first(p.Consent, p.ConsentNo, `TRC-${index + 1}`);
            return {
                ConsentID: consentId,
                Status: canonicalizeStatus(p.Status),
                Purpose: text(p.AuthorisationDescription),
                Subtype: first(p.ActivityType),
                Category: text(p.Activity_Subtype),
                GrantedDate: timestampToIsoDate(p.CommencementDate),
                ExpiryDate: timestampToIsoDate(p.ExpiryDate),
                GlobalID: `TRC:${consentId}`,
                LocalAuthority: 'Taranaki Regional Council'
            };
        }
    },
    {
        id: 'GWRC',
        name: 'Greater Wellington Regional Council',
        url: 'https://mapping.gw.govt.nz/arcgis/rest/services/GW/Resource_Consents_P/MapServer/0',
        normalize: (p, index) => {
            const consentId = first(p.RC_CON_FILENO, `GWRC-${index + 1}`);
            return {
                ConsentID: consentId,
                Status: canonicalizeStatus(p.RCstatus),
                Purpose: text(p.Purpose_Desc),
                Subtype: first(p.ConsentType, p.ConsentTyp),
                // RC_APT_DESC is a detailed activity type descriptor e.g. "CP - DISCHARGE TO LAND/WATER"
                Category: first(p.RC_APT_DESC),
                // commencement_date and ExpiredDate are DD/MM/YYYY strings, not timestamps
                GrantedDate: ddmmyyyyToIsoDate(p.commencement_date),
                ExpiryDate: ddmmyyyyToIsoDate(p.ExpiredDate),
                StatusDate: ddmmyyyyToIsoDate(p.ElapsedDate),
                CapID: first(p.DMfolder),
                // Document archive search link built from the consent file number
                PublicDocumentsLink: p.RC_CON_FILENO
                    ? `https://concessions.gw.govt.nz/documents/archive/?q=${encodeURIComponent(consentId)}`
                    : '',
                GlobalID: `GWRC:${consentId}`,
                LocalAuthority: 'Greater Wellington Regional Council'
            };
        }
    },
    {
        id: 'GDC',
        name: 'Gisborne District Council',
        url: 'https://maps.gdc.govt.nz/hosting/rest/services/Property/resource_consents_ext/MapServer/0',
        normalize: (p, index) => {
            const consentId = first(p.ConsentApplication, `GDC-${index + 1}`);
            return {
                ConsentID: consentId,
                ProjectNumber: first(p.LegacyId),
                Status: canonicalizeStatus(p.ConsentStatus),
                SiteAddress: text(p.SiteAddress),
                Purpose: text(p.ConsentDetails),
                Subtype: first(p.ConsentType),
                GrantedDate: timestampToIsoDate(p.DecisionDate),
                LodgedDate: timestampToIsoDate(p.DateReceived),
                ExpiryDate: timestampToIsoDate(p.ExpiryDate),
                CapID: first(p.LegacyId),
                FactorySupplyNumber: first(p.BoreId),
                GlobalID: `GDC:${consentId}`,
                LocalAuthority: 'Gisborne District Council'
            };
        }
    }
];

// --- GeoJSON → records ---

// Keep only features with a usable WGS84 point location.
function isValidPoint(feature) {
    const g = feature && feature.geometry;
    if (!g || g.type !== 'Point' || !Array.isArray(g.coordinates) || g.coordinates.length < 2) return false;
    const [lng, lat] = g.coordinates;
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return false;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return false;
    // (0, 0) is a common placeholder for "no location"
    return !(lat === 0 && lng === 0);
}

const round6 = (n) => Math.round(n * 1e6) / 1e6;

// Normalise a region's GeoJSON FeatureCollection into [{ lng, lat, fields }] records.
export function normalizeRegion(region, geojson) {
    const features = (geojson && Array.isArray(geojson.features)) ? geojson.features : [];
    return features.filter(isValidPoint).map((feature, index) => ({
        lng: round6(feature.geometry.coordinates[0]),
        lat: round6(feature.geometry.coordinates[1]),
        fields: region.normalize(feature.properties || {}, index)
    }));
}
