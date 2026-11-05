// === Regional consent sources ===
// Where each council publishes its resource consents (an ArcGIS REST layer),
// and how that council's fields map onto the app's common consent schema.
// To add a region: add an entry to REGIONS, then run `npm run update-data`.

import { statusGroup } from '../public/js/consents.js';
import { looksLikeNztm, nztmToWgs84 } from './nztm.mjs';

// Fields every consent record has once loaded in the app ('' when unknown).
export const COMMON_FIELDS = [
    'ConsentID', 'ProjectNumber', 'Status', 'PrimaryConsentHolder', 'HolderDisplay',
    'PrimaryConsentHolderAddress', 'LocalAuthority', 'SiteAddress', 'Purpose', 'Subtype',
    'Category', 'WaterManagementZone', 'WaterManagementArea', 'ComplianceOfficer',
    'GrantedDate', 'LodgedDate', 'ExpiryDate', 'StatusDate', 'CapID', 'FactorySupplyNumber',
    'PublicDocumentsLink', 'DeemedPermitted', 'GlobalID', 'Industry'
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
    const s = String(raw || '').replace(/\s+/g, ' ').trim();
    switch (s.toLowerCase()) {
        case 'active':   // GWRC, GDC, Marlborough → same concept as BOPRC "Current"
        case 'granted':  // GDC → decision made, consent live
        case 'issued - active': // Canterbury
            return 'Current';
        case 'lapsed consent': // GDC full label → match surrendered family
            return 'Lapsed';
        default: {
            // Canterbury: "Terminated - Expired", "Terminated - Replaced", …
            const ended = /^terminated - (.+)$/i.exec(s);
            return ended ? ended[1].charAt(0).toUpperCase() + ended[1].slice(1) : s;
        }
    }
}

// Distinct non-empty values, in first-seen order.
function unique(values) {
    return [...new Set(values.map(v => text(v)).filter(Boolean))];
}

// --- Regions ---
// normalize(properties, index) returns the record's fields (anything omitted is ''), or null
// to leave the record out. `index` is the feature's position among the region's kept point
// features, used only for fallback IDs when a source record has none.
// Optional settings: pageSize (the server's page limit), layers (more layers whose consents
// are added), details (a layer joined on a key), fallback (an ArcGIS Hub copy to use when the
// council's server fails) and links (fields the app can rebuild from a pattern).

const ECAN_SERVICE = 'https://gis.ecan.govt.nz/arcgis/rest/services/Public/Resource_Consents/MapServer';
const ES_SERVICE = 'https://maps.es.govt.nz/server/rest/services/Public/Consents/MapServer';

// North to south, in the usual regional order (Auckland, Tasman and Nelson publish no consent data).
export const REGIONS = [
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
        id: 'BOPRC',
        name: 'Bay of Plenty Regional Council',
        url: 'https://gis.boprc.govt.nz/server2/rest/services/BayOfPlentyMaps/ConsentsandCompliance/MapServer/45',
        normalize: (p, index) => ({
            ConsentID: first(p.ConsentID, `BOPRC-${index + 1}`),
            ProjectNumber: first(p.ProjectNumber),
            Status: canonicalizeStatus(p.Status),
            PrimaryConsentHolder: text(p.PrimaryConsentHolder),
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
    },
    {
        id: 'HBDC',
        name: "Hawke's Bay Regional Council",
        url: 'https://gis.hbrc.govt.nz/server/rest/services/ExternalServices/Regulatory/MapServer/1',
        // The council's server refuses connections from outside New Zealand (including GitHub's
        // servers); its open-data copy on ArcGIS Hub is used instead, a few days behind at most.
        fallback: { hubItemId: '92e050ec6c85469293f84c8b94a807bd', layer: 1 },
        normalize: (p, index) => ({
            ConsentID: first(p.AuthorisationIRISID, p.ApplicationHistoricID, `HBDC-${index + 1}`),
            ProjectNumber: first(p.WorkflowID, p.ApplicationHistoricID),
            Status: canonicalizeStatus(p.AuthorisationCurrentStatus),
            // LocalAuthority is the district the consent is in; Hawke's Bay doesn't publish holders.
            LocalAuthority: first(p.LocalAuthority),
            SiteAddress: text(p.AuthorisationPropertyAddress),
            Purpose: text(p.AuthPrimaryPurpose, p.ActPrimaryPurpose),
            // e.g. "Discharge Permit"; only the Hub copy has it, so fall back to "Resource Consent"
            Subtype: first(p.AuthorisationActivityType, p.AuthorisationType),
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
        id: 'MDC',
        name: 'Marlborough District Council',
        url: 'https://gis.marlborough.govt.nz/server/rest/services/OpenData/OpenData3/MapServer/5',
        pageSize: 1000,
        links: { PublicDocumentsLink: 'https://www.marlborough.govt.nz/services/property-files-online?searchType=Resource+Consent+Number&resourceConsentNumber={ProjectNumber}' },
        normalize: (p, index) => {
            // Subdivision consents are district-council business that never expires; no other
            // council's data has them, so they're left out.
            if (/^subdivision/i.test(text(p.ConsentTypeParentDescription))) return null;
            const consentId = text(p.ConsentNumber) || `MDC-${index + 1}`;
            const decision = text(p.DecisionMadeDescription);
            const granted = /^(granted|consent order|issued)/i.test(decision);
            return {
                ConsentID: consentId,
                ProjectNumber: text(p.ConsentNumberPFOL),
                Status: marlboroughStatus(p.ConsentStatusDescription, decision),
                PrimaryConsentHolder: text(p.ApplicantNames),
                Purpose: text(p.DescriptionOfActivity),
                // e.g. "Coastal Permit - Marine Farm" (the parent type, "Coastal", adds nothing)
                Subtype: text(p.ConsentTypeDescription, p.ConsentTypeParentDescription),
                GrantedDate: granted ? timestampToIsoDate(p.DecisionDate) : '',
                ExpiryDate: timestampToIsoDate(p.ExpiryDate),
                // For a refused or withdrawn application, when that happened
                StatusDate: granted ? '' : timestampToIsoDate(p.DecisionDate),
                PublicDocumentsLink: text(p.PropertyFilesLink),
                GlobalID: `MDC:${consentId}`
            };
        }
    },
    {
        id: 'WCRC',
        name: 'West Coast Regional Council',
        // The council's own map server is often down; this is its ArcGIS Online copy.
        url: 'https://utility.arcgis.com/usrsvcs/servers/39c782f2da1442bda74406e716a5aa37/rest/services/Hosted/IRIS_Consents_and_Applications_External_Layer/FeatureServer/1',
        pageSize: 1000,
        normalize: (p, index) => {
            const consentId = text(p.filenumber) || `WCRC-${index + 1}`;
            return {
                ConsentID: consentId,
                Status: canonicalizeStatus(p.currentstatus),
                PrimaryConsentHolder: text(p.nameforservice),
                SiteAddress: text(p.locality),
                Purpose: text(p.authdescription),
                Subtype: text(p.authorisationactivitytype),
                Category: text(p.authorisationactivitysubtype),
                GrantedDate: timestampToIsoDate(p.commencementdate),
                ExpiryDate: timestampToIsoDate(p.expirydate),
                DeemedPermitted: /deemed permitted/i.test(text(p.authorisationtype)) ? 'Yes' : '',
                GlobalID: `WCRC:${consentId}`
            };
        }
    },
    {
        id: 'ECAN',
        name: 'Environment Canterbury',
        url: `${ECAN_SERVICE}/45`,
        pageSize: 3000,
        // What each consent allows ("Take Groundwater", "Dairy Effluent"…) is published as a
        // separate layer of activities, joined on the consent number.
        details: { url: `${ECAN_SERVICE}/0`, key: 'ConsentNo', fields: ['FeatureType', 'ActivityText'], as: 'Activities' },
        // The consent's page on the council's website
        links: { PublicDocumentsLink: 'https://www.ecan.govt.nz/data/consent-search/consentdetails/{ConsentID}' },
        normalize: (p, index) => {
            const consentId = text(p.ConsentNo) || `ECAN-${index + 1}`;
            const activities = Array.isArray(p.Activities) ? p.Activities : [];
            const featureTypes = unique(activities.map(a => a.FeatureType));
            return {
                ConsentID: consentId,
                ProjectNumber: text(p.FileNo),
                Status: canonicalizeStatus(p.ConsentStatus),
                PrimaryConsentHolder: text(p.HolderName),
                LocalAuthority: text(p.GIS_TerritorialAuthority),
                SiteAddress: text(p.Location),
                Purpose: unique(activities.map(a => a.ActivityText || a.FeatureType)).join('; '),
                Subtype: text(p.ConsentType),
                Category: featureTypes.join('; '),
                WaterManagementZone: text(p.GIS_CWMSZone),
                // "6650200 - Waimakariri Water Race" → "Waimakariri Water Race"
                WaterManagementArea: text(p.GIS_Catchment).replace(/^\d+\s*-\s*/, ''),
                GrantedDate: timestampToIsoDate(p.fmDate),
                ExpiryDate: timestampToIsoDate(p.Expires),
                // When a consent ended early (replaced, surrendered…) toDate is that date
                StatusDate: /termination/i.test(p.toDateText || '') ? timestampToIsoDate(p.toDate) : '',
                PublicDocumentsLink: p.ConsentNo ? `https://www.ecan.govt.nz/data/consent-search/consentdetails/${encodeURIComponent(consentId)}` : '',
                DeemedPermitted: /^deemed/i.test(text(p.ConsentType)) ? 'Yes' : '',
                GlobalID: `ECAN:${consentId}`
            };
        }
    },
    {
        id: 'ORC',
        name: 'Otago Regional Council',
        url: 'https://maps.orc.govt.nz/arcgis/rest/services/ORCResourceConsents/MapServer/28',
        normalize: (p, index) => {
            const consentId = text(p.ConsentNumber) || `ORC-${index + 1}`;
            return {
                ConsentID: consentId,
                Status: canonicalizeStatus(p.ConsentStatus),
                PrimaryConsentHolder: text(p.ConsentHolder),
                LocalAuthority: text(p.DistrictAuthority),
                Purpose: text(p.PurposeActivity),
                Subtype: text(p.ConsentType),
                WaterManagementArea: text(p.ConsentCatchment),
                ExpiryDate: timestampToIsoDate(p.ExpiryDate),
                GlobalID: `ORC:${consentId}`
            };
        }
    },
    {
        id: 'ES',
        name: 'Environment Southland',
        url: `${ES_SERVICE}/2`,
        // Expired consents are a separate layer, published without holder names
        layers: [`${ES_SERVICE}/24`],
        normalize: (p, index) => {
            const consentId = text(p.IRISID) || `ES-${index + 1}`;
            return {
                ConsentID: consentId,
                Status: canonicalizeStatus(p.Status),
                PrimaryConsentHolder: text(p.Contact),
                SiteAddress: text(p.CommonName),
                Purpose: text(p.Details),
                Subtype: text(p.Type),
                Category: text(p.Subtype),
                Industry: text(p.Primary_),
                GrantedDate: timestampToIsoDate(p.StartDate),
                ExpiryDate: timestampToIsoDate(p.ExpiryDate),
                GlobalID: `ES:${consentId}`
            };
        }
    }
];

// Marlborough leaves the status blank until a consent is issued; the decision says why.
function marlboroughStatus(status, decision) {
    if (text(status)) return canonicalizeStatus(status);
    if (!decision) return 'Application in process';
    if (/^withdrawn/i.test(decision)) return 'Withdrawn';
    if (/^refused/i.test(decision)) return 'Refused';
    if (/^(granted|consent order|issued)/i.test(decision)) return 'Current';
    return decision; // e.g. "Pre application"
}

// --- GeoJSON → records ---

// A feature's location as [lng, lat], or null when it has no usable point.
// Some servers answer in NZTM metres even when asked for WGS84; those are converted.
function pointOf(feature) {
    const g = feature && feature.geometry;
    if (!g || g.type !== 'Point' || !Array.isArray(g.coordinates) || g.coordinates.length < 2) return null;
    let [lng, lat] = g.coordinates;
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
    if (looksLikeNztm(lng, lat)) [lng, lat] = nztmToWgs84(lng, lat);
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
    // (0, 0) is a common placeholder for "no location"
    return lat === 0 && lng === 0 ? null : [lng, lat];
}

const round6 = (n) => Math.round(n * 1e6) / 1e6;

// What a person sees of a consent. Rows sharing a GlobalID that agree on all of these are the
// same consent published once per location (several bores or discharge points); rows that
// differ are separate consents filed under one number (Wellington does this).
const IDENTITY_FIELDS = ['Status', 'ExpiryDate', 'GrantedDate', 'Subtype', 'Category', 'Purpose', 'PrimaryConsentHolder'];
// A merged value lists at most this many distinct parts (e.g. bore numbers).
const MAX_MERGED_PARTS = 12;

function mergeInto(target, extra) {
    for (const [key, value] of Object.entries(extra)) {
        const current = target[key];
        if (value === '' || value == null || value === current || key === 'GlobalID') continue;
        if (current === '' || current == null) {
            target[key] = value;
        } else if (typeof current === 'string' && typeof value === 'string') {
            const parts = current.split('; ');
            if (!parts.includes(value) && parts.length < MAX_MERGED_PARTS) target[key] = `${current}; ${value}`;
        }
    }
}

// One record per consent: repeated rows merge into the first (keeping its location), and
// distinct consents that share a number get "#2", "#3"… GlobalIDs so each can be starred.
export function mergeDuplicates(records) {
    const variantsById = new Map();
    const merged = [];
    for (const record of records) {
        const id = record.fields.GlobalID;
        if (!id) {
            merged.push(record);
            continue;
        }
        const key = IDENTITY_FIELDS.map(f => record.fields[f] ?? '').join('\u0001');
        let variants = variantsById.get(id);
        if (!variants) variantsById.set(id, variants = []);
        const same = variants.find(v => v.key === key);
        if (same) {
            mergeInto(same.record.fields, record.fields);
            continue;
        }
        if (variants.length) record.fields.GlobalID = `${id}#${variants.length + 1}`;
        variants.push({ key, record });
        merged.push(record);
    }
    return merged;
}

// Normalise a region's GeoJSON FeatureCollection into [{ lng, lat, fields }] records.
export function normalizeRegion(region, geojson) {
    const features = (geojson && Array.isArray(geojson.features)) ? geojson.features : [];
    const records = [];
    for (const feature of features) {
        const point = pointOf(feature);
        if (!point) continue;
        const fields = region.normalize(feature.properties || {}, records.length);
        if (!fields) continue;
        // The app reads a missing GlobalID as "<region>:<ConsentID>"; make it explicit here too
        if (!fields.GlobalID && fields.ConsentID) fields.GlobalID = `${region.id}:${fields.ConsentID}`;
        records.push({ lng: round6(point[0]), lat: round6(point[1]), fields });
    }
    return mergeDuplicates(records);
}

// --- History kept ---
// Consents that ended more than this long ago are left out of the app's data: they're no use
// for renewal work, and most councils publish decades of them (Canterbury alone has 55,000),
// which would make the app far slower to load.
export const HISTORY_YEARS = 10;
// Application outcomes rather than consents. Kept while they carry a recent date.
const NEVER_A_CONSENT = /withdrawn|returned|declined|refused|not required|not issued|incomp|closed|exempt|prohibited/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const isRealDate = (d) => ISO_DATE.test(d || '') && d < '2200';

// When an ended consent ended: the date its status changed, else its expiry date, else the
// latest other date known about it ('' if none).
export function endDate(fields) {
    if (isRealDate(fields.StatusDate)) return fields.StatusDate;
    if (isRealDate(fields.ExpiryDate)) return fields.ExpiryDate;
    return [fields.GrantedDate, fields.LodgedDate].filter(isRealDate).sort().pop() || '';
}

// Whether a record stays in the data. `cutoff` is the 'YYYY-MM-DD' date HISTORY_YEARS ago.
// Consents that are current, being renewed or in progress always stay, as do ended ones
// with no dates at all (Northland publishes none), except applications that never became consents.
export function keepRecord(fields, cutoff) {
    if (statusGroup(fields.Status) !== 'ended') return true;
    const ended = endDate(fields);
    if (!ended) return !NEVER_A_CONSENT.test(fields.Status || '');
    return ended >= cutoff;
}
