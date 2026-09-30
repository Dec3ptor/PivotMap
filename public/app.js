// === BOPRC Resource Consents App ===
(function () {
    'use strict';

    // --- State ---
    let allFeatures = [];
    let filteredFeatures = [];
    let currentPage = 1;
    const PAGE_SIZE = 100;
    let sortField = 'ExpiryDate';
    let sortDir = 'asc';
    let selectedFeatureId = null;
    let activeWatchlistFolder = null; // null = show all, or folder id to filter

    // --- Watchlist ---
    const WL_KEY = 'boprc_watchlist';
    const MAP_BASE_LAYER_KEY = 'boprc_map_base_layer';
    const DEFAULT_BASE_LAYER = 'Hybrid';
    const EXPIRY_ALERT_LABELS = {
        expired: 'Expired',
        'expired-30': 'Expired ≤30 days ago',
        'expired-60': 'Expired ≤60 days ago',
        'expired-90': 'Expired ≤90 days ago',
        'expired-180': 'Expired ≤6 months ago',
        'expired-365': 'Expired ≤12 months ago',
        '30': 'Within 30 days',
        '60': 'Within 60 days',
        '90': 'Within 90 days',
        '180': 'Within 6 months',
        '365': 'Within 12 months'
    };
    const REGION_OPTIONS = ['BOPRC', 'HBDC', 'NRC', 'HRC', 'WRC', 'TRC', 'GWRC', 'GDC'];
    // Status words that mean "actively valid" across all regional councils:
    // BOPRC/HBDC/TRC use "Current"; GDC uses "Active" and "Granted"; GWRC uses "Active"
    const ACTIVE_STATUSES = new Set(['current', 'active', 'granted']);

    // Normalise source-specific status words to a single canonical label where appropriate.
    // Different councils use different words for the same concepts — map them here once so
    // every downstream filter, badge, stat and CSV export sees consistent labels.
    function canonicalizeStatus(raw) {
        const s = (raw || '').trim();
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
    const CSV_EXPORT_FIELDS = [
        ['Region', 'Region'],
        ['Consent ID', 'ConsentID'],
        ['Project Number', 'ProjectNumber'],
        ['Status', 'Status'],
        ['Holder / Authority', 'HolderDisplay'],
        ['Holder Address', 'PrimaryConsentHolderAddress'],
        ['Local Authority', 'LocalAuthority'],
        ['Site Address', 'SiteAddress'],
        ['Purpose', 'Purpose'],
        ['Subtype', 'Subtype'],
        ['Category', 'Category'],
        ['Water Management Zone', 'WaterManagementZone'],
        ['Water Management Area', 'WaterManagementArea'],
        ['Compliance Officer', 'ComplianceOfficer'],
        ['Granted Date', 'GrantedDate'],
        ['Lodged Date', 'LodgedDate'],
        ['Expiry Date', 'ExpiryDate'],
        ['Status Date', 'StatusDate'],
        ['CAP ID', 'CapID'],
        ['Factory Supply Number', 'FactorySupplyNumber'],
        ['Public Documents Link', 'PublicDocumentsLink']
    ];
    function loadWatchlist() {
        try { return JSON.parse(localStorage.getItem(WL_KEY)) || { folders: [] }; }
        catch { return { folders: [] }; }
    }
    function saveWatchlist(wl) { localStorage.setItem(WL_KEY, JSON.stringify(wl)); }
    let watchlist = loadWatchlist();

    function loadBaseLayerPreference(baseLayers) {
        try {
            const savedLayer = localStorage.getItem(MAP_BASE_LAYER_KEY);
            return baseLayers[savedLayer] ? savedLayer : DEFAULT_BASE_LAYER;
        } catch {
            return DEFAULT_BASE_LAYER;
        }
    }

    function saveBaseLayerPreference(layerName) {
        try { localStorage.setItem(MAP_BASE_LAYER_KEY, layerName); }
        catch { /* Ignore localStorage write issues */ }
    }

    function generateId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

    function createFolder(name, color) {
        const folder = { id: generateId(), name, color: color || '#3b82f6', consents: [], created: new Date().toISOString() };
        watchlist.folders.push(folder);
        saveWatchlist(watchlist);
        return folder;
    }
    function renameFolder(folderId, newName) {
        const f = watchlist.folders.find(f => f.id === folderId);
        if (f) { f.name = newName; saveWatchlist(watchlist); }
    }
    function recolorFolder(folderId, newColor) {
        const f = watchlist.folders.find(f => f.id === folderId);
        if (f) { f.color = newColor; saveWatchlist(watchlist); }
    }
    function deleteFolder(folderId) {
        watchlist.folders = watchlist.folders.filter(f => f.id !== folderId);
        if (activeWatchlistFolder === folderId) activeWatchlistFolder = null;
        saveWatchlist(watchlist);
    }
    function addToFolder(folderId, globalID) {
        const f = watchlist.folders.find(f => f.id === folderId);
        if (f && !f.consents.includes(globalID)) { f.consents.push(globalID); saveWatchlist(watchlist); }
    }
    function removeFromFolder(folderId, globalID) {
        const f = watchlist.folders.find(f => f.id === folderId);
        if (f) { f.consents = f.consents.filter(c => c !== globalID); saveWatchlist(watchlist); }
    }
    function getFoldersForConsent(globalID) {
        return watchlist.folders.filter(f => f.consents.includes(globalID));
    }
    function isWatched(globalID) {
        return watchlist.folders.some(f => f.consents.includes(globalID));
    }
    function exportWatchlist() {
        const blob = new Blob([JSON.stringify(watchlist, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = 'BOPRC_Watchlist.json'; a.click();
        URL.revokeObjectURL(url);
    }
    function importWatchlist(file) {
        const reader = new FileReader();
        reader.onload = () => {
            try {
                const imported = JSON.parse(reader.result);
                if (!imported.folders || !Array.isArray(imported.folders)) throw new Error('Invalid format');
                // Merge: add new folders, merge consents into existing folders with same name
                imported.folders.forEach(impFolder => {
                    const existing = watchlist.folders.find(f => f.name === impFolder.name);
                    if (existing) {
                        impFolder.consents.forEach(c => { if (!existing.consents.includes(c)) existing.consents.push(c); });
                    } else {
                        impFolder.id = generateId();
                        watchlist.folders.push(impFolder);
                    }
                });
                saveWatchlist(watchlist);
                renderWatchlistSidebar();
                applyFilters();
                alert('Watchlist imported successfully! Folders with the same name were merged.');
            } catch (e) { alert('Failed to import watchlist: ' + e.message); }
        };
        reader.readAsText(file);
    }

    // --- DOM refs ---
    const $ = (sel) => document.querySelector(sel);
    const $$ = (sel) => document.querySelectorAll(sel);

    // --- Map setup ---
    const map = L.map('map', { zoomControl: true, preferCanvas: true }).setView([-37.8, 176.5], 8);

    // Base layers
    const streets = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap contributors',
        maxZoom: 19
    });
    const linzBasemapsApiKey = 'd01hep5551e30kxb7w85hck49tp';
    const linzAerialUrl = 'https://basemaps.linz.govt.nz/v1/tiles/aerial/WebMercatorQuad/{z}/{x}/{y}.webp?api=' + linzBasemapsApiKey;
    const linzAerialAttribution = '<a href="https://www.linz.govt.nz/data/linz-data/linz-basemaps/data-attribution">LINZ CC BY 4.0 &copy; Imagery Basemap contributors</a>';
    const satellite = L.tileLayer(linzAerialUrl, {
        attribution: linzAerialAttribution,
        maxZoom: 19
    });
    const topoMap = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenTopoMap contributors',
        maxZoom: 17
    });
    const hybrid = L.layerGroup([
        L.tileLayer(linzAerialUrl, {
            attribution: linzAerialAttribution,
            maxZoom: 19
        }),
        L.tileLayer('https://{s}.basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}{r}.png', {
            attribution: '&copy; CARTO',
            maxZoom: 19,
            pane: 'shadowPane'
        })
    ]);
    const baseLayers = {
        'Streets': streets,
        'Satellite': satellite,
        'Hybrid': hybrid,
        'Topographic': topoMap
    };

    const initialBaseLayer = loadBaseLayerPreference(baseLayers);
    baseLayers[initialBaseLayer].addTo(map);
    saveBaseLayerPreference(initialBaseLayer);

    L.control.layers(baseLayers, null, { position: 'topright' }).addTo(map);
    map.on('baselayerchange', (e) => saveBaseLayerPreference(e.name));

    const clusterGroup = L.markerClusterGroup({
        chunkedLoading: true,
        // Keep true same-location markers clustered at high zoom so they can spiderfy,
        // while still letting nearby-but-distinct markers separate out.
        maxClusterRadius: (zoom) => zoom >= 16 ? 1 : 50,
        spiderfyOnMaxZoom: true,
        spiderfyDistanceMultiplier: 1.4,
        showCoverageOnHover: false
    });
    map.addLayer(clusterGroup);

    // Marker cache: globalID -> marker
    const markerMap = new Map();

    // --- Helpers ---
    const NOW = new Date();
    function daysUntilExpiry(dateStr) {
        if (!dateStr) return null;
        const d = new Date(dateStr);
        return Math.ceil((d - NOW) / (1000 * 60 * 60 * 24));
    }

    function isMissingOrExpiredExpiry(dateStr, days = daysUntilExpiry(dateStr)) {
        return !dateStr || (days !== null && days < 0);
    }

    // A consent is effectively "current" if its status is an active-meaning word AND its expiry is in the future.
    // Exception: regions that don't publish expiry dates (NoExpiryDateAvailable) are trusted on their Status alone.
    function isEffectivelyCurrent(p) {
        if (p.NoExpiryDateAvailable) return ACTIVE_STATUSES.has((p.Status || '').toLowerCase());
        return ACTIVE_STATUSES.has((p.Status || '').toLowerCase()) && !isMissingOrExpiredExpiry(p.ExpiryDate);
    }

    // Returns the status class to use for display — overrides any active status → Expired when expiry is gone/past.
    // Skipped for regions that don't publish expiry dates.
    function effectiveStatusClass(p) {
        if (!p.NoExpiryDateAvailable && ACTIVE_STATUSES.has((p.Status || '').toLowerCase()) && isMissingOrExpiredExpiry(p.ExpiryDate)) {
            return 'status-expired';
        }
        return statusClass(p.Status);
    }

    function matchesExpiryAlert(days, alert, dateStr = null) {
        if (alert === 'expired') return isMissingOrExpiredExpiry(dateStr, days);
        if (days === null) return false;
        if (alert.startsWith('expired-')) {
            const threshold = parseInt(alert.split('-')[1], 10);
            return days < 0 && !Number.isNaN(threshold) && Math.abs(days) <= threshold;
        }
        const threshold = parseInt(alert, 10);
        return days >= 0 && !Number.isNaN(threshold) && days <= threshold;
    }

    function expiryClass(days, dateStr = null) {
        if (!dateStr) return 'expiry-past';
        if (days === null) return '';
        if (days < 0) return 'expiry-past';
        if (days <= 30) return 'expiry-30';
        if (days <= 60) return 'expiry-60';
        if (days <= 90) return 'expiry-90';
        if (days <= 180) return 'expiry-180';
        if (days <= 365) return 'expiry-365';
        return '';
    }

    function expiryLabel(days, dateStr = null) {
        if (!dateStr) return 'EXPIRED';
        if (days === null) return '';
        if (days < 0) return 'EXPIRED';
        if (days <= 30) return '≤30d';
        if (days <= 60) return '≤60d';
        if (days <= 90) return '≤90d';
        if (days <= 180) return '≤6mo';
        if (days <= 365) return '≤12mo';
        return '';
    }

    function statusClass(status) {
        if (!status) return 'status-other';
        const s = status.toLowerCase();
        if (ACTIVE_STATUSES.has(s)) return 'status-current';   // Current / Active / Granted → green
        if (s === 'expired') return 'status-expired';
        if (s === 'surrendered') return 'status-surrendered';
        if (s === 'lapsed') return 'status-surrendered';
        if (s === 'cancelled') return 'status-cancelled';
        if (s.includes('progress')) return 'status-in-progress';
        return 'status-other';
    }

    function markerColor(props) {
        const days = daysUntilExpiry(props.ExpiryDate);
        if (props.Status && props.Status.toLowerCase() === 'expired') return '#ef4444';
        if (!props.NoExpiryDateAvailable && isMissingOrExpiredExpiry(props.ExpiryDate, days)) return '#ef4444';
        if (days !== null && days <= 90) return '#f97316';
        if (props.Status && ACTIVE_STATUSES.has(props.Status.toLowerCase())) return '#22c55e';
        return '#3b82f6';
    }

    function formatDate(dateStr) {
        if (!dateStr) return '—';
        return new Date(dateStr).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric' });
    }

    function formatShortDate(dateStr) {
        if (!dateStr) return '';
        return new Date(dateStr).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric' });
    }

    function pluralize(count, singular, plural) {
        return `${count.toLocaleString()} ${count === 1 ? singular : (plural || `${singular}s`)}`;
    }

    function csvEscape(value) {
        const text = value == null ? '' : String(value);
        return `"${text.replace(/"/g, '""')}"`;
    }

    function downloadTextFile(filename, content, mimeType) {
        const blob = new Blob([content], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
    }

    function getPointFeatures(geojson) {
        if (!geojson || !Array.isArray(geojson.features)) return [];
        return geojson.features.filter(f => {
            if (!f || !f.geometry) return false;
            if (f.geometry.type !== 'Point') return false;
            const c = f.geometry.coordinates;
            if (!Array.isArray(c) || c.length < 2) return false;
            const lng = c[0], lat = c[1];
            // Reject null, undefined, NaN, or out-of-range WGS84 coordinates
            if (!isFinite(lng) || !isFinite(lat)) return false;
            if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return false;
            // Reject (0, 0) — a common placeholder for "no location"
            if (lat === 0 && lng === 0) return false;
            return true;
        });
    }

    function createHbdcGlobalId(props, index) {
        const seed = props.AuthorisationIRISID || props.WorkflowID || props.GisObjectID || props.ESRI_OID || index + 1;
        return `HBDC:${seed}`;
    }

    function normalizeBoprcFeatures(geojson) {
        return getPointFeatures(geojson).map(feature => ({
            ...feature,
            properties: {
                ...feature.properties,
                Status: canonicalizeStatus(feature.properties.Status),
                Region: 'BOPRC',
                SourceDataset: 'BOPRC',
                HolderDisplay: feature.properties.PrimaryConsentHolder || '',
                LocalAuthority: feature.properties.LocalAuthority || ''
            }
        }));
    }

    function normalizeHbdcFeatures(geojson) {
        return getPointFeatures(geojson).map((feature, index) => {
            const p = feature.properties || {};
            const consentId = p.AuthorisationIRISID || p.ApplicationHistoricID || `HBDC-${index + 1}`;
            return {
                ...feature,
                properties: {
                    ...p,
                    ConsentID: consentId,
                    ProjectNumber: p.WorkflowID || p.ApplicationHistoricID || '',
                    Status: canonicalizeStatus(p.AuthorisationCurrentStatus),
                    PrimaryConsentHolder: '',
                    HolderDisplay: p.LocalAuthority || '',
                    PrimaryConsentHolderAddress: '',
                    SiteAddress: p.AuthorisationPropertyAddress || '',
                    Purpose: p.AuthPrimaryPurpose || p.ActPrimaryPurpose || '',
                    Subtype: p.AuthorisationType || '',
                    Category: p.AuthPrimaryIndustry || p.ActPrimaryIndustry || '',
                    WaterManagementZone: '',
                    WaterManagementArea: '',
                    ComplianceOfficer: '',
                    GrantedDate: p.DecisionServedDate || '',
                    LodgedDate: '',
                    ExpiryDate: p.ExpiryDate || '',
                    StatusDate: '',
                    CapID: p.ApplicationHistoricID || '',
                    FactorySupplyNumber: p.WellNumber || '',
                    PublicDocumentsLink: p.DocumentLink || '',
                    DeemedPermitted: p.AuthorisationType === 'Deemed Permitted Activity' ? 'Yes' : '',
                    GlobalID: createHbdcGlobalId(p, index),
                    Region: 'HBDC',
                    SourceDataset: 'HBDC',
                    LocalAuthority: p.LocalAuthority || ''
                }
            };
        });
    }

    // Convert an ArcGIS Unix timestamp (milliseconds) to an ISO date string (YYYY-MM-DD), or '' if null/zero.
    function arcgisTimestampToIso(ts) {
        if (ts === null || ts === undefined || ts === '') return '';
        try {
            const d = new Date(ts);
            if (isNaN(d.getTime())) return '';
            return d.toISOString().slice(0, 10);
        } catch (e) {
            return '';
        }
    }

    // Convert a DD/MM/YYYY date string (as used by GWRC) to YYYY-MM-DD, or '' if invalid.
    function ddmmyyyyToIso(str) {
        if (!str || typeof str !== 'string' || str.trim() === '') return '';
        try {
            const parts = str.trim().split('/');
            if (parts.length === 3 && parts[2].length === 4) {
                const iso = `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
                const d = new Date(iso);
                if (!isNaN(d.getTime())) return iso;
            }
        } catch (e) {}
        return '';
    }

    function normalizeNrcFeatures(geojson) {
        return getPointFeatures(geojson).map((feature, index) => {
            const p = feature.properties || {};
            const consentId = p.IRISID || `NRC-${index + 1}`;
            return {
                ...feature,
                properties: {
                    ...p,
                    ConsentID: consentId,
                    ProjectNumber: '',
                    Status: canonicalizeStatus(p.CurrentStatus),
                    PrimaryConsentHolder: '',
                    HolderDisplay: '',
                    PrimaryConsentHolderAddress: '',
                    SiteAddress: '',
                    Purpose: p.ActivityType || '',
                    Subtype: p.ActivitySubType || '',
                    Category: '',
                    WaterManagementZone: '',
                    WaterManagementArea: '',
                    ComplianceOfficer: '',
                    GrantedDate: '',
                    LodgedDate: '',
                    ExpiryDate: '',
                    NoExpiryDateAvailable: true,   // NRC does not publish expiry dates; trust Status field directly
                    StatusDate: '',
                    CapID: '',
                    FactorySupplyNumber: '',
                    PublicDocumentsLink: '',
                    DeemedPermitted: '',
                    GlobalID: `NRC:${consentId}`,
                    Region: 'NRC',
                    SourceDataset: 'NRC',
                    LocalAuthority: 'Northland Regional Council'
                }
            };
        });
    }

    function normalizeHrcFeatures(geojson) {
        return getPointFeatures(geojson).map((feature, index) => {
            const p = feature.properties || {};
            const consentId = p.ATH_BUSID || `HRC-${index + 1}`;
            return {
                ...feature,
                properties: {
                    ...p,
                    ConsentID: consentId,
                    ProjectNumber: '',
                    Status: canonicalizeStatus(p.ATH_STATUS),
                    PrimaryConsentHolder: '',
                    HolderDisplay: '',
                    PrimaryConsentHolderAddress: '',
                    SiteAddress: '',
                    Purpose: p.ATH_PURPRIM || '',
                    Subtype: p.ATH_TYPE || '',
                    Category: p.ATH_INDPRIM || '',
                    WaterManagementZone: '',
                    WaterManagementArea: '',
                    ComplianceOfficer: '',
                    GrantedDate: arcgisTimestampToIso(p.ATH_GRANTED),
                    LodgedDate: '',
                    ExpiryDate: arcgisTimestampToIso(p.ATH_EXPIRY),
                    StatusDate: '',
                    CapID: '',
                    FactorySupplyNumber: '',
                    PublicDocumentsLink: '',
                    DeemedPermitted: '',
                    GlobalID: `HRC:${consentId}`,
                    Region: 'HRC',
                    SourceDataset: 'HRC',
                    LocalAuthority: 'Horizons Regional Council'
                }
            };
        });
    }

    function normalizeWrcFeatures(geojson) {
        return getPointFeatures(geojson).map((feature, index) => {
            const p = feature.properties || {};
            const consentId = p.AUTHORISATIONIRISID || `WRC-${index + 1}`;
            return {
                ...feature,
                properties: {
                    ...p,
                    ConsentID: consentId,
                    ProjectNumber: p.APPLICATIONIRISID || '',
                    Status: canonicalizeStatus(p.STATUS),
                    PrimaryConsentHolder: p.HOLDERS || '',
                    HolderDisplay: p.HOLDERS || '',
                    PrimaryConsentHolderAddress: '',
                    SiteAddress: p.AUTHORISATION_ADDRESS || '',
                    Purpose: p.PRIMARY_INDUSTRY_PURPOSE || '',
                    Subtype: p.ACTIVITY_TYPE || '',
                    Category: p.ACTIVITY_SUBTYPE || '',
                    WaterManagementZone: '',
                    WaterManagementArea: '',
                    ComplianceOfficer: '',
                    GrantedDate: arcgisTimestampToIso(p.COMMENCEMENT_DATE),
                    LodgedDate: '',
                    ExpiryDate: arcgisTimestampToIso(p.EXPIRY_DATE),
                    StatusDate: '',
                    CapID: '',
                    FactorySupplyNumber: '',
                    PublicDocumentsLink: '',
                    DeemedPermitted: '',
                    GlobalID: `WRC:${consentId}`,
                    Region: 'WRC',
                    SourceDataset: 'WRC',
                    LocalAuthority: 'Waikato Regional Council'
                }
            };
        });
    }

    function normalizeTrcFeatures(geojson) {
        return getPointFeatures(geojson).map((feature, index) => {
            const p = feature.properties || {};
            const consentId = p.Consent || p.ConsentNo || `TRC-${index + 1}`;
            return {
                ...feature,
                properties: {
                    ...p,
                    ConsentID: consentId,
                    ProjectNumber: '',
                    Status: canonicalizeStatus(p.Status),
                    PrimaryConsentHolder: '',
                    HolderDisplay: '',
                    PrimaryConsentHolderAddress: '',
                    SiteAddress: '',
                    Purpose: p.AuthorisationDescription || '',
                    Subtype: p.ActivityType || '',
                    Category: '',
                    WaterManagementZone: '',
                    WaterManagementArea: '',
                    ComplianceOfficer: '',
                    GrantedDate: '',
                    LodgedDate: '',
                    ExpiryDate: arcgisTimestampToIso(p.ExpiryDate),
                    StatusDate: '',
                    CapID: '',
                    FactorySupplyNumber: '',
                    PublicDocumentsLink: '',
                    DeemedPermitted: '',
                    GlobalID: `TRC:${consentId}`,
                    Region: 'TRC',
                    SourceDataset: 'TRC',
                    LocalAuthority: 'Taranaki Regional Council'
                }
            };
        });
    }

    function normalizeGwrcFeatures(geojson) {
        return getPointFeatures(geojson).map((feature, index) => {
            const p = feature.properties || {};
            const consentId = p.RC_CON_FILENO || `GWRC-${index + 1}`;
            // Construct document archive search link from the consent file number
            const docLink = consentId && !consentId.startsWith('GWRC-')
                ? `https://concessions.gw.govt.nz/documents/archive/?q=${encodeURIComponent(consentId)}`
                : '';
            return {
                ...feature,
                properties: {
                    ...p,
                    ConsentID: consentId,
                    ProjectNumber: '',
                    Status: canonicalizeStatus(p.RCstatus),
                    PrimaryConsentHolder: '',
                    HolderDisplay: '',
                    PrimaryConsentHolderAddress: '',
                    SiteAddress: '',
                    Purpose: p.Purpose_Desc || '',
                    Subtype: p.ConsentType || p.ConsentTyp || '',
                    // RC_APT_DESC is a detailed activity type descriptor e.g. "CP - DISCHARGE TO LAND/WATER"
                    Category: p.RC_APT_DESC || '',
                    WaterManagementZone: '',
                    WaterManagementArea: '',
                    ComplianceOfficer: '',
                    // commencement_date and ExpiredDate are DD/MM/YYYY strings, not timestamps
                    GrantedDate: ddmmyyyyToIso(p.commencement_date),
                    LodgedDate: '',
                    ExpiryDate: ddmmyyyyToIso(p.ExpiredDate),
                    StatusDate: ddmmyyyyToIso(p.ElapsedDate),
                    CapID: p.DMfolder || '',
                    FactorySupplyNumber: '',
                    PublicDocumentsLink: docLink,
                    DeemedPermitted: '',
                    GlobalID: `GWRC:${consentId}`,
                    Region: 'GWRC',
                    SourceDataset: 'GWRC',
                    LocalAuthority: 'Greater Wellington Regional Council'
                }
            };
        });
    }

    function normalizeGdcFeatures(geojson) {
        return getPointFeatures(geojson).map((feature, index) => {
            const p = feature.properties || {};
            const consentId = p.ConsentApplication || `GDC-${index + 1}`;
            return {
                ...feature,
                properties: {
                    ...p,
                    ConsentID: consentId,
                    ProjectNumber: p.LegacyId || '',
                    Status: canonicalizeStatus(p.ConsentStatus),
                    PrimaryConsentHolder: '',
                    HolderDisplay: '',
                    PrimaryConsentHolderAddress: '',
                    SiteAddress: p.SiteAddress || '',
                    Purpose: p.ConsentDetails || '',
                    Subtype: p.ConsentType || '',
                    Category: '',
                    WaterManagementZone: '',
                    WaterManagementArea: '',
                    ComplianceOfficer: '',
                    GrantedDate: arcgisTimestampToIso(p.DecisionDate),
                    LodgedDate: arcgisTimestampToIso(p.DateReceived),
                    ExpiryDate: arcgisTimestampToIso(p.ExpiryDate),
                    StatusDate: '',
                    CapID: p.LegacyId || '',
                    FactorySupplyNumber: p.BoreId || '',
                    PublicDocumentsLink: '',
                    DeemedPermitted: '',
                    GlobalID: `GDC:${consentId}`,
                    Region: 'GDC',
                    SourceDataset: 'GDC',
                    LocalAuthority: 'Gisborne District Council'
                }
            };
        });
    }

    function combineConsentDatasets(datasetPayload) {
        if (datasetPayload && Array.isArray(datasetPayload.features)) {
            return normalizeBoprcFeatures(datasetPayload);
        }
        const boprcData = datasetPayload && (datasetPayload.boprc || datasetPayload.BOPRC);
        const hbdcData = datasetPayload && (datasetPayload.hbdc || datasetPayload.HBDC);
        const nrcData = datasetPayload && (datasetPayload.nrc || datasetPayload.NRC);
        const hrcData = datasetPayload && (datasetPayload.hrc || datasetPayload.HRC);
        const wrcData = datasetPayload && (datasetPayload.wrc || datasetPayload.WRC);
        const trcData = datasetPayload && (datasetPayload.trc || datasetPayload.TRC);
        const gwrcData = datasetPayload && (datasetPayload.gwrc || datasetPayload.GWRC);
        const gdcData = datasetPayload && (datasetPayload.gdc || datasetPayload.GDC);
        return [
            ...normalizeBoprcFeatures(boprcData),
            ...normalizeHbdcFeatures(hbdcData),
            ...(nrcData ? normalizeNrcFeatures(nrcData) : []),
            ...(hrcData ? normalizeHrcFeatures(hrcData) : []),
            ...(wrcData ? normalizeWrcFeatures(wrcData) : []),
            ...(trcData ? normalizeTrcFeatures(trcData) : []),
            ...(gwrcData ? normalizeGwrcFeatures(gwrcData) : []),
            ...(gdcData ? normalizeGdcFeatures(gdcData) : [])
        ];
    }

    function getRegionScopedFeatures(regions = REGION_OPTIONS) {
        if (!regions.length) return [];
        if (regions.length === REGION_OPTIONS.length) return allFeatures;
        return allFeatures.filter(f => regions.includes(f.properties.Region));
    }

    function createCircleIcon(color, selected) {
        if (selected) {
            return L.divIcon({
                className: '',
                html: `<div style="width:20px;height:20px;border-radius:50%;background:${color};border:3px solid #facc15;box-shadow:0 0 0 3px rgba(250,204,21,0.4),0 2px 8px rgba(0,0,0,0.4);z-index:1000;"></div>`,
                iconSize: [20, 20],
                iconAnchor: [10, 10]
            });
        }
        return L.divIcon({
            className: '',
            html: `<div style="width:12px;height:12px;border-radius:50%;background:${color};border:2px solid white;box-shadow:0 1px 3px rgba(0,0,0,0.3);"></div>`,
            iconSize: [12, 12],
            iconAnchor: [6, 6]
        });
    }

    // --- Load Data ---
    async function loadData() {
        // Check for embedded data first (single-file build)
        if (window.__GEOJSON_DATA) {
            allFeatures = combineConsentDatasets(window.__GEOJSON_DATA);
            initApp();
            return;
        }
        try {
            // Try fetch (works with local server)
            const [boprcResp, hbdcResp, nrcResp, hrcResp, wrcResp, trcResp, gwrcResp] = await Promise.all([
                fetch('Resource_Consents.geojson'),
                fetch('All_Consents_HBDC.geojson'),
                fetch('All_Consents_NRC.geojson'),
                fetch('All_Consents_HRC.geojson'),
                fetch('All_Consents_WRC.geojson'),
                fetch('All_Consents_TRC.geojson'),
                fetch('All_Consents_GWRC.geojson'),
                fetch('All_Consents_GDC.geojson')
            ]);
            const [boprcData, hbdcData, nrcData, hrcData, wrcData, trcData, gwrcData, gdcData] = await Promise.all([
                boprcResp.json(),
                hbdcResp.json(),
                nrcResp.json(),
                hrcResp.json(),
                wrcResp.json(),
                trcResp.json(),
                gwrcResp.json(),
                gdcResp.json()
            ]);
            allFeatures = combineConsentDatasets({ boprc: boprcData, hbdc: hbdcData, nrc: nrcData, hrc: hrcData, wrc: wrcData, trc: trcData, gwrc: gwrcData, gdc: gdcData });
            initApp();
        } catch (e) {
            console.warn('Fetch failed:', e);
            document.getElementById('loadingOverlay').innerHTML = `
                <div style="text-align:center;color:white;max-width:500px;padding:20px;">
                    <h2 style="margin-bottom:16px;">Local Server Required</h2>
                    <p style="margin-bottom:12px;">To load the GeoJSON data files, please serve this folder with a local web server,
                    or use the built single-file version (<code>BOPRC_Consents.html</code>).</p>
                    <p style="margin-bottom:12px;">In VS Code: install <strong>Live Server</strong> extension, right-click <code>index.html</code> → "Open with Live Server"</p>
                    <p style="font-size:13px;opacity:0.7;">Or run: <code>powershell .\\build.ps1</code> to create a standalone file.</p>
                </div>`;
        }
    }

    // --- Watchlist UI ---
    function renderWatchlistSidebar() {
        const container = $('#watchlistFolders');
        if (!container) return;
        if (watchlist.folders.length === 0) {
            container.innerHTML = '<div class="wl-empty">No folders yet. Create one to start watching consents.</div>';
        } else {
            container.innerHTML = watchlist.folders.map(f => {
                const active = activeWatchlistFolder === f.id ? ' wl-active' : '';
                return `<div class="wl-folder${active}" data-fid="${f.id}">
                    <div class="wl-folder-color" style="background:${f.color}"></div>
                    <div class="wl-folder-info">
                        <span class="wl-folder-name">${f.name}</span>
                        <span class="wl-folder-count">${f.consents.length} consent${f.consents.length !== 1 ? 's' : ''}</span>
                    </div>
                    <div class="wl-folder-actions">
                        <button class="wl-btn" data-action="rename" data-fid="${f.id}" title="Rename"><i class="fas fa-pen"></i></button>
                        <button class="wl-btn" data-action="color" data-fid="${f.id}" title="Change color"><i class="fas fa-palette"></i></button>
                        <button class="wl-btn wl-btn-danger" data-action="delete" data-fid="${f.id}" title="Delete"><i class="fas fa-trash"></i></button>
                    </div>
                </div>`;
            }).join('');
        }
    }

    function showFolderPicker(globalID) {
        const existing = getFoldersForConsent(globalID);
        const existingIds = existing.map(f => f.id);
        let html = '<div class="fp-title">Add to Folder</div>';
        if (watchlist.folders.length === 0) {
            html += '<div class="fp-empty">No folders yet. Create one first.</div>';
        } else {
            html += watchlist.folders.map(f => {
                const inFolder = existingIds.includes(f.id);
                return `<label class="fp-item">
                    <input type="checkbox" data-fid="${f.id}" ${inFolder ? 'checked' : ''} />
                    <div class="wl-folder-color" style="background:${f.color}"></div>
                    <span>${f.name}</span>
                </label>`;
            }).join('');
        }
        html += '<div class="fp-actions"><button id="fpNewFolder" class="btn-small"><i class="fas fa-plus"></i> New Folder</button></div>';
        const picker = $('#folderPicker');
        picker.innerHTML = html;
        picker.dataset.gid = globalID;
        picker.classList.remove('hidden');

        // Bind checkbox changes
        picker.querySelectorAll('input[type="checkbox"]').forEach(cb => {
            cb.addEventListener('change', () => {
                const fid = cb.dataset.fid;
                if (cb.checked) addToFolder(fid, globalID);
                else removeFromFolder(fid, globalID);
                renderWatchlistSidebar();
                applyFilters();
                // Update star in detail panel if open
                updateDetailStar(globalID);
            });
        });
        // New folder from picker
        const fpNew = picker.querySelector('#fpNewFolder');
        if (fpNew) fpNew.addEventListener('click', () => {
            const name = prompt('Folder name:');
            if (!name || !name.trim()) return;
            const folder = createFolder(name.trim());
            addToFolder(folder.id, globalID);
            renderWatchlistSidebar();
            showFolderPicker(globalID); // re-render picker
            applyFilters();
        });
    }

    function updateDetailStar(globalID) {
        const star = $('#detailStar');
        if (star) {
            const watched = isWatched(globalID);
            star.className = watched ? 'fas fa-star detail-star watched' : 'far fa-star detail-star';
        }
    }

    // --- Init ---
    function initApp() {
        buildFilters();
        buildAlertBadges();
        renderWatchlistSidebar();
        applyFilters();
        addMapMarkers(filteredFeatures);
        bindEvents();
        $('#loadingOverlay').classList.add('hidden');
        map.invalidateSize();
    }

    // --- Build filter options from data ---
    function buildFilters() {
        const statuses = [...new Set(allFeatures.map(f => f.properties.Status).filter(Boolean))].sort();
        const subtypes = [...new Set(allFeatures.map(f => f.properties.Subtype).filter(Boolean))].sort();
        const categories = [...new Set(allFeatures.map(f => f.properties.Category).filter(Boolean))].sort();
        const zones = [...new Set(allFeatures.map(f => f.properties.WaterManagementZone).filter(Boolean))].sort();
        const areas = [...new Set(allFeatures.map(f => f.properties.WaterManagementArea).filter(Boolean))].sort();
        const officers = [...new Set(allFeatures.map(f => f.properties.ComplianceOfficer).filter(Boolean))].sort();

        $('#filterStatus').innerHTML = statuses.map(s =>
            `<label class="cb"><input type="checkbox" value="${s}" /> <span class="badge ${statusClass(s).replace('status-', 'badge-')}">${s}</span></label>`
        ).join('');

        $('#filterSubtype').innerHTML = subtypes.map(s =>
            `<label class="cb"><input type="checkbox" value="${s}" /> ${s}</label>`
        ).join('');

        $('#filterCategory').innerHTML = categories.map(s =>
            `<label class="cb"><input type="checkbox" value="${s}" /> ${s}</label>`
        ).join('');

        populateSelect('#filterZone', zones);
        populateSelect('#filterArea', areas);
        populateSelect('#filterOfficer', officers);
    }

    function populateSelect(sel, items) {
        const el = $(sel);
        const first = el.options[0].outerHTML;
        el.innerHTML = first + items.map(i => `<option value="${i}">${i}</option>`).join('');
    }

    // --- Alert badges ---
    function buildAlertBadges(sourceFeatures = allFeatures) {
        let expired = 0, d30 = 0, d60 = 0, d90 = 0, d180 = 0, d365 = 0;
        sourceFeatures.forEach(f => {
            const expiryDate = f.properties.ExpiryDate;
            const days = daysUntilExpiry(expiryDate);
            if (!f.properties.NoExpiryDateAvailable && isMissingOrExpiredExpiry(expiryDate, days)) { expired++; return; }
            if (f.properties.NoExpiryDateAvailable && !ACTIVE_STATUSES.has((f.properties.Status || '').toLowerCase())) { expired++; return; }
            if (days === null) return;
            if (days <= 30) d30++;
            else if (days <= 60) d60++;
            else if (days <= 90) d90++;
            else if (days <= 180) d180++;
            else if (days <= 365) d365++;
        });
        const badges = [];
        if (expired) badges.push(`<span class="alert-badge" style="background:#fef2f2;color:#991b1b" data-filter="expired">${expired} Expired</span>`);
        if (d30) badges.push(`<span class="alert-badge" style="background:#fff7ed;color:#9a3412" data-filter="30">${d30} \u226430d</span>`);
        if (d60) badges.push(`<span class="alert-badge" style="background:#fefce8;color:#854d0e" data-filter="60">${d60} \u226460d</span>`);
        if (d90) badges.push(`<span class="alert-badge" style="background:#f7fee7;color:#3f6212" data-filter="90">${d90} \u226490d</span>`);
        if (d180) badges.push(`<span class="alert-badge" style="background:#f0f9ff;color:#075985" data-filter="180">${d180} \u22646mo</span>`);
        if (d365) badges.push(`<span class="alert-badge" style="background:#eef2ff;color:#3730a3" data-filter="365">${d365} \u226412mo</span>`);
        $('#alertBadges').innerHTML = badges.join('');
    }

    // --- Filtering ---
    function getCheckedValues(container) {
        return [...container.querySelectorAll('input:checked')].map(cb => cb.value);
    }

    function getFilterState() {
        const searchRaw = ($('#globalSearch').value || '').trim();
        return {
            searchRaw,
            searchTerms: searchRaw ? searchRaw.toLowerCase().split(/\s+/) : [],
            regions: getCheckedValues($('#regionFilter')),
            statuses: getCheckedValues($('#filterStatus')),
            expiryAlerts: getCheckedValues($('#filterExpiry')),
            subtypes: getCheckedValues($('#filterSubtype')),
            categories: getCheckedValues($('#filterCategory')),
            zone: $('#filterZone').value,
            area: $('#filterArea').value,
            officer: $('#filterOfficer').value,
            expiryFrom: $('#expiryFrom').value ? new Date($('#expiryFrom').value) : null,
            expiryTo: $('#expiryTo').value ? new Date($('#expiryTo').value) : null,
            grantedFrom: $('#grantedFrom').value ? new Date($('#grantedFrom').value) : null,
            grantedTo: $('#grantedTo').value ? new Date($('#grantedTo').value) : null,
            expiryFromRaw: $('#expiryFrom').value,
            expiryToRaw: $('#expiryTo').value,
            grantedFromRaw: $('#grantedFrom').value,
            grantedToRaw: $('#grantedTo').value,
            activeWatchlistFolder
        };
    }

    function findCheckboxByValue(containerSelector, value) {
        return [...document.querySelectorAll(`${containerSelector} input[type="checkbox"]`)].find(cb => cb.value === value);
    }

    function resetAllFilters() {
        $$('#sidebar input[type="checkbox"]').forEach(cb => cb.checked = false);
        $$('#regionFilter input[type="checkbox"]').forEach(cb => cb.checked = true);
        $$('#sidebar select').forEach(sel => sel.selectedIndex = 0);
        $$('#sidebar input[type="date"]').forEach(inp => inp.value = '');
        $('#globalSearch').value = '';
        activeWatchlistFolder = null;
        renderWatchlistSidebar();
        applyFilters();
    }

    function getActiveFilterChips(state = getFilterState()) {
        const chips = [];
        if (state.searchRaw) chips.push({ type: 'search', label: `Search: ${state.searchRaw}` });
        if (!state.regions.length) chips.push({ type: 'region', label: 'Region: none' });
        else if (state.regions.length < REGION_OPTIONS.length) chips.push({ type: 'region', label: `Region: ${state.regions.join(', ')}` });
        state.statuses.forEach(value => chips.push({ type: 'status', value, label: `Status: ${value}` }));
        state.expiryAlerts.forEach(value => chips.push({ type: 'expiryAlert', value, label: `Alert: ${EXPIRY_ALERT_LABELS[value] || value}` }));
        state.subtypes.forEach(value => chips.push({ type: 'subtype', value, label: `Subtype: ${value}` }));
        state.categories.forEach(value => chips.push({ type: 'category', value, label: `Category: ${value}` }));
        if (state.zone) chips.push({ type: 'zone', value: state.zone, label: `Zone: ${state.zone}` });
        if (state.area) chips.push({ type: 'area', value: state.area, label: `Area: ${state.area}` });
        if (state.officer) chips.push({ type: 'officer', value: state.officer, label: `Officer: ${state.officer}` });
        if (state.expiryFromRaw) chips.push({ type: 'expiryFrom', label: `Expiry from: ${formatShortDate(state.expiryFromRaw)}` });
        if (state.expiryToRaw) chips.push({ type: 'expiryTo', label: `Expiry to: ${formatShortDate(state.expiryToRaw)}` });
        if (state.grantedFromRaw) chips.push({ type: 'grantedFrom', label: `Granted from: ${formatShortDate(state.grantedFromRaw)}` });
        if (state.grantedToRaw) chips.push({ type: 'grantedTo', label: `Granted to: ${formatShortDate(state.grantedToRaw)}` });
        if (state.activeWatchlistFolder) {
            const folder = watchlist.folders.find(f => f.id === state.activeWatchlistFolder);
            if (folder) chips.push({ type: 'watchlist', label: `Folder: ${folder.name}` });
        }
        return chips;
    }

    function renderActiveFilterChips(state = getFilterState()) {
        const container = $('#activeFilters');
        const chips = getActiveFilterChips(state);
        if (!chips.length) {
            container.classList.add('is-empty');
            container.innerHTML = '';
            return chips;
        }
        container.classList.remove('is-empty');
        container.innerHTML = `<span class="active-filters-label">Active filters</span>${chips.map(chip => {
            const value = chip.value ? encodeURIComponent(chip.value) : '';
            return `<button type="button" class="filter-chip" data-chip-type="${chip.type}" data-chip-value="${value}" title="Remove filter"><span>${chip.label}</span><i class="fas fa-times"></i></button>`;
        }).join('')}<button type="button" class="filter-chip filter-chip-clear" data-chip-action="clear-all"><span>Clear all</span><i class="fas fa-rotate-left"></i></button>`;
        return chips;
    }

    function clearFilterChip(type, encodedValue) {
        const value = encodedValue ? decodeURIComponent(encodedValue) : '';
        switch (type) {
            case 'search':
                $('#globalSearch').value = '';
                break;
            case 'region':
                $$('#regionFilter input[type="checkbox"]').forEach(cb => cb.checked = true);
                break;
            case 'status': {
                const cb = findCheckboxByValue('#filterStatus', value);
                if (cb) cb.checked = false;
                break;
            }
            case 'expiryAlert': {
                const cb = findCheckboxByValue('#filterExpiry', value);
                if (cb) cb.checked = false;
                break;
            }
            case 'subtype': {
                const cb = findCheckboxByValue('#filterSubtype', value);
                if (cb) cb.checked = false;
                break;
            }
            case 'category': {
                const cb = findCheckboxByValue('#filterCategory', value);
                if (cb) cb.checked = false;
                break;
            }
            case 'zone':
                $('#filterZone').value = '';
                break;
            case 'area':
                $('#filterArea').value = '';
                break;
            case 'officer':
                $('#filterOfficer').value = '';
                break;
            case 'expiryFrom':
                $('#expiryFrom').value = '';
                break;
            case 'expiryTo':
                $('#expiryTo').value = '';
                break;
            case 'grantedFrom':
                $('#grantedFrom').value = '';
                break;
            case 'grantedTo':
                $('#grantedTo').value = '';
                break;
            case 'watchlist':
                activeWatchlistFolder = null;
                renderWatchlistSidebar();
                break;
            default:
                return;
        }
        applyFilters();
    }

    function getResultsStats() {
        let expired = 0;
        let expiringYear = 0;
        let watched = 0;
        let current = 0;
        filteredFeatures.forEach(f => {
            const p = f.properties;
            const days = daysUntilExpiry(p.ExpiryDate);
            // For regions that don't publish expiry dates, trust their Status field directly
            const isExpired = p.NoExpiryDateAvailable
                ? !ACTIVE_STATUSES.has((p.Status || '').toLowerCase())
                : isMissingOrExpiredExpiry(p.ExpiryDate, days);
            if (isExpired) expired++;
            if (days !== null && days >= 0 && days <= 365) expiringYear++;
            if (isEffectivelyCurrent(p)) current++;
            if (isWatched(p.GlobalID)) watched++;
        });
        return { total: filteredFeatures.length, current, expired, expiringYear, watched };
    }

    function renderResultsStats() {
        const stats = getResultsStats();
        $('#resultsStats').innerHTML = [
            { label: 'Results', value: stats.total, subtext: 'currently shown', tone: 'primary' },
            { label: 'Current', value: stats.current, subtext: 'active with future expiry', tone: 'primary' },
            { label: 'Expired', value: stats.expired, subtext: 'already past expiry', tone: 'danger' },
            { label: '≤12 months', value: stats.expiringYear, subtext: 'expiring within a year', tone: 'warning' },
            { label: 'Watchlisted', value: stats.watched, subtext: 'saved to folders', tone: 'note' }
        ].map(stat => `<div class="stat-card stat-${stat.tone}"><span class="stat-label">${stat.label}</span><span class="stat-value">${stat.value.toLocaleString()}</span><span class="stat-subtext">${stat.subtext}</span></div>`).join('');
    }

    function exportFilteredResults() {
        if (!filteredFeatures.length) return;
        const headers = CSV_EXPORT_FIELDS.map(([label]) => label).concat(['Days To Expiry', 'Expiry Bucket', 'Watchlist Folders']);
        const rows = filteredFeatures.map(feature => {
            const p = feature.properties;
            const days = daysUntilExpiry(p.ExpiryDate);
            const folders = getFoldersForConsent(p.GlobalID).map(folder => folder.name).join('; ');
            return CSV_EXPORT_FIELDS.map(([, field]) => p[field] || '').concat([
                days == null ? '' : days,
                expiryLabel(days, p.ExpiryDate),
                folders
            ]);
        });
        const csv = [headers.map(csvEscape).join(','), ...rows.map(row => row.map(csvEscape).join(','))].join('\r\n');
        const filename = `Regional_Consents_Filtered_${new Date().toISOString().slice(0, 10)}.csv`;
        downloadTextFile(filename, csv, 'text/csv;charset=utf-8;');
    }

    function applyFilters() {
        const state = getFilterState();
        const { searchTerms, regions, statuses, expiryAlerts, subtypes, categories, zone, area, officer, expiryFrom, expiryTo, grantedFrom, grantedTo } = state;

        buildAlertBadges(getRegionScopedFeatures(regions));

        filteredFeatures = allFeatures.filter(f => {
            const p = f.properties;

            if (!regions.length) return false;
            if (!regions.includes(p.Region)) return false;

            // Search — match all words independently (e.g. "Ross Green" matches "Ross Ashley Green")
            if (searchTerms.length) {
                const hay = [p.ConsentID, p.HolderDisplay, p.PrimaryConsentHolder, p.LocalAuthority, p.SiteAddress, p.Purpose, p.ProjectNumber]
                    .filter(Boolean).join(' ').toLowerCase();
                if (!searchTerms.every(term => hay.includes(term))) return false;
            }

            // Status — any active-meaning status is overridden to Expired when expiry is gone/past.
            // Regions that don't publish expiry dates (NoExpiryDateAvailable) are exempt from this override.
            if (statuses.length) {
                const effectiveStatus = (!p.NoExpiryDateAvailable && ACTIVE_STATUSES.has((p.Status || '').toLowerCase()) && isMissingOrExpiredExpiry(p.ExpiryDate))
                    ? 'Expired'
                    : p.Status;
                if (!statuses.includes(effectiveStatus)) return false;
            }

            // Expiry alerts
            if (expiryAlerts.length) {
                const days = daysUntilExpiry(p.ExpiryDate);
                let match = false;
                for (const alert of expiryAlerts) {
                    if (matchesExpiryAlert(days, alert, p.ExpiryDate)) { match = true; break; }
                }
                if (!match) return false;
            }

            // Subtype
            if (subtypes.length && !subtypes.includes(p.Subtype)) return false;
            // Category
            if (categories.length && !categories.includes(p.Category)) return false;
            // Zone
            if (zone && p.WaterManagementZone !== zone) return false;
            // Area
            if (area && p.WaterManagementArea !== area) return false;
            // Officer
            if (officer && p.ComplianceOfficer !== officer) return false;
            // Expiry date range
            if (expiryFrom && p.ExpiryDate && new Date(p.ExpiryDate) < expiryFrom) return false;
            if (expiryTo && p.ExpiryDate && new Date(p.ExpiryDate) > expiryTo) return false;
            // Granted date range
            if (grantedFrom && p.GrantedDate && new Date(p.GrantedDate) < grantedFrom) return false;
            if (grantedTo && p.GrantedDate && new Date(p.GrantedDate) > grantedTo) return false;

            // Watchlist folder filter
            if (activeWatchlistFolder) {
                const folder = watchlist.folders.find(fl => fl.id === activeWatchlistFolder);
                if (folder && !folder.consents.includes(p.GlobalID)) return false;
            }

            return true;
        });

        // Sort
        sortFeatures();
        currentPage = 1;
        renderTable();
        updateMapMarkers();
    }

    function sortFeatures() {
        filteredFeatures.sort((a, b) => {
            let va = a.properties[sortField];
            let vb = b.properties[sortField];
            if (va == null) va = '';
            if (vb == null) vb = '';
            // Date fields
            if (sortField.includes('Date')) {
                va = va ? new Date(va).getTime() : 0;
                vb = vb ? new Date(vb).getTime() : 0;
            } else {
                va = String(va).toLowerCase();
                vb = String(vb).toLowerCase();
            }
            if (va < vb) return sortDir === 'asc' ? -1 : 1;
            if (va > vb) return sortDir === 'asc' ? 1 : -1;
            return 0;
        });
    }

    function updateFilterSummary() {
        const total = allFeatures.length;
        const shown = filteredFeatures.length;
        const activeChips = renderActiveFilterChips();
        renderResultsStats();
        if (shown === total) {
            $('#filterSummary').textContent = `Showing all ${total.toLocaleString()} consents`;
        } else {
            $('#filterSummary').textContent = `Showing ${shown.toLocaleString()} of ${total.toLocaleString()} consents`;
        }
        if (activeChips.length) {
            $('#filterSummary').textContent += ` • ${pluralize(activeChips.length, 'filter')} active`;
        }
        const totalPages = Math.max(1, Math.ceil(shown / PAGE_SIZE));
        $('#tableInfo').textContent = `${pluralize(shown, 'consent')} • Page ${currentPage} of ${totalPages}`;
        $('#exportFilteredCsv').disabled = shown === 0;
    }

    // --- Table rendering ---
    function renderTable() {
        const totalPages = Math.max(1, Math.ceil(filteredFeatures.length / PAGE_SIZE));
        if (currentPage > totalPages) currentPage = totalPages;
        const start = (currentPage - 1) * PAGE_SIZE;
        const pageData = filteredFeatures.slice(start, start + PAGE_SIZE);
        const tbody = $('#tableBody');

        if (!pageData.length) {
            tbody.innerHTML = `<tr class="empty-row"><td colspan="11"><div class="table-empty-state"><i class="fas fa-filter-circle-xmark"></i><h4>No consents match the current filters</h4><p>Try removing one or more filters, broadening the date range, or clearing the watchlist/search filters to see more results.</p><button type="button" class="btn-secondary empty-reset-btn"><i class="fas fa-rotate-left"></i> Clear filters</button></div></td></tr>`;
            renderPagination();
            updateFilterSummary();
            return;
        }

        tbody.innerHTML = pageData.map(f => {
            const p = f.properties;
            const days = daysUntilExpiry(p.ExpiryDate);
            const ec = expiryClass(days, p.ExpiryDate);
            const el = expiryLabel(days, p.ExpiryDate);
            const sc = effectiveStatusClass(p);
            const gid = p.GlobalID;
            const selected = gid === selectedFeatureId ? ' selected' : '';
            const watched = isWatched(gid);
            const starCls = watched ? 'fas fa-star wl-star watched' : 'far fa-star wl-star';
            return `<tr data-gid="${gid}" class="${selected}" tabindex="0" aria-selected="${gid === selectedFeatureId ? 'true' : 'false'}">
                <td class="star-cell"><i class="${starCls}" data-gid="${gid}" title="Add to watchlist"></i></td>
                <td>${p.ConsentID || '\u2014'}</td>
                <td><span class="status-badge ${sc}">${p.Status || '\u2014'}</span></td>
                <td>${p.HolderDisplay || '\u2014'}</td>
                <td class="address-cell" title="${p.SiteAddress || ''}">${p.SiteAddress || '\u2014'}</td>
                <td class="purpose-cell" title="${p.Purpose || ''}">${p.Purpose || '\u2014'}</td>
                <td>${p.Subtype || '\u2014'}</td>
                <td>${p.Category || '\u2014'}</td>
                <td>${formatDate(p.ExpiryDate)}${ec ? ` <span class="expiry-tag ${ec}">${el}</span>` : ''}</td>
                <td>${formatDate(p.GrantedDate)}</td>
                <td>${p.PublicDocumentsLink ? `<a href="${p.PublicDocumentsLink}" target="_blank" class="docs-link" title="View documents" onclick="event.stopPropagation()"><i class="fas fa-external-link-alt"></i></a>` : '\u2014'}</td>
            </tr>`;
        }).join('');

        renderPagination();
        updateFilterSummary();
    }

    function renderPagination() {
        const totalPages = Math.ceil(filteredFeatures.length / PAGE_SIZE) || 1;
        const pag = $('#pagination');
        if (totalPages <= 1) { pag.innerHTML = ''; return; }

        let html = `<button ${currentPage === 1 ? 'disabled' : ''} data-page="${currentPage - 1}"><i class="fas fa-chevron-left"></i></button>`;

        const maxButtons = 7;
        let startPage = Math.max(1, currentPage - Math.floor(maxButtons / 2));
        let endPage = Math.min(totalPages, startPage + maxButtons - 1);
        if (endPage - startPage < maxButtons - 1) startPage = Math.max(1, endPage - maxButtons + 1);

        if (startPage > 1) {
            html += `<button data-page="1">1</button>`;
            if (startPage > 2) html += `<span style="padding:0 4px">\u2026</span>`;
        }
        for (let i = startPage; i <= endPage; i++) {
            html += `<button data-page="${i}" class="${i === currentPage ? 'active' : ''}">${i}</button>`;
        }
        if (endPage < totalPages) {
            if (endPage < totalPages - 1) html += `<span style="padding:0 4px">\u2026</span>`;
            html += `<button data-page="${totalPages}">${totalPages}</button>`;
        }

        html += `<button ${currentPage === totalPages ? 'disabled' : ''} data-page="${currentPage + 1}"><i class="fas fa-chevron-right"></i></button>`;
        pag.innerHTML = html;
    }

    // --- Map markers ---
    function addMapMarkers(features) {
        clusterGroup.clearLayers();
        markerMap.clear();
        const markers = [];
        features.forEach(f => {
            if (!f.geometry || !Array.isArray(f.geometry.coordinates)) return;
            const coords = f.geometry.coordinates;
            const lat = coords[1], lng = coords[0];
            if (!isFinite(lat) || !isFinite(lng)) return;
            const p = f.properties;
            const color = markerColor(p);
            const marker = L.marker([lat, lng], { icon: createCircleIcon(color) });
            marker.bindPopup(() => createPopupContent(p), { maxWidth: 300 });
            marker.on('click', () => selectFeature(p.GlobalID));
            marker.featureGlobalID = p.GlobalID;
            markers.push(marker);
            markerMap.set(p.GlobalID, marker);
        });
        clusterGroup.addLayers(markers);
    }

    function updateMapMarkers() {
        addMapMarkers(filteredFeatures);
    }

    function createPopupContent(p) {
        const days = daysUntilExpiry(p.ExpiryDate);
        const ec = expiryClass(days, p.ExpiryDate);
        const el = expiryLabel(days, p.ExpiryDate);
        const entityLabel = p.PrimaryConsentHolder ? 'Holder' : (p.LocalAuthority ? 'Local authority' : 'Holder');
        return `<div>
            <div class="popup-title">${p.ConsentID || 'Unknown'}</div>
            <div><span class="status-badge ${effectiveStatusClass(p)}">${p.Status}</span>
            ${ec ? `<span class="expiry-tag ${ec}">${el}</span>` : ''}</div>
            <div class="popup-detail" style="margin-top:6px"><strong>Region:</strong> ${p.Region || '\u2014'}</div>
            <div class="popup-detail"><strong>${entityLabel}:</strong> ${p.HolderDisplay || '\u2014'}</div>
            <div class="popup-detail"><strong>Address:</strong> ${p.SiteAddress || '\u2014'}</div>
            <div class="popup-detail"><strong>Purpose:</strong> ${p.Purpose || '\u2014'}</div>
            <div class="popup-detail"><strong>Expiry:</strong> ${formatDate(p.ExpiryDate)}</div>
            <div class="popup-detail"><strong>Type:</strong> ${p.Subtype || '\u2014'} / ${p.Category || '\u2014'}</div>
            ${p.PublicDocumentsLink ? `<a href="${p.PublicDocumentsLink}" target="_blank" class="popup-link"><i class="fas fa-external-link-alt"></i> View Documents</a>` : ''}
            <div class="popup-link" onclick="document.dispatchEvent(new CustomEvent('showDetail', {detail:'${p.GlobalID}'}))">View Full Details \u2192</div>
        </div>`;
    }



    // --- Detail Panel ---
    function selectFeature(globalID) {
        // Reset previous selected marker icon
        if (selectedFeatureId && markerMap.has(selectedFeatureId)) {
            const prevMarker = markerMap.get(selectedFeatureId);
            const prevFeature = allFeatures.find(f => f.properties.GlobalID === selectedFeatureId);
            if (prevFeature) prevMarker.setIcon(createCircleIcon(markerColor(prevFeature.properties), false));
        }
        selectedFeatureId = globalID;
        const f = allFeatures.find(f => f.properties.GlobalID === globalID);
        if (!f) return;
        // Highlight selected marker
        const marker = markerMap.get(globalID);
        if (marker) marker.setIcon(createCircleIcon(markerColor(f.properties), true));
        showDetailPanel(f.properties, f.geometry);
        // Highlight table row
        $$('#consentsTable tbody tr').forEach(tr => {
            tr.classList.remove('selected');
            tr.setAttribute('aria-selected', 'false');
        });
        const row = document.querySelector(`tr[data-gid="${globalID}"]`);
        if (row) {
            row.classList.add('selected');
            row.setAttribute('aria-selected', 'true');
            row.scrollIntoView({ block: 'nearest' });
        }
    }

    function showDetailPanel(p, geom) {
        const panel = $('#detailPanel');
        panel.classList.remove('hidden');
        $('#detailTitle').textContent = p.ConsentID || 'Consent Details';

        // Watchlist star in header
        const watched = isWatched(p.GlobalID);
        const starEl = $('#detailStar');
        if (starEl) {
            starEl.className = watched ? 'fas fa-star detail-star watched' : 'far fa-star detail-star';
            starEl.dataset.gid = p.GlobalID;
        }

        const days = daysUntilExpiry(p.ExpiryDate);
        const ec = expiryClass(days, p.ExpiryDate);
        const el = expiryLabel(days, p.ExpiryDate);

        const hbdcFields = p.SourceDataset === 'HBDC' ? [
            ['Local Authority', p.LocalAuthority],
            ['Application Historic ID', p.ApplicationHistoricID],
            ['Workflow ID', p.WorkflowID],
            ['Primary Industry', p.AuthPrimaryIndustry || p.ActPrimaryIndustry],
            ['Secondary Industry', p.AuthSecondaryIndustry || p.ActSecondaryIndustry],
            ['Legal Description 1', p.AuthorisationLegal1],
            ['Legal Description 2', p.AuthorisationLegal2],
            ['Water Meter Required', p.WaterMeterRequired],
            ['Water Meter Installed', p.WaterMeterInstalled],
            ['Date Water Meter Required', formatDate(p.DateWaterMeterRequired)],
            ['Well Number', p.WellNumber]
        ] : [];

        const fields = [
            ['Status', `<span class="status-badge ${effectiveStatusClass(p)}">${p.Status || '\u2014'}</span>${ec ? ` <span class="expiry-tag ${ec}">${el}</span>` : ''}`],
            ['Region', p.Region],
            ['Consent ID', p.ConsentID],
            ['Project Number', p.ProjectNumber],
            ['Primary Consent Holder', p.PrimaryConsentHolder],
            ['Holder Address', p.PrimaryConsentHolderAddress],
            ['Local Authority', p.LocalAuthority],
            ['Site Address', p.SiteAddress],
            ['Purpose', p.Purpose],
            ['_divider'],
            ['Subtype', p.Subtype],
            ['Category', p.Category],
            ['Water Management Zone', p.WaterManagementZone],
            ['Water Management Area', p.WaterManagementArea],
            ['_divider'],
            ['Granted Date', formatDate(p.GrantedDate)],
            ['Lodged Date', formatDate(p.LodgedDate)],
            ['Expiry Date', formatDate(p.ExpiryDate) + (ec ? ` <span class="expiry-tag ${ec}">${el}</span>` : '')],
            ['Status Date', formatDate(p.StatusDate)],
            ['_divider'],
            ['Compliance Officer', p.ComplianceOfficer],
            ['Deemed Permitted', p.DeemedPermitted],
            ['CAP ID', p.CapID],
            ['Factory Supply Number', p.FactorySupplyNumber],
            ...(hbdcFields.length ? [['_divider'], ...hbdcFields] : []),
            ['_divider'],
            ['Public Documents', p.PublicDocumentsLink ? `<a href="${p.PublicDocumentsLink}" target="_blank">${p.PublicDocumentsLink}</a>` : null],
            ['Coordinates', geom ? `${geom.coordinates[1].toFixed(6)}, ${geom.coordinates[0].toFixed(6)}` : null],
        ];

        let html = '';
        fields.forEach(([label, value]) => {
            if (label === '_divider') { html += '<hr class="detail-divider">'; return; }
            if (value === null || value === undefined || value === '') return;
            html += `<div class="detail-row"><div class="detail-label">${label}</div><div class="detail-value">${value}</div></div>`;
        });

        if (geom) {
            html += `<button class="detail-map-btn" onclick="document.dispatchEvent(new CustomEvent('flyTo', {detail:{lat:${geom.coordinates[1]},lng:${geom.coordinates[0]}}}))"><i class="fas fa-map-marker-alt"></i> Fly to on Map</button>`;
        }

        // Watchlist folder button
        const folders = getFoldersForConsent(p.GlobalID);
        const folderTags = folders.map(f => `<span class="wl-tag" style="background:${f.color}">${f.name}</span>`).join('');
        html += `<div class="detail-wl-section">
            <button class="detail-wl-btn" data-gid="${p.GlobalID}"><i class="fas fa-folder-plus"></i> Add to Folder</button>
            <div class="detail-wl-tags">${folderTags}</div>
        </div>`;

        $('#detailContent').innerHTML = html;

        // Bind add-to-folder button in detail panel
        const wlBtn = panel.querySelector('.detail-wl-btn');
        if (wlBtn) wlBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            showFolderPicker(wlBtn.dataset.gid);
        });
    }

    // --- Events ---
    function bindEvents() {
        $('#toggleFilters').setAttribute('aria-expanded', $('#sidebar').classList.contains('open') ? 'true' : 'false');

        // Search
        let searchTimeout;
        $('#globalSearch').addEventListener('input', () => {
            clearTimeout(searchTimeout);
            searchTimeout = setTimeout(applyFilters, 300);
        });

        // Filter changes
        const filterEls = '#regionFilter input, #filterStatus input, #filterExpiry input, #filterSubtype input, #filterCategory input, #filterZone, #filterArea, #filterOfficer, #expiryFrom, #expiryTo, #grantedFrom, #grantedTo';
        document.querySelectorAll(filterEls).forEach(el => {
            el.addEventListener('change', applyFilters);
        });

        // Clear filters
        $('#clearFilters').addEventListener('click', resetAllFilters);

        // Toggle sidebar
        $('#toggleFilters').addEventListener('click', () => {
            $('#sidebar').classList.toggle('open');
            $('#toggleFilters').setAttribute('aria-expanded', $('#sidebar').classList.contains('open') ? 'true' : 'false');
            setTimeout(() => map.invalidateSize(), 350);
        });

        $('#activeFilters').addEventListener('click', e => {
            const btn = e.target.closest('button');
            if (!btn) return;
            if (btn.dataset.chipAction === 'clear-all') {
                resetAllFilters();
                return;
            }
            if (btn.dataset.chipType) clearFilterChip(btn.dataset.chipType, btn.dataset.chipValue);
        });

        $('#exportFilteredCsv').addEventListener('click', exportFilteredResults);

        // Accordion groups
        $$('.accordion-toggle').forEach(btn => {
            btn.addEventListener('click', () => {
                const group = btn.closest('.sidebar-group');
                if (!group) return;
                group.classList.toggle('open');
                btn.setAttribute('aria-expanded', group.classList.contains('open') ? 'true' : 'false');
            });
        });

        // Sort
        $$('#consentsTable th[data-sort]').forEach(th => {
            th.addEventListener('click', () => {
                const field = th.dataset.sort;
                if (sortField === field) { sortDir = sortDir === 'asc' ? 'desc' : 'asc'; }
                else { sortField = field; sortDir = 'asc'; }
                // Update icons
                $$('#consentsTable th i').forEach(i => i.className = 'fas fa-sort');
                th.querySelector('i').className = sortDir === 'asc' ? 'fas fa-sort-up' : 'fas fa-sort-down';
                sortFeatures();
                renderTable();
            });
        });

        // Pagination
        $('#pagination').addEventListener('click', e => {
            const btn = e.target.closest('button[data-page]');
            if (!btn || btn.disabled) return;
            currentPage = parseInt(btn.dataset.page);
            renderTable();
            $('.table-wrap').scrollTop = 0;
        });

        // Table row click (with star interception)
        $('#tableBody').addEventListener('click', e => {
            // Star icon click → open folder picker
            const star = e.target.closest('.wl-star');
            if (star) {
                e.stopPropagation();
                showFolderPicker(star.dataset.gid);
                return;
            }
            if (e.target.closest('.empty-reset-btn')) {
                resetAllFilters();
                return;
            }
            const row = e.target.closest('tr');
            if (!row) return;
            const gid = row.dataset.gid;
            selectFeature(gid);
            // Pan to marker on map — only zoom in, never zoom out
            const marker = markerMap.get(gid);
            if (marker) {
                const currentZoom = map.getZoom();
                const targetZoom = Math.max(currentZoom, 14);
                map.setView(marker.getLatLng(), targetZoom);
                marker.openPopup();
            }
        });
        $('#tableBody').addEventListener('keydown', e => {
            const row = e.target.closest('tr[data-gid]');
            if (!row) return;
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                row.click();
            }
        });

        // Close detail
        $('#closeDetail').addEventListener('click', () => {
            // Reset selected marker icon
            if (selectedFeatureId && markerMap.has(selectedFeatureId)) {
                const prevMarker = markerMap.get(selectedFeatureId);
                const prevFeature = allFeatures.find(f => f.properties.GlobalID === selectedFeatureId);
                if (prevFeature) prevMarker.setIcon(createCircleIcon(markerColor(prevFeature.properties), false));
            }
            $('#detailPanel').classList.add('hidden');
            selectedFeatureId = null;
            $$('#consentsTable tbody tr').forEach(tr => {
                tr.classList.remove('selected');
                tr.setAttribute('aria-selected', 'false');
            });
        });

        // Custom events from popup
        document.addEventListener('showDetail', e => selectFeature(e.detail));
        document.addEventListener('flyTo', e => {
            map.flyTo([e.detail.lat, e.detail.lng], 16, { duration: 1 });
        });

        // Alert badge clicks
        $('#alertBadges').addEventListener('click', e => {
            const badge = e.target.closest('.alert-badge');
            if (!badge) return;
            const val = badge.dataset.filter;
            // Clear existing expiry filters, set this one
            $$('#filterExpiry input').forEach(cb => cb.checked = false);
            const cb = document.querySelector(`#filterExpiry input[value="${val}"]`);
            if (cb) cb.checked = true;
            // Also clear status filters if clicking expired
            if (val === 'expired') {
                $$('#filterStatus input').forEach(cb => cb.checked = false);
            }
            applyFilters();
        });

        // View toggle buttons
        const viewBtns = { split: $('#viewSplit'), map: $('#viewMap'), table: $('#viewTable') };
        function setViewMode(mode) {
            const content = $('#content');
            content.classList.remove('view-map', 'view-table');
            // Clear any inline styles set by drag-resize
            $('#map-container').style.flex = '';
            $('#map-container').style.height = '';
            $('#table-container').style.flex = '';
            if (mode === 'map') content.classList.add('view-map');
            else if (mode === 'table') content.classList.add('view-table');
            Object.values(viewBtns).forEach(b => b.classList.remove('active'));
            viewBtns[mode].classList.add('active');
            setTimeout(() => map.invalidateSize(), 100);
        }
        $('#viewSplit').addEventListener('click', () => setViewMode('split'));
        $('#viewMap').addEventListener('click', () => setViewMode('map'));
        $('#viewTable').addEventListener('click', () => setViewMode('table'));

        // --- Watchlist sidebar events ---
        // Create folder
        $('#wlCreateFolder').addEventListener('click', () => {
            const name = prompt('New folder name:');
            if (!name || !name.trim()) return;
            createFolder(name.trim());
            renderWatchlistSidebar();
        });

        // Folder click (filter), rename, color, delete
        $('#watchlistFolders').addEventListener('click', e => {
            const action = e.target.closest('[data-action]');
            if (action) {
                e.stopPropagation();
                const fid = action.dataset.fid;
                if (action.dataset.action === 'rename') {
                    const folder = watchlist.folders.find(f => f.id === fid);
                    if (!folder) return;
                    const name = prompt('Rename folder:', folder.name);
                    if (name && name.trim()) { renameFolder(fid, name.trim()); renderWatchlistSidebar(); }
                } else if (action.dataset.action === 'color') {
                    const folder = watchlist.folders.find(f => f.id === fid);
                    if (!folder) return;
                    const color = prompt('Hex color (e.g. #ef4444):', folder.color);
                    if (color && color.trim()) { recolorFolder(fid, color.trim()); renderWatchlistSidebar(); renderTable(); }
                } else if (action.dataset.action === 'delete') {
                    if (!confirm('Delete this folder? Consents won\'t be deleted.')) return;
                    deleteFolder(fid);
                    renderWatchlistSidebar();
                    applyFilters();
                }
                return;
            }
            // Click on folder row → toggle filter
            const folderEl = e.target.closest('.wl-folder');
            if (folderEl) {
                const fid = folderEl.dataset.fid;
                if (activeWatchlistFolder === fid) {
                    activeWatchlistFolder = null;
                } else {
                    activeWatchlistFolder = fid;
                }
                renderWatchlistSidebar();
                applyFilters();
            }
        });

        // Export
        $('#wlExport').addEventListener('click', exportWatchlist);

        // Import
        $('#wlImport').addEventListener('click', () => $('#wlImportFile').click());
        $('#wlImportFile').addEventListener('change', e => {
            if (e.target.files[0]) importWatchlist(e.target.files[0]);
            e.target.value = '';
        });

        // Detail star click
        document.addEventListener('click', e => {
            if (e.target.closest('.detail-star')) {
                const gid = e.target.closest('.detail-star').dataset.gid;
                if (gid) showFolderPicker(gid);
            }
        });
        document.addEventListener('keydown', e => {
            if (e.key === 'Escape' && !$('#detailPanel').classList.contains('hidden')) {
                $('#closeDetail').click();
            }
        });

        // Close folder picker when clicking outside
        document.addEventListener('click', e => {
            const picker = $('#folderPicker');
            if (!picker.classList.contains('hidden') && !e.target.closest('#folderPicker') && !e.target.closest('.wl-star') && !e.target.closest('.detail-star') && !e.target.closest('.detail-wl-btn')) {
                picker.classList.add('hidden');
            }
        });

        // Drag-to-resize handle
        const handle = $('#resizeHandle');
        const contentEl = $('#content');
        let dragging = false;
        handle.addEventListener('mousedown', e => {
            e.preventDefault();
            dragging = true;
            handle.classList.add('dragging');
            document.body.style.cursor = 'row-resize';
            document.body.style.userSelect = 'none';
        });
        document.addEventListener('mousemove', e => {
            if (!dragging) return;
            const contentRect = contentEl.getBoundingClientRect();
            // Account for the view toggle bar height
            const toggleBarHeight = $('#viewToggleBar').offsetHeight;
            const handleHeight = handle.offsetHeight;
            const relativeY = e.clientY - contentRect.top - toggleBarHeight;
            const totalHeight = contentRect.height - toggleBarHeight - handleHeight;
            const mapRatio = Math.max(0.1, Math.min(0.9, relativeY / totalHeight));
            $('#map-container').style.flex = 'none';
            $('#map-container').style.height = (mapRatio * totalHeight) + 'px';
            $('#table-container').style.flex = '1';
            map.invalidateSize();
        });
        document.addEventListener('mouseup', () => {
            if (!dragging) return;
            dragging = false;
            handle.classList.remove('dragging');
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
        });
    }

    // --- Boot ---
    loadData();

})();