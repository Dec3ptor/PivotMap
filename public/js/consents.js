// === Consent logic ===
// Pure functions shared by the app (js/main.js) and the tests: decoding the region
// files, working out renewal timing, and sorting consents into work types and holder
// types. Nothing here touches the DOM, so it also runs under Node.

// Fields every consent has once loaded ('' when a region doesn't publish it).
// Keep in sync with COMMON_FIELDS in scripts/regions.mjs.
export const COMMON_FIELDS = [
    'ConsentID', 'ProjectNumber', 'Status', 'PrimaryConsentHolder', 'HolderDisplay',
    'PrimaryConsentHolderAddress', 'LocalAuthority', 'SiteAddress', 'Purpose', 'Subtype',
    'Category', 'WaterManagementZone', 'WaterManagementArea', 'ComplianceOfficer',
    'GrantedDate', 'LodgedDate', 'ExpiryDate', 'StatusDate', 'CapID', 'FactorySupplyNumber',
    'PublicDocumentsLink', 'DeemedPermitted', 'GlobalID'
];

export const DAY_MS = 24 * 60 * 60 * 1000;

// Law changes that move expiry dates (see the Help panel for the plain-English version):
// - RMA s123C (Resource Management (Duration of Consents) Amendment Act 2025) extended many
//   consents due to expire before 31 Dec 2027 to that date.
// - The Planning Act 2026 is expected to extend most consents again, to about two years after
//   the national transition period ends (around 2031).
// Freshwater consents can't be extended past 35 years in total, and wastewater network
// consents are excluded, so those are the expiry dates most likely to hold.
export const LAW = {
    s123cDate: '2027-12-31',
    freshwaterMaxYears: 35,
    // s124: apply at least 6 months before expiry to keep operating while the new
    // application is processed; 3–6 months needs the council's agreement.
    s124Months: 6,
    s124DiscretionMonths: 3
};

// --- Dates ---
// Dates in the data are calendar dates ('YYYY-MM-DD'). For arithmetic they become whole day
// numbers (days since 1 Jan 1970), which sidesteps time zones and daylight saving.
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function dayNumber(iso) {
    const m = typeof iso === 'string' && ISO_DATE.exec(iso);
    if (!m) return null;
    const month = +m[2], day = +m[3];
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return Date.UTC(+m[1], month - 1, day) / DAY_MS;
}

export function isoFromDayNumber(n) {
    return n == null ? '' : new Date(n * DAY_MS).toISOString().slice(0, 10);
}

// Today's calendar date in the viewer's time zone, as a day number.
export function todayNumber(now = new Date()) {
    return Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / DAY_MS;
}

// Calendar-month arithmetic that clamps to the end of shorter months (31 Aug − 6 months = 28 Feb).
export function addMonthsIso(iso, months) {
    const m = ISO_DATE.exec(iso || '');
    if (!m) return '';
    const total = +m[1] * 12 + (+m[2] - 1) + months;
    const year = Math.floor(total / 12);
    const month = total - year * 12; // 0-based
    const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    const pad = n => String(n).padStart(2, '0');
    return `${year}-${pad(month + 1)}-${pad(Math.min(+m[3], lastDay))}`;
}

// A local-midnight Date, for formatting.
export function parseDate(iso) {
    const m = ISO_DATE.exec(iso || '');
    return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
}

// Expiry dates from this day on are placeholders for "no expiry" (GWRC uses 9999).
const PLACEHOLDER_EXPIRY_DAY = Date.UTC(2200, 0, 1) / DAY_MS;

// --- Text ---
const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&#039;': "'", '&apos;': "'" };

// Some council text arrives HTML-encoded ("R Smith &amp; G Jones") or with stray line breaks.
export function cleanText(value) {
    if (value == null) return '';
    const text = String(value);
    if (!/&|\s\s|[\r\n\t]|^\s|\s$/.test(text)) return text;
    return text
        .replace(/&(amp|lt|gt|quot|apos|#0?39);/g, m => ENTITIES[m])
        .replace(/\s+/g, ' ')
        .trim();
}

// --- Region files ---
// Expand a compact region file (written by scripts/update-data.mjs) into one plain object per
// consent: { region, fields, constants, records: [[lng, lat, ...values in `fields` order]] }
// Fields a region doesn't publish read as '' from this shared prototype.
const EMPTY_FIELDS = Object.fromEntries(COMMON_FIELDS.map(f => [f, '']));

export function expandRegionData(data) {
    const region = data.region;
    const fields = data.fields || [];
    const constants = data.constants || {};
    return (data.records || []).map(row => {
        const p = Object.create(EMPTY_FIELDS);
        Object.assign(p, constants);
        for (let i = 0; i < fields.length; i++) p[fields[i]] = row[i + 2] ?? '';
        if (!p.GlobalID) p.GlobalID = `${region}:${p.ConsentID}`;
        p.Region = region;
        p.lng = row[0];
        p.lat = row[1];
        return p;
    });
}

// --- Status ---
// Councils use dozens of status words; group them into what matters for renewals.
export const STATUS_GROUPS = {
    live: 'Current',
    renewing: 'Renewal lodged (s124)',
    pending: 'Application in progress',
    ended: 'No longer current',
    unknown: 'Status not stated'
};

const statusCache = new Map();
function cachedStatusGroup(status) {
    let group = statusCache.get(status);
    if (group === undefined) {
        group = statusGroup(status);
        statusCache.set(status, group);
    }
    return group;
}

export function statusGroup(status) {
    const s = String(status || '').trim().toLowerCase();
    if (!s) return 'unknown';
    if (/s\.?\s?124|existing use protection/.test(s)) return 'renewing';
    if (/^(current|active|granted)$/.test(s) || /\bcurrent\b|not yet commenced|variation applies|deemed cp/.test(s)) return 'live';
    if (/process|lodged|accepted|notified|on hold|proposed|awaiting|pending|appeal|decision|pre-?application|s88|deferred/.test(s)) return 'pending';
    return 'ended';
}

// --- Work types ---
// What the consent is for, in terms of the kind of work a renewal would involve.
export const WORK_TYPES = [
    { id: 'wastewater', label: 'Wastewater', icon: 'fa-toilet', hint: 'Treatment plants, sewage and trade waste discharges' },
    { id: 'water', label: 'Water takes & supply', icon: 'fa-faucet-drip', hint: 'Surface and groundwater takes, irrigation, public supply' },
    { id: 'stormwater', label: 'Stormwater & drainage', icon: 'fa-cloud-showers-heavy', hint: 'Stormwater discharges, drainage and flood pumps' },
    { id: 'industry', label: 'Industry, waste & air', icon: 'fa-industry', hint: 'Industrial discharges, landfills, odour and air emissions' },
    { id: 'energy', label: 'Energy, quarries & mining', icon: 'fa-bolt', hint: 'Hydro, geothermal, oil and gas, quarries and mines' },
    { id: 'rivers', label: 'Rivers, dams & structures', icon: 'fa-bridge-water', hint: 'Bed works, culverts, bridges, dams, diversions, gravel' },
    { id: 'coastal', label: 'Coastal & marine', icon: 'fa-anchor', hint: 'Coastal structures, wharves, seawalls, dredging, marine farms' },
    { id: 'roads', label: 'Roads & transport', icon: 'fa-road', hint: 'State highways, local roads and rail' },
    { id: 'land', label: 'Earthworks & land use', icon: 'fa-mountain', hint: 'Earthworks, vegetation clearance, land development' },
    { id: 'forestry', label: 'Forestry', icon: 'fa-tree', hint: 'Plantation forestry, harvesting and afforestation' },
    { id: 'farm', label: 'Farming & effluent', icon: 'fa-cow', hint: 'Dairy shed effluent, intensive farming and farm nutrient consents', minor: true },
    { id: 'minor', label: 'Small & domestic', icon: 'fa-house', hint: 'Moorings, whitebait stands, jetties, domestic bores and septic tanks', minor: true },
    { id: 'other', label: 'Other', icon: 'fa-circle-question', hint: 'Not enough detail to tell' }
];
export const WORK_TYPE_BY_ID = Object.fromEntries(WORK_TYPES.map(t => [t.id, t]));
// Small jobs that are hidden unless asked for.
export const DEFAULT_HIDDEN_WORK_TYPES = WORK_TYPES.filter(t => t.minor).map(t => t.id);

// Ordered rules: the first match wins, so specific activities come before broad ones.
const WORK_RULES = [
    ['water', /pasture cultivation \(irrigation[^|]*\| water permit/],
    ['industry', /dairy (factory|product|processing|manufactur|company)|milk (powder|processing|treatment)|meat (works|processing|product)|abattoir|freezing works|\brendering\b|pulp (mill|and paper)|paper mill|\bsawmill|timber (treatment|processing)|fertili[sz]er (works|plant|manufactur)|chemical (plant|manufactur|complex)|ammonia|\burea\b|petrochemical|refinery|cement (works|plant|manufactur)|steel ?works|smelter|winery waste|tannery|fellmonger|coolstore|vehicle wash|crematori|cremation/],
    ['farm', /farm animal effluent|animal (waste|effluent)|dairy ?shed|din exceeding|luc exceedance|production land use|nitrogen (leach|loss|discharge)|(dairy|dairying|piggery|\bpigs?\b|poultry|cow|cattle|farm|feed ?pad)\b[^|]{0,60}(effluent|wastewater|odour|waste\b)|effluent[^|]{0,40}(dairy|farm|pasture|cow|cattle)|\bpiggery\b|poultry (farm|shed)|intensive farming|feed ?pad|wintering (barn|pad)|stand-?off pad|\bfde\b|^discharge \| dairy/],
    ['water', /municipal water|(municipal|community|town|public|council)[^|]{0,30}water (supply|take|treatment)|water supply - (municipal|potable)|public water supply|drinking water|municipal or drinking water|municipal and \/ or drinking/],
    ['wastewater', /municipal (sewage|wastewater|effluent)|township|community (sewage|wastewater|scheme)|(wastewater|sewage|effluent) treatment (plant|system|ponds?)|\bwwtp\b|oxidation pond|treatment ponds?/],
    ['minor', /mooring|whitebait|boat ?shed|boat ?ramp|slipway|pontoon|\bjett(y|ies)\b|domestic|\boset\b|on-?site (waste ?water|sewage|effluent)|septic|single (property|dwelling)|residential - single|dwelling|lifestyle block|household|land - well|luc - bores|bore (construction|consent)|(install|construct|drill)[^|]{0,40}\bbores?\b|boreholes?|bore, core sample|monitoring \/ investigation|hydrological (sampling|monitoring)|\bbores? \|/],
    ['wastewater', /waste ?water|sewage|sewerage|\bsewer|effluent|septage|sludge|biosolid|blackwater|trade waste/],
    ['stormwater', /storm ?water|drainage|flood pump/],
    ['forestry', /forest|afforest|harvest|plantation|woodlot|logging|\blogs\b|replanting|clear ?fell|fell(ing)? (exotic )?trees|landings|cable haul|exotic trees|radiata|\bpines?\b/],
    ['energy', /geothermal|\bhydro\b|hydro-?electric|power (station|scheme|generation)|electricity generation|wind farm|solar farm|hydrocarbon|petroleum|\boil\b|natural gas|gas (well|field|pipeline|production)|well ?site|production station|\bmining\b|\bmines?\b|quarr(y|ies|ying)|aggregate|mineral|\bcoal\b/],
    // Diversions and dams (without a take) are river works, even when filed under "water use".
    ['rivers', /^(?!.*\b(take|takes|taking|abstract))[^]*(diversion|\bdivert|\bdams?\b|damming|\bweir)/],
    ['water', /water take|take (and use )?(of )?(ground|surface)?\s?water|(ground|surface) ?water take|groundwater|take water|take and use|water use|irrigat|frost|stock ?water|water supply|potable|abstract|take up to|\btake\b[^|]{0,30}cubic|wp - (ground|surface) ?water|water - take/],
    ['coastal', /coastal|\bcma\b|marine|harbou?r|wharf|wharves|seawall|sea wall|dredg|estuar|foreshore|\bport\b|beach|sand (extraction|removal)|aquaculture|mussel|oyster|\bcp - /],
    ['roads', /\broading\b|roadworks|state highway|\bsh ?\d+\b|motorway|expressway|\brail(way)?\b|transport public networks|transport services - road|\broad (works|remedial|reserve|construction|formation|widening|realignment|upgrade|maintenance|repairs?|reinstatement|network|corridor|bridge|culvert|crossing|resilience|safety)|(construct|form|upgrade|widen|realign|repair|maintain|build|seal|reinstate)[a-z ]{0,20}\broads?\b|bypass|interchange|cycleway/],
    ['rivers', /river|stream|\blake\b|\bbeds?\b|culvert|bridge|\bford\b|weir|\bdams?\b|damming|divers|divert|channel|flood (protection|management|control)|stop ?bank|gravel|shingle|reclamation|wetland|watercourse|streamwork|river crossing|erosion protection|bank stabilisation|hazard mitigation|piping|\bpipes?\b/],
    ['industry', /industr|manufactur|processing|factory|discharge to air|air discharge|\bair\b|odour|emission|\bdust\b|incinerat|boiler|abattoir|\bmeat\b|timber|landfill|refuse|transfer station|compost|cleanfill|leachate|contaminant|solid waste|waste management|agrichemical|spray|pest control|\b1080\b|monofluoroacetate|diquat|herbicide|pesticide|poison|blasting|abrasive/],
    ['water', /water permit|\bwp - /],
    ['land', /earthwork|excavat|disturb|vegetation|clearance|\bfill(ing)?\b|contaminated (land|site)|subdivision|land use|land development|retaining|erosion|recontour|\btrack|impervious|building|construct|structure|habitat|production land|use-erect/]
];

// Industries (or purposes) that say more about the job than the activity does, e.g. a
// culvert built for a state highway is roading work. Each rule lists the activity types
// it may replace.
const INDUSTRY_RULES = [
    ['minor', /residential - single|single property|domestic residence|lifestyle block|camping ground|rse accommodation|domestic effluent discharge - (other|camp ground|commercial)|mooring|jett(y|ies)|boat ?ramp|boat ?shed|whitebait/,
        ['wastewater', 'water', 'stormwater', 'land', 'rivers', 'coastal', 'other']],
    ['farm', /dairying|dairy farm|piggery|poultry|intensive farming/, ['industry', 'wastewater', 'other']],
    ['wastewater', /effluent discharge - municipal/, ['industry', 'minor', 'other']],
    ['forestry', /forest/, ['rivers', 'land', 'minor', 'water', 'energy', 'roads', 'other']],
    ['roads', /transport services - road|transport public networks|roading|\broads?\b|highway|\brail/, ['rivers', 'land', 'minor', 'other']],
    ['energy', /\bhydro\b|hydroelectric|geothermal|power generation|electricity|petro|hydrocarbon|\boil\b|\bgas\b|mineral|aggregate|quarr|mining/,
        ['rivers', 'land', 'minor', 'water', 'industry', 'other']],
    ['water', /water supply - (municipal|community)|municipal water|public water supply|municipal or drinking/, ['minor', 'rivers', 'other']]
];

// Gisborne publishes short consent-type codes; use them when the description says too little.
const GDC_CODES = {
    land: ['SG', 'SM', '21', '26', '41', '43', 'NC', 'LL', 'RD', 'RC', 'LD', 'LC', 'LH', 'LU', 'PC', 'PD', 'PM', 'OP', 'PN', 'PR', 'PZ', 'PA', 'MS', 'EU', 'DS', 'DT'],
    minor: ['RB', 'LB'],
    forestry: ['LV', 'LP', 'LA', 'NF', 'PF', 'RP', 'LE', 'RR'],
    industry: ['DA'],
    wastewater: ['WD', 'DL'],
    coastal: ['CP', 'CC', 'CD', 'CO', 'CS', 'CR', 'CM'],
    water: ['WS', 'WG', 'WU', 'CV'],
    rivers: ['WI', 'WM', 'WP', 'RS', 'LS', 'RW', 'LR']
};
const GDC_CODE_TYPES = Object.fromEntries(Object.entries(GDC_CODES).flatMap(([type, codes]) => codes.map(c => [c, type])));

// Which fields describe the activity, and which describe the industry, differs by council.
const FIELD_ROLES = {
    HBDC: { activity: ['Purpose', 'Subtype'], industry: ['Category'] },
    HRC: { activity: ['Purpose', 'Subtype'], industry: ['Category'] },
    WRC: { activity: ['Category', 'Subtype'], industry: ['Purpose'] },
    default: { activity: ['Subtype', 'Category', 'Purpose'], industry: [] }
};

function joinFields(p, fields) {
    return fields.map(f => p[f]).filter(v => v && v !== 'NA').join(' | ').toLowerCase();
}

function firstRule(rules, text) {
    if (!text) return null;
    for (const [id, re] of rules) if (re.test(text)) return id;
    return null;
}

export function classifyWork(p) {
    const roles = FIELD_ROLES[p.Region] || FIELD_ROLES.default;
    const activity = joinFields(p, roles.activity);
    const industry = joinFields(p, roles.industry);
    let type = firstRule(WORK_RULES, activity) || firstRule(WORK_RULES, industry) || 'other';
    if (industry) {
        for (const [id, re, replaces] of INDUSTRY_RULES) {
            if (re.test(industry)) {
                if (replaces.includes(type)) type = id;
                break;
            }
        }
    }
    if ((type === 'other' || type === 'land') && p.Region === 'GDC') type = GDC_CODE_TYPES[String(p.Subtype).trim()] || type;
    return type;
}

// --- Holder types ---
export const HOLDER_TYPES = [
    { id: 'public', label: 'Councils & government', singular: 'a council or government agency' },
    { id: 'utility', label: 'Utilities, energy & ports', singular: 'a utility, energy or port company' },
    { id: 'business', label: 'Companies', singular: 'a company' },
    { id: 'private', label: 'Individuals & trusts', singular: 'an individual or trust' },
    { id: 'unknown', label: 'Holder not published', singular: '' }
];
export const HOLDER_TYPE_BY_ID = Object.fromEntries(HOLDER_TYPES.map(t => [t.id, t]));

const HOLDER_NAME_RULES = [
    ['public', /\bcouncil\b|district\b|department of|harbourmaster|unitary authority|health board|\bdhb\b|te whatu ora|health nz|hospital|transport agency|waka kotahi|\bnzta\b|kiwi ?rail|ontrack|department of conservation|\bdoc\b|ministry|minister\b|\bcrown\b|majesty|government|kainga ora|housing new zealand|police|defence|\bnzdf\b|corrections|university|polytechnic|institute of technology|w[aā]nanga|\bschool\b|board of trustees|\bcollege\b|\bkura\b|\bniwa\b|\bscion\b|agresearch|landcare research|gns science|\besr\b|fire and emergency|civil defence|domain board|reserve board|cemetery/],
    ['utility', /energy|\bpower|electric|\bhydro\b|geothermal|generation|transpower|powerco|unison|\bvector\b|mercury|genesis|meridian|trustpower|manawa|firstgas|first gas|\bgas\b|\boil\b|petroleum|\bomv\b|watercare|port of|\bport (company|authority|nelson|taranaki|napier|otago|marlborough)\b|seaport|airport|chorus|\bspark\b|telecom|one nz|vodafone|broadband/],
    ['business', /\b(limited|ltd|llp|inc|incorporated|incorporation|holdings|company|co|corporation|corp|partnership|lp|group|enterprises|industries|farms?|farming|orchards?|vineyards?|station|estates?|properties|investments|developments|contractors|quarr(y|ies)|forests?|forestry|timberlands|plantations|trading|services|supplies|joint venture|jv|winstone|nz)\b/]
];

const PUBLIC_ACTIVITY = /municipal|\bcouncil\b|public water supply|community (water|wastewater|sewage|scheme)|town (water )?supply|township|state highway|\bsh ?\d+\b|transport public networks|transport services - road|roading|wastewater treatment plant|sewage treatment|\bwwtp\b|oxidation pond|public (sewer|wastewater)|government|stormwater municipal|river management|river control|flood (protection|control) scheme|public safety|education, research/;
const UTILITY_ACTIVITY = /hydroelectric|\bhydro\b|geothermal power|power generation|electricity generation|hydrocarbon|petroleum|petrochemical|port\/marine|production station/;
const BUSINESS_ACTIVITY = /manufactur|processing|production|industr|quarr|mining|commercial|animal processing|winery/;

// Returns { type, inferred } — inferred when the council doesn't publish holder names and the
// type is guessed from what the consent is for.
export function classifyHolder(p, holderName) {
    if (holderName) return { type: holderTypeForName(holderName), inferred: false };
    if (String(p.PrimaryConsentHolder).trim().toLowerCase() === 'private') return { type: 'private', inferred: false };
    return inferHolderType(joinFields(p, ['Subtype', 'Category', 'Purpose']));
}

const holderNameCache = new Map();
function holderTypeForName(name) {
    let type = holderNameCache.get(name);
    if (!type) {
        type = firstRule(HOLDER_NAME_RULES, name.toLowerCase()) || 'private';
        holderNameCache.set(name, type);
    }
    return type;
}

function inferHolderType(text) {
    if (PUBLIC_ACTIVITY.test(text)) return { type: 'public', inferred: true };
    if (UTILITY_ACTIVITY.test(text)) return { type: 'utility', inferred: true };
    if (BUSINESS_ACTIVITY.test(text)) return { type: 'business', inferred: true };
    return { type: 'unknown', inferred: false };
}

// Holder name as published. Hawke's Bay's "LocalAuthority" is the district, not the holder,
// and Waikato writes "Private" for individuals.
export function holderName(p) {
    const name = cleanText(p.PrimaryConsentHolder || (p.Region === 'HBDC' ? '' : p.HolderDisplay));
    return /^private$/i.test(name) ? '' : name;
}

// --- Urgency ---
// How long until the consent expires, in plain-language bands.
export const STAGES = [
    { id: 'now', label: 'Under 6 months', short: '< 6 mo', maxDays: 182, color: '#dc2626' },
    { id: 'soon', label: '6–12 months', short: '6–12 mo', maxDays: 365, color: '#ea580c' },
    { id: 'plan', label: '1–2 years', short: '1–2 yrs', maxDays: 730, color: '#ca8a04' },
    { id: 'later', label: '2–5 years', short: '2–5 yrs', maxDays: 1826, color: '#0d9488' },
    { id: 'future', label: 'Over 5 years', short: '5+ yrs', maxDays: Infinity, color: '#2563eb' },
    { id: 'past', label: 'Past expiry', short: 'Past', color: '#7f1d1d' },
    { id: 'none', label: 'No expiry date', short: 'No date', color: '#64748b' },
    { id: 'ended', label: 'Not current', short: 'Ended', color: '#94a3b8' }
];
export const STAGE_BY_ID = Object.fromEntries(STAGES.map(s => [s.id, s]));
const STAGE_RANK = Object.fromEntries(STAGES.map((s, i) => [s.id, i]));
export function stageRank(id) { return STAGE_RANK[id] ?? STAGES.length; }

export function stageForDays(days) {
    if (days == null) return 'none';
    if (days < 0) return 'past';
    if (days <= 182) return 'now';
    if (days <= 365) return 'soon';
    if (days <= 730) return 'plan';
    if (days <= 1826) return 'later';
    return 'future';
}

function stageFor(status, days) {
    if (status === 'live') return stageForDays(days);
    if (status === 'renewing') return days != null && days >= 0 ? stageForDays(days) : 'past';
    return 'ended';
}

// Time windows offered in the app. `maxDays` null = every consent, any status.
export const WINDOWS = [
    { id: '6m', label: '6 months', maxDays: 182 },
    { id: '1y', label: '1 year', maxDays: 365 },
    { id: '2y', label: '2 years', maxDays: 730 },
    { id: '5y', label: '5 years', maxDays: 1826 },
    { id: 'all', label: 'All', maxDays: null }
];
export const WINDOW_BY_ID = Object.fromEntries(WINDOWS.map(w => [w.id, w]));

const FRESHWATER_ACTIVITY = /water permit|water take|water use|take (and use )?(of )?water|groundwater|surface water|diver(t|sion)|\bdams?\b|damming|irrigat|frost|stock ?water|water supply/;
const DISCHARGE_ACTIVITY = /discharg|effluent|waste ?water|sewage|storm ?water|leachate/;
const NOT_FRESHWATER_DISCHARGE = /\bair\b|odour|emission|coastal|\bcma\b|marine|harbou?r/;

// Water permits and discharges to water (or to land where they may reach water) are capped at
// 35 years in total and can't be extended past that.
export function isFreshwaterConsent(p) {
    return isFreshwaterText(joinFields(p, ['Subtype', 'Category', 'Purpose']));
}

function isFreshwaterText(text) {
    return FRESHWATER_ACTIVITY.test(text) || (DISCHARGE_ACTIVITY.test(text) && !NOT_FRESHWATER_DISCHARGE.test(text));
}

// Classifying depends only on a consent's council and description, which repeat a lot (Hawke's
// Bay has 6,000 "Orchard | Water Supply - Irrigation" consents), so short descriptions are cached.
const activityCache = new Map();
function describeActivity(p) {
    const key = `${p.Region}\u0000${p.Subtype}\u0000${p.Category}\u0000${p.Purpose}`;
    let hit = activityCache.get(key);
    if (!hit) {
        const text = joinFields(p, ['Subtype', 'Category', 'Purpose']);
        hit = { work: classifyWork(p), freshwater: isFreshwaterText(text), holder: inferHolderType(text) };
        if (key.length < 200) activityCache.set(key, hit);
    }
    return hit;
}

// --- Enrichment ---
const WITHHELD_HOLDER = /^\s*private\s*$/i;

// Adds the derived fields (prefixed with _) used for filtering, sorting and display.
// `today` is a day number (see todayNumber()).
export function enrich(p, today = todayNumber()) {
    const activity = describeActivity(p);
    p._holder = holderName(p);
    let holder = activity.holder;
    if (p._holder) holder = { type: holderTypeForName(p._holder), inferred: false };
    else if (WITHHELD_HOLDER.test(p.PrimaryConsentHolder)) holder = { type: 'private', inferred: false };
    p._holderType = holder.type;
    p._holderGuess = holder.inferred;
    p._work = activity.work;
    p._status = cachedStatusGroup(p.Status);

    const expiryDay = dayNumber(p.ExpiryDate);
    const hasExpiry = expiryDay != null && expiryDay < PLACEHOLDER_EXPIRY_DAY;
    p._expiry = hasExpiry ? p.ExpiryDate : '';
    p._days = hasExpiry ? expiryDay - today : null;
    p._stage = stageFor(p._status, p._days);
    p._lawExtended = p._expiry === LAW.s123cDate;
    p._firm = firmReason(p, activity.freshwater, hasExpiry ? expiryDay : null);
    p._hay = null; // search text, built on first search
    return p;
}

// Why the expiry date is unlikely to be pushed out by the law changes ('' if it might be).
function firmReason(p, freshwater, expiryDay) {
    if (p._work === 'wastewater' && p._holderType === 'public') return 'wastewater';
    if (freshwater && expiryDay != null) {
        const cap = dayNumber(addMonthsIso(p.GrantedDate, LAW.freshwaterMaxYears * 12));
        // At the cap when the expiry is within a month of 35 years from the grant date.
        if (cap != null && cap - expiryDay <= 31) return 'cap';
    }
    return '';
}

// The latest date to apply for a replacement and keep s124 protection.
export function lodgeByDate(p) {
    return p._expiry ? addMonthsIso(p._expiry, -LAW.s124Months) : '';
}

// When a freshwater consent reaches the 35-year maximum term ('' if not freshwater or no grant date).
export function freshwaterCapDate(p) {
    return isFreshwaterConsent(p) ? addMonthsIso(p.GrantedDate, LAW.freshwaterMaxYears * 12) : '';
}

export function searchText(p) {
    if (p._hay == null) {
        p._hay = cleanText([p.ConsentID, p._holder, p.SiteAddress, p.Purpose, p.Subtype, p.Category, p.ProjectNumber, p.LocalAuthority, p.Region, p.CapID]
            .filter(Boolean).join(' ')).toLowerCase();
    }
    return p._hay;
}

export function searchTerms(query) {
    return String(query || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
}

// --- Filtering ---
// `filters`: { window, regions, workTypes, holderTypes (Sets or null for all), terms,
//              holder, firmOnly, hideLawExtended, includeRenewing }
export function matchesFilters(p, f) {
    if (f.regions && !f.regions.has(p.Region)) return false;
    const win = WINDOW_BY_ID[f.window] || WINDOW_BY_ID['2y'];
    if (win.maxDays != null) {
        const okStatus = p._status === 'live' || (f.includeRenewing && p._status === 'renewing');
        if (!okStatus || p._days == null || p._days < 0 || p._days > win.maxDays) return false;
    }
    if (f.workTypes && !f.workTypes.has(p._work)) return false;
    if (f.holderTypes && !f.holderTypes.has(p._holderType)) return false;
    if (f.holder && p._holder !== f.holder) return false;
    if (f.firmOnly && !p._firm) return false;
    if (f.hideLawExtended && p._lawExtended) return false;
    if (f.terms && f.terms.length) {
        const hay = searchText(p);
        for (const term of f.terms) if (!hay.includes(term)) return false;
    }
    return true;
}

export function filterConsents(records, filters) {
    return records.filter(p => matchesFilters(p, filters));
}

// --- Sorting ---
export const SORTS = [
    { id: 'soonest', label: 'Soonest first' },
    { id: 'latest', label: 'Latest first' },
    { id: 'holder', label: 'Holder A–Z' },
    { id: 'region', label: 'By council' }
];

const compareText = (a, b) => (a || '￿').localeCompare(b || '￿', 'en', { sensitivity: 'base' });
// Consents with no expiry date sort after every dated one.
const expiryKey = p => (p._expiry ? p._expiry : '9999-99-99');

const byConsentId = (a, b) => String(a.ConsentID).localeCompare(String(b.ConsentID));
// Current consents with a coming expiry first, then current ones without a date or past it,
// then everything no longer current (most recently ended first).
function currencyRank(p) {
    if (p._status === 'live' || p._status === 'renewing') return p._days == null ? 1 : (p._days < 0 ? 2 : 0);
    return 3;
}
const bySoonest = (a, b) => currencyRank(a) - currencyRank(b)
    || (currencyRank(a) === 3 ? expiryKey(b).localeCompare(expiryKey(a)) : expiryKey(a).localeCompare(expiryKey(b)))
    || compareText(a._holder, b._holder) || byConsentId(a, b);
const byLatest = (a, b) => currencyRank(a) - currencyRank(b) || expiryKey(b).localeCompare(expiryKey(a))
    || compareText(a._holder, b._holder) || byConsentId(a, b);
const COMPARATORS = {
    soonest: bySoonest,
    latest: byLatest,
    holder: (a, b) => compareText(a._holder, b._holder) || bySoonest(a, b),
    region: (a, b) => a.Region.localeCompare(b.Region) || bySoonest(a, b)
};

// Sorts in place and returns the array.
export function sortConsents(records, sortId = 'soonest') {
    return records.sort(COMPARATORS[sortId] || bySoonest);
}

// --- Holders ---
// Group consents by published holder name, biggest first.
export function groupByHolder(records) {
    const groups = new Map();
    let unnamed = 0;
    for (const p of records) {
        if (!p._holder) { unnamed++; continue; }
        let g = groups.get(p._holder);
        if (!g) {
            g = { name: p._holder, type: p._holderType, count: 0, soonest: null, works: new Map(), regions: new Set() };
            groups.set(p._holder, g);
        }
        g.count++;
        g.regions.add(p.Region);
        g.works.set(p._work, (g.works.get(p._work) || 0) + 1);
        if (p._expiry && (!g.soonest || p._expiry < g.soonest._expiry)) g.soonest = p;
    }
    const list = [...groups.values()].sort((a, b) =>
        b.count - a.count || expiryKey(a.soonest || {}).localeCompare(expiryKey(b.soonest || {})) || compareText(a.name, b.name));
    return { holders: list, unnamed };
}

// Count consents per urgency stage.
export function countStages(records) {
    const counts = Object.fromEntries(STAGES.map(s => [s.id, 0]));
    for (const p of records) counts[p._stage] = (counts[p._stage] || 0) + 1;
    return counts;
}

// --- Plain-language helpers ---
export function describeTimeLeft(days) {
    if (days == null) return 'No expiry date';
    if (days < 0) {
        const ago = -days;
        if (ago < 60) return `Expired ${ago} day${ago === 1 ? '' : 's'} ago`;
        if (ago < 730) return `Expired ${Math.round(ago / 30.44)} months ago`;
        return `Expired ${Math.floor(ago / 365.25)} years ago`;
    }
    if (days === 0) return 'Expires today';
    if (days === 1) return 'Expires tomorrow';
    if (days < 60) return `Expires in ${days} days`;
    if (days < 730) return `Expires in ${Math.round(days / 30.44)} months`;
    const years = days / 365.25;
    return `Expires in ${years < 10 ? years.toFixed(1).replace(/\.0$/, '') : Math.round(years)} years`;
}

// What the s124 timing means for this consent today:
//   { kind: 'renewing' | 'expired' | 'ok' | 'discretion' | 'late', deadline? }
export function lodgementAdvice(p, today = todayNumber()) {
    if (!p._expiry) return null;
    if (p._status === 'renewing') return { kind: 'renewing' };
    if (p._days < 0) return { kind: 'expired' };
    const lodgeBy = lodgeByDate(p);
    if (dayNumber(lodgeBy) >= today) return { kind: 'ok', deadline: lodgeBy };
    const discretion = addMonthsIso(p._expiry, -LAW.s124DiscretionMonths);
    if (dayNumber(discretion) >= today) return { kind: 'discretion', deadline: discretion, missed: lodgeBy };
    return { kind: 'late' };
}

// --- CSV ---
export function csvEscape(value) {
    let text = value == null ? '' : String(value);
    // Council text could start like a spreadsheet formula; make Excel treat it as text.
    if (/^[=+@\t\r]|^-[^\d\s]/.test(text)) text = `'${text}`;
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(headers, rows) {
    // Leading BOM so Excel reads UTF-8 (macrons in place names).
    return '﻿' + [headers, ...rows].map(row => row.map(csvEscape).join(',')).join('\r\n') + '\r\n';
}
