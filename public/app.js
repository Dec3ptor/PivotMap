// === Regional Resource Consents App ===
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
    let REGION_OPTIONS = []; // IDs of the regions whose data loaded, in manifest order
    let dataSources = [];    // manifest entries for every region, plus load results

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
    // Status words that mean "actively valid" across all regional councils:
    // BOPRC/HBDC/TRC use "Current"; GDC uses "Active" and "Granted"; GWRC uses "Active"
    // (scripts/regions.mjs already maps Active/Granted to "Current" when building the data)
    const ACTIVE_STATUSES = new Set(['current', 'active', 'granted']);

    // Fields every consent has once loaded ('' when a region doesn't publish it).
    // Keep in sync with COMMON_FIELDS in scripts/regions.mjs.
    const COMMON_FIELDS = [
        'ConsentID', 'ProjectNumber', 'Status', 'PrimaryConsentHolder', 'HolderDisplay',
        'PrimaryConsentHolderAddress', 'LocalAuthority', 'SiteAddress', 'Purpose', 'Subtype',
        'Category', 'WaterManagementZone', 'WaterManagementArea', 'ComplianceOfficer',
        'GrantedDate', 'LodgedDate', 'ExpiryDate', 'StatusDate', 'CapID', 'FactorySupplyNumber',
        'PublicDocumentsLink', 'DeemedPermitted', 'GlobalID'
    ];
    const DATA_DIR = 'data/';
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
                const validFolder = f => f && typeof f.name === 'string' && Array.isArray(f.consents)
                    && f.consents.every(c => typeof c === 'string');
                if (!imported.folders.every(validFolder)) throw new Error('Invalid format');
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

    // --- HTML safety ---
    // Consent data comes from third-party council services and watchlists can be imported
    // from files, so escape every value before putting it into HTML.
    const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    function escapeHtml(value) {
        return value == null ? '' : String(value).replace(/[&<>"']/g, ch => HTML_ESCAPES[ch]);
    }
    // Only let http(s) links from the data become clickable hrefs.
    function safeUrl(url) {
        return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : '';
    }

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
    const DAY_MS = 24 * 60 * 60 * 1000;
    const TODAY = new Date();
    TODAY.setHours(0, 0, 0, 0);

    // Dates in the data are calendar dates ('YYYY-MM-DD'). Read them as local midnight so
    // expiry maths counts whole days in the viewer's timezone (a consent expiring yesterday
    // is expired first thing this morning, not at midday when UTC catches up).
    function parseDate(value) {
        if (!value) return null;
        const m = typeof value === 'string' && value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(value);
        return Number.isNaN(d.getTime()) ? null : d;
    }

    function daysUntilExpiry(dateStr) {
        const d = parseDate(dateStr);
        return d ? Math.round((d - TODAY) / DAY_MS) : null;
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

    // Returns HTML-safe text.
    function formatDate(dateStr) {
        if (!dateStr) return '—';
        const d = parseDate(dateStr);
        return d ? d.toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric' }) : escapeHtml(dateStr);
    }

    function formatShortDate(dateStr) {
        return dateStr ? formatDate(dateStr) : '';
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

    // Expand a compact region file (written by scripts/update-data.mjs) into GeoJSON-style
    // features: { region, fields, constants, records: [[lng, lat, ...values in `fields` order]] }
    function expandRegionData(data) {
        const region = data.region;
        const fields = data.fields || [];
        const constants = data.constants || {};
        return (data.records || []).map(row => {
            const properties = {};
            for (const field of COMMON_FIELDS) properties[field] = '';
            Object.assign(properties, constants);
            for (let i = 0; i < fields.length; i++) properties[fields[i]] = row[i + 2];
            if (!properties.GlobalID) properties.GlobalID = `${region}:${properties.ConsentID}`;
            properties.Region = region;
            properties.SourceDataset = region;
            return { type: 'Feature', geometry: { type: 'Point', coordinates: [row[0], row[1]] }, properties };
        });
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
    // data/manifest.json lists each region's data file; both are written by scripts/update-data.mjs.
    async function fetchJson(url, options) {
        const resp = await fetch(url, options);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return resp.json();
    }

    function setLoadingMessage(text) {
        const el = $('#loadingMessage');
        if (el) el.textContent = text;
    }

    function showLoadError(message) {
        $('#loadingOverlay').innerHTML = `
            <div class="load-error">
                <h2>Couldn't load consent data</h2>
                <p>${escapeHtml(message)}</p>
                <button type="button" class="btn-secondary" id="retryLoad"><i class="fas fa-rotate-right"></i> Try again</button>
            </div>`;
        $('#retryLoad').addEventListener('click', () => location.reload());
    }

    async function loadData() {
        let manifest;
        try {
            // Always revalidate the manifest; region files are cache-busted by their content hash.
            manifest = await fetchJson(`${DATA_DIR}manifest.json`, { cache: 'no-cache' });
        } catch (e) {
            console.error('Failed to load data manifest:', e);
            showLoadError(location.protocol === 'file:'
                ? 'This page has to be served by a web server. From the project folder run "npm start", then open http://localhost:8080/.'
                : `The data index could not be downloaded (${e.message}). Check your connection and try again.`);
            return;
        }

        const sources = Array.isArray(manifest.regions) ? manifest.regions : [];
        let finished = 0;
        const progress = () => setLoadingMessage(`Loading consent data\u2026 ${finished} of ${sources.length} regions`);
        progress();
        const results = await Promise.all(sources.map(async source => {
            try {
                const version = encodeURIComponent(source.hash || source.fetchedAt || '');
                const features = expandRegionData(await fetchJson(`${DATA_DIR}${source.file}?v=${version}`));
                return { ...source, features };
            } catch (e) {
                console.error(`Failed to load ${source.id} data:`, e);
                return { ...source, features: [], error: e.message || String(e) };
            } finally {
                finished++;
                progress();
            }
        }));

        const available = results.filter(r => !r.error);
        dataSources = results.map(({ features, ...source }) => ({ ...source, loadedCount: features.length }));
        if (!available.length) {
            showLoadError('None of the regional datasets could be downloaded. Please try again later.');
            return;
        }
        REGION_OPTIONS = available.map(r => r.id);
        allFeatures = available.flatMap(r => r.features);
        initApp();
    }

    // --- Data sources ---
    function formatTimestamp(value) {
        const d = value ? new Date(value) : null;
        return d && !Number.isNaN(d.getTime())
            ? d.toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric' })
            : '';
    }

    function renderRegionFilter() {
        $('#regionFilter').innerHTML = '<span class="topbar-filter-label">Region</span>' + dataSources
            .filter(s => !s.error)
            .map(s => `<label class="region-pill" title="${escapeHtml(s.name)}"><input type="checkbox" value="${escapeHtml(s.id)}" checked /> <span>${escapeHtml(s.id)}</span></label>`)
            .join('');
    }

    function renderDataSources() {
        // Headline date: the oldest region, so the label never overstates how fresh the data is.
        const times = dataSources
            .filter(s => !s.error && s.fetchedAt)
            .map(s => new Date(s.fetchedAt).getTime())
            .filter(t => !Number.isNaN(t));
        const failed = dataSources.filter(s => s.error);
        $('#dataUpdatedLabel').textContent = times.length ? `Data: ${formatTimestamp(Math.min(...times))}` : 'Data sources';
        $('#dataInfoBtn').classList.toggle('has-warning', failed.length > 0);
        $('#dataInfoBtn').title = failed.length
            ? `Data sources: ${failed.map(s => s.id).join(', ')} failed to load`
            : 'Data sources and update dates';
        $('#dataInfoBody').innerHTML = dataSources.map(s => {
            const council = safeUrl(s.source)
                ? `<a href="${escapeHtml(s.source)}" target="_blank" rel="noopener">${escapeHtml(s.name)}</a>`
                : escapeHtml(s.name);
            const count = s.error
                ? '<span class="data-source-failed">Failed to load</span>'
                : s.loadedCount.toLocaleString();
            return `<tr><td><strong>${escapeHtml(s.id)}</strong></td><td>${council}</td><td class="num">${count}</td><td>${escapeHtml(formatTimestamp(s.fetchedAt)) || '\u2014'}</td></tr>`;
        }).join('');
    }

    function setDataInfoOpen(open) {
        // Anchor the panel below its button (the top bar's height varies with screen width).
        if (open) {
            const rect = $('#dataInfoBtn').getBoundingClientRect();
            const panel = $('#dataInfoPanel');
            const top = Math.round(rect.bottom) + 6;
            panel.style.top = `${top}px`;
            panel.style.right = `${Math.max(16, Math.round(window.innerWidth - rect.right))}px`;
            panel.style.maxHeight = `calc(100vh - ${top + 16}px)`;
        }
        $('#dataInfoPanel').classList.toggle('hidden', !open);
        $('#dataInfoBtn').setAttribute('aria-expanded', open ? 'true' : 'false');
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
                const fid = escapeHtml(f.id);
                return `<div class="wl-folder${active}" data-fid="${fid}">
                    <div class="wl-folder-color" style="background:${escapeHtml(f.color)}"></div>
                    <div class="wl-folder-info">
                        <span class="wl-folder-name">${escapeHtml(f.name)}</span>
                        <span class="wl-folder-count">${f.consents.length} consent${f.consents.length !== 1 ? 's' : ''}</span>
                    </div>
                    <div class="wl-folder-actions">
                        <button class="wl-btn" data-action="rename" data-fid="${fid}" title="Rename"><i class="fas fa-pen"></i></button>
                        <button class="wl-btn" data-action="color" data-fid="${fid}" title="Change color"><i class="fas fa-palette"></i></button>
                        <button class="wl-btn wl-btn-danger" data-action="delete" data-fid="${fid}" title="Delete"><i class="fas fa-trash"></i></button>
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
                    <input type="checkbox" data-fid="${escapeHtml(f.id)}" ${inFolder ? 'checked' : ''} />
                    <div class="wl-folder-color" style="background:${escapeHtml(f.color)}"></div>
                    <span>${escapeHtml(f.name)}</span>
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
        renderRegionFilter();
        renderDataSources();
        buildFilters();
        renderWatchlistSidebar();
        applyFilters(); // also builds the alert badges and map markers
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
            `<label class="cb"><input type="checkbox" value="${escapeHtml(s)}" /> <span class="badge ${statusClass(s).replace('status-', 'badge-')}">${escapeHtml(s)}</span></label>`
        ).join('');

        $('#filterSubtype').innerHTML = subtypes.map(s =>
            `<label class="cb"><input type="checkbox" value="${escapeHtml(s)}" /> ${escapeHtml(s)}</label>`
        ).join('');

        $('#filterCategory').innerHTML = categories.map(s =>
            `<label class="cb"><input type="checkbox" value="${escapeHtml(s)}" /> ${escapeHtml(s)}</label>`
        ).join('');

        populateSelect('#filterZone', zones);
        populateSelect('#filterArea', areas);
        populateSelect('#filterOfficer', officers);
    }

    function populateSelect(sel, items) {
        const el = $(sel);
        const first = el.options[0].outerHTML;
        el.innerHTML = first + items.map(i => `<option value="${escapeHtml(i)}">${escapeHtml(i)}</option>`).join('');
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
            expiryFrom: parseDate($('#expiryFrom').value),
            expiryTo: parseDate($('#expiryTo').value),
            grantedFrom: parseDate($('#grantedFrom').value),
            grantedTo: parseDate($('#grantedTo').value),
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
            return `<button type="button" class="filter-chip" data-chip-type="${chip.type}" data-chip-value="${value}" title="Remove filter"><span>${escapeHtml(chip.label)}</span><i class="fas fa-times"></i></button>`;
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
            if (expiryFrom || expiryTo) {
                const expiry = parseDate(p.ExpiryDate);
                if (expiry && expiryFrom && expiry < expiryFrom) return false;
                if (expiry && expiryTo && expiry > expiryTo) return false;
            }
            // Granted date range
            if (grantedFrom || grantedTo) {
                const granted = parseDate(p.GrantedDate);
                if (granted && grantedFrom && granted < grantedFrom) return false;
                if (granted && grantedTo && granted > grantedTo) return false;
            }

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
                va = parseDate(va)?.getTime() ?? 0;
                vb = parseDate(vb)?.getTime() ?? 0;
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
            const docsUrl = safeUrl(p.PublicDocumentsLink);
            return `<tr data-gid="${escapeHtml(gid)}" class="${selected}" tabindex="0" aria-selected="${gid === selectedFeatureId ? 'true' : 'false'}">
                <td class="star-cell"><i class="${starCls}" data-gid="${escapeHtml(gid)}" title="Add to watchlist"></i></td>
                <td>${escapeHtml(p.ConsentID) || '\u2014'}</td>
                <td><span class="status-badge ${sc}">${escapeHtml(p.Status) || '\u2014'}</span></td>
                <td>${escapeHtml(p.HolderDisplay) || '\u2014'}</td>
                <td class="address-cell" title="${escapeHtml(p.SiteAddress)}">${escapeHtml(p.SiteAddress) || '\u2014'}</td>
                <td class="purpose-cell" title="${escapeHtml(p.Purpose)}">${escapeHtml(p.Purpose) || '\u2014'}</td>
                <td>${escapeHtml(p.Subtype) || '\u2014'}</td>
                <td>${escapeHtml(p.Category) || '\u2014'}</td>
                <td>${formatDate(p.ExpiryDate)}${ec ? ` <span class="expiry-tag ${ec}">${el}</span>` : ''}</td>
                <td>${formatDate(p.GrantedDate)}</td>
                <td>${docsUrl ? `<a href="${escapeHtml(docsUrl)}" target="_blank" rel="noopener" class="docs-link" title="View documents" onclick="event.stopPropagation()"><i class="fas fa-external-link-alt"></i></a>` : '\u2014'}</td>
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
        const docsUrl = safeUrl(p.PublicDocumentsLink);
        const container = document.createElement('div');
        container.innerHTML = `
            <div class="popup-title">${escapeHtml(p.ConsentID) || 'Unknown'}</div>
            <div><span class="status-badge ${effectiveStatusClass(p)}">${escapeHtml(p.Status)}</span>
            ${ec ? `<span class="expiry-tag ${ec}">${el}</span>` : ''}</div>
            <div class="popup-detail" style="margin-top:6px"><strong>Region:</strong> ${escapeHtml(p.Region) || '\u2014'}</div>
            <div class="popup-detail"><strong>${entityLabel}:</strong> ${escapeHtml(p.HolderDisplay) || '\u2014'}</div>
            <div class="popup-detail"><strong>Address:</strong> ${escapeHtml(p.SiteAddress) || '\u2014'}</div>
            <div class="popup-detail"><strong>Purpose:</strong> ${escapeHtml(p.Purpose) || '\u2014'}</div>
            <div class="popup-detail"><strong>Expiry:</strong> ${formatDate(p.ExpiryDate)}</div>
            <div class="popup-detail"><strong>Type:</strong> ${escapeHtml(p.Subtype) || '\u2014'} / ${escapeHtml(p.Category) || '\u2014'}</div>
            ${docsUrl ? `<a href="${escapeHtml(docsUrl)}" target="_blank" rel="noopener" class="popup-link"><i class="fas fa-external-link-alt"></i> View Documents</a>` : ''}
            <div class="popup-link popup-details-link" role="button" tabindex="0">View Full Details \u2192</div>`;
        const detailsLink = container.querySelector('.popup-details-link');
        detailsLink.addEventListener('click', () => selectFeature(p.GlobalID));
        detailsLink.addEventListener('keydown', e => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectFeature(p.GlobalID); }
        });
        return container;
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
        const row = document.querySelector(`tr[data-gid="${CSS.escape(globalID)}"]`);
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

        // Values are escaped when rendered; wrap pre-built markup in html() to insert it as-is.
        const html = (markup) => ({ html: markup });
        const docsUrl = safeUrl(p.PublicDocumentsLink);
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
            ['Date Water Meter Required', html(formatDate(p.DateWaterMeterRequired))],
            ['Well Number', p.WellNumber]
        ] : [];

        const fields = [
            ['Status', html(`<span class="status-badge ${effectiveStatusClass(p)}">${escapeHtml(p.Status) || '\u2014'}</span>${ec ? ` <span class="expiry-tag ${ec}">${el}</span>` : ''}`)],
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
            ['Granted Date', html(formatDate(p.GrantedDate))],
            ['Lodged Date', html(formatDate(p.LodgedDate))],
            ['Expiry Date', html(formatDate(p.ExpiryDate) + (ec ? ` <span class="expiry-tag ${ec}">${el}</span>` : ''))],
            ['Status Date', html(formatDate(p.StatusDate))],
            ['_divider'],
            ['Compliance Officer', p.ComplianceOfficer],
            ['Deemed Permitted', p.DeemedPermitted],
            ['CAP ID', p.CapID],
            ['Factory Supply Number', p.FactorySupplyNumber],
            ...(hbdcFields.length ? [['_divider'], ...hbdcFields] : []),
            ['_divider'],
            ['Public Documents', docsUrl ? html(`<a href="${escapeHtml(docsUrl)}" target="_blank" rel="noopener">${escapeHtml(docsUrl)}</a>`) : null],
            ['Coordinates', geom ? `${geom.coordinates[1].toFixed(6)}, ${geom.coordinates[0].toFixed(6)}` : null],
        ];

        let content = '';
        fields.forEach(([label, value]) => {
            if (label === '_divider') { content += '<hr class="detail-divider">'; return; }
            const valueHtml = value && typeof value === 'object' ? value.html : escapeHtml(value);
            if (!valueHtml) return;
            content += `<div class="detail-row"><div class="detail-label">${label}</div><div class="detail-value">${valueHtml}</div></div>`;
        });

        if (geom) {
            content += `<button class="detail-map-btn" onclick="document.dispatchEvent(new CustomEvent('flyTo', {detail:{lat:${geom.coordinates[1]},lng:${geom.coordinates[0]}}}))"><i class="fas fa-map-marker-alt"></i> Fly to on Map</button>`;
        }

        // Watchlist folder button
        const folders = getFoldersForConsent(p.GlobalID);
        const folderTags = folders.map(f => `<span class="wl-tag" style="background:${escapeHtml(f.color)}">${escapeHtml(f.name)}</span>`).join('');
        content += `<div class="detail-wl-section">
            <button class="detail-wl-btn" data-gid="${escapeHtml(p.GlobalID)}"><i class="fas fa-folder-plus"></i> Add to Folder</button>
            <div class="detail-wl-tags">${folderTags}</div>
        </div>`;

        $('#detailContent').innerHTML = content;

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

        // Custom event from the detail panel's "Fly to on Map" button
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
            if (e.key !== 'Escape') return;
            if (!$('#dataInfoPanel').classList.contains('hidden')) {
                setDataInfoOpen(false);
                $('#dataInfoBtn').focus();
            } else if (!$('#detailPanel').classList.contains('hidden')) {
                $('#closeDetail').click();
            }
        });

        // Data sources panel
        $('#dataInfoBtn').addEventListener('click', () => {
            setDataInfoOpen($('#dataInfoPanel').classList.contains('hidden'));
        });
        $('#closeDataInfo').addEventListener('click', () => setDataInfoOpen(false));
        document.addEventListener('click', e => {
            if (!$('#dataInfoPanel').classList.contains('hidden') && !e.target.closest('#dataInfoPanel') && !e.target.closest('#dataInfoBtn')) {
                setDataInfoOpen(false);
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