// === Consent Renewals ===
// Finds resource consents that are nearing expiry (renewal work), shows them on a map and
// in a list, and looks up the land parcel under any point on the map.

import {
    COMMON_FIELDS, DEFAULT_HIDDEN_WORK_TYPES, HOLDER_TYPES, HOLDER_TYPE_BY_ID, SORTS, STAGES, STAGE_BY_ID,
    WINDOWS, WINDOW_BY_ID, WORK_TYPES, WORK_TYPE_BY_ID, cleanText, countStages, dayNumber, describeTimeLeft,
    enrich, expandRegionData, filterConsents, freshwaterCapDate, groupByHolder, lodgeByDate, lodgementAdvice,
    searchTerms, sortConsents, toCsv, todayNumber
} from './consents.js';
import { formatArea, geometryBounds, lookupProperty, pointInGeometry } from './property.js';
import { PROPERTY_MIN_ZOOM, createMap } from './map.js';
import { createShortlist } from './shortlist.js';
import { councilShortName, escapeHtml, formatDate, formatNumber, formatTimestamp, plural, readableText, safeUrl, truncate } from './format.js';

const DATA_DIR = 'data/';
const PREFS_KEY = 'pivotmap.prefs.v1';
const HINT_KEY = 'pivotmap.mapHintDismissed';
const STALE_AFTER_DAYS = 3;
const PAGE_SIZE = 60;
const SITE_RADIUS_M = 60;        // "other consents at this site"
const NEARBY_RADIUS_M = 200;     // "nearby" on the property panel
const WINDOW_PHRASES = { '6m': 'in the next 6 months', '1y': 'in the next 12 months', '2y': 'in the next 2 years', '5y': 'in the next 5 years' };

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const defaultWorkTypes = () => new Set(WORK_TYPES.map(t => t.id).filter(id => !DEFAULT_HIDDEN_WORK_TYPES.includes(id)));
const defaultFilters = () => ({
    window: '2y',
    regions: null,          // Set of council ids; null = all
    workTypes: defaultWorkTypes(),
    holderTypes: null,      // Set; null = all
    holder: '',             // one holder, picked from the Holders tab
    search: '',
    firmOnly: false,
    hideLawExtended: false,
    includeRenewing: false,
    mapArea: false
});

const state = {
    all: [],
    byId: new Map(),
    councils: [],
    councilById: new Map(),
    today: todayNumber(),
    filters: defaultFilters(),
    sort: 'soonest',
    tab: 'consents',
    matched: [],            // consents passing the filters (shown on the map)
    results: [],            // matched, optionally limited to the map view, sorted
    shown: PAGE_SIZE,
    selectedId: null,
    sheetStack: [],         // [{ kind: 'consent', id } | { kind: 'property', lat, lng }]
    mapKey: '',
    baseLayer: 'Aerial + labels',
    boundaries: true
};

const shortlist = createShortlist();
let mapView = null;

// --- Small utilities ---
function setsEqual(a, b) {
    if (!a || !b) return a === b;
    if (a.size !== b.size) return false;
    for (const v of a) if (!b.has(v)) return false;
    return true;
}

function debounce(fn, ms) {
    let timer;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), ms);
    };
}

let toastTimer;
function toast(message, ms = 2600) {
    const el = $('#toast');
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

function stageStyle(p) {
    return `--stage:${STAGE_BY_ID[p._stage].color}`;
}

function councilName(regionId, short = true) {
    const council = state.councilById.get(regionId);
    if (!council) return regionId;
    return short ? council.short : council.name;
}

function isMobile() {
    return window.matchMedia('(max-width: 900px)').matches;
}

function setMobileView(view) {
    document.body.classList.toggle('view-map', view === 'map');
    $$('.mobile-switch button').forEach(b => b.classList.toggle('active', b.dataset.view === view));
    if (view === 'map' && mapView) setTimeout(() => mapView.invalidateSize(), 50);
}

async function copyText(text, done) {
    try {
        await navigator.clipboard.writeText(text);
        toast(done);
    } catch {
        toast("Couldn't copy — your browser blocked clipboard access");
    }
}

function downloadFile(filename, content, type) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// --- Preferences (this browser only) ---
function loadPrefs() {
    let prefs;
    try { prefs = JSON.parse(localStorage.getItem(PREFS_KEY) || 'null'); } catch { prefs = null; }
    if (!prefs || typeof prefs !== 'object') return;
    const f = state.filters;
    if (WINDOW_BY_ID[prefs.window]) f.window = prefs.window;
    if (Array.isArray(prefs.regions)) f.regions = new Set(prefs.regions);
    if (Array.isArray(prefs.workTypes)) f.workTypes = new Set(prefs.workTypes.filter(id => WORK_TYPE_BY_ID[id]));
    if (Array.isArray(prefs.holderTypes)) f.holderTypes = new Set(prefs.holderTypes.filter(id => HOLDER_TYPE_BY_ID[id]));
    for (const key of ['firmOnly', 'hideLawExtended', 'includeRenewing', 'mapArea']) {
        if (typeof prefs[key] === 'boolean') f[key] = prefs[key];
    }
    if (SORTS.some(s => s.id === prefs.sort)) state.sort = prefs.sort;
    if (typeof prefs.baseLayer === 'string') state.baseLayer = prefs.baseLayer;
    if (typeof prefs.boundaries === 'boolean') state.boundaries = prefs.boundaries;
}

function savePrefs() {
    const f = state.filters;
    const prefs = {
        window: f.window,
        regions: f.regions ? [...f.regions] : null,
        workTypes: [...f.workTypes],
        holderTypes: f.holderTypes ? [...f.holderTypes] : null,
        firmOnly: f.firmOnly, hideLawExtended: f.hideLawExtended, includeRenewing: f.includeRenewing, mapArea: f.mapArea,
        sort: state.sort, baseLayer: state.baseLayer, boundaries: state.boundaries
    };
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* private mode */ }
}

// --- Loading ---
async function fetchJson(url, options) {
    const res = await fetch(url, options);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
}

const nextFrame = () => new Promise(resolve => requestAnimationFrame(() => resolve()));

function setLoading(text) {
    const el = $('#loadingMessage');
    if (el) el.textContent = text;
}

function showLoadError(message) {
    $('#loading').innerHTML = `<div class="load-error"><h2>Couldn't load the consent data</h2><p>${escapeHtml(message)}</p>
        <button type="button" class="btn" id="retryLoad"><i class="fas fa-rotate-right"></i> Try again</button></div>`;
    $('#retryLoad').addEventListener('click', () => location.reload());
}

async function loadData() {
    if (!window.L || !L.markerClusterGroup) {
        showLoadError('The map library could not be downloaded. Check your connection (or any firewall blocking unpkg.com) and try again.');
        return;
    }
    let manifest;
    try {
        manifest = await fetchJson(`${DATA_DIR}manifest.json`, { cache: 'no-cache' });
    } catch (err) {
        showLoadError(location.protocol === 'file:'
            ? 'This page has to be served by a web server. From the project folder run "npm start", then open http://localhost:8080/.'
            : `The list of councils could not be downloaded (${err.message}). Check your connection and try again.`);
        return;
    }
    const sources = Array.isArray(manifest.regions) ? manifest.regions : [];
    let done = 0;
    const progress = () => setLoading(`Loading consents… ${done} of ${sources.length} councils`);
    progress();
    const loaded = await Promise.all(sources.map(async source => {
        try {
            const version = encodeURIComponent(source.hash || source.fetchedAt || '');
            const data = await fetchJson(`${DATA_DIR}${source.file}?v=${version}`);
            await nextFrame();
            const records = expandRegionData(data);
            for (const p of records) enrich(p, state.today);
            return { ...source, records };
        } catch (err) {
            console.error(`Failed to load ${source.id}`, err);
            return { ...source, records: [], error: err.message || String(err) };
        } finally {
            done++;
            progress();
        }
    }));

    state.councils = loaded.map(({ records, ...source }) => ({
        ...source,
        short: councilShortName(source.name) || source.id,
        loaded: records.length,
        holders: records.some(p => p._holder),
        expiries: records.some(p => p._expiry)
    }));
    state.councilById = new Map(state.councils.map(c => [c.id, c]));
    if (!loaded.some(r => !r.error)) {
        showLoadError('None of the councils\' data could be downloaded. Please try again later.');
        return;
    }
    state.all = loaded.flatMap(r => r.records);
    for (const p of state.all) state.byId.set(p.GlobalID, p);
    start();
}

// --- Start-up ---
function start() {
    const known = new Set(state.councils.filter(c => !c.error).map(c => c.id));
    if (state.filters.regions) {
        const kept = new Set([...state.filters.regions].filter(id => known.has(id)));
        state.filters.regions = kept.size && kept.size < known.size ? kept : null;
    }
    mapView = createMap($('#map'), {
        initialBaseLayer: state.baseLayer,
        boundariesOn: state.boundaries,
        onConsentClick: p => openConsent(p.GlobalID, { focus: false }),
        onMapClick: handleMapClick,
        onViewChange: handleMapMove,
        onBaseLayerChange: name => { state.baseLayer = name; savePrefs(); },
        onBoundariesToggle: on => { state.boundaries = on; savePrefs(); },
        onFitResults: () => mapView.fitTo(state.tab === 'shortlist' ? shortlistedConsents() : state.results)
    });
    renderWindowControl();
    bindEvents();
    renderDataPanel();
    applyFilters();
    $('#loading').classList.add('done');
    mapView.invalidateSize();
    openFromHash();
}

// --- Filtering ---
function filterSpec(overrides = {}) {
    const f = { ...state.filters, ...overrides };
    return {
        window: f.window,
        regions: f.regions,
        workTypes: f.workTypes,
        holderTypes: f.holderTypes,
        holder: f.holder || null,
        terms: searchTerms(f.search),
        firmOnly: f.firmOnly,
        hideLawExtended: f.hideLawExtended,
        includeRenewing: f.includeRenewing
    };
}

function specKey(spec) {
    return JSON.stringify(spec, (key, value) => (value instanceof Set ? [...value].sort() : value));
}

function stagesPresent(records) {
    const counts = countStages(records);
    return STAGES.filter(s => counts[s.id] > 0).map(s => s.id);
}

function applyFilters() {
    const spec = filterSpec();
    state.matched = filterConsents(state.all, spec);
    const key = specKey(spec);
    if (key !== state.mapKey) {
        state.mapKey = key;
        mapView.setConsents(state.matched);
        mapView.setLegend(stagesPresent(state.matched));
    }
    refreshResults();
    savePrefs();
}

function inView(p, b) {
    return p.lat >= b.south && p.lat <= b.north && p.lng >= b.west && p.lng <= b.east;
}

function refreshResults({ keepPage = false } = {}) {
    let results = state.matched;
    if (state.filters.mapArea) {
        const b = mapView.getBounds();
        results = results.filter(p => inView(p, b));
    } else {
        results = results.slice();
    }
    state.results = sortConsents(results, state.sort);
    if (!keepPage) state.shown = PAGE_SIZE;
    renderControls();
    renderSummary();
    renderTabs();
    renderList();
}

function filtersAreDefault() {
    const f = state.filters;
    const d = defaultFilters();
    return f.window === d.window && !f.regions && setsEqual(f.workTypes, d.workTypes) && !f.holderTypes && !f.holder
        && !f.firmOnly && !f.hideLawExtended && !f.includeRenewing;
}

function resetFilters() {
    const { search, mapArea } = state.filters;
    state.filters = { ...defaultFilters(), search, mapArea };
    closeDropdowns();
    applyFilters();
}

// --- Controls ---
function renderWindowControl() {
    $('#windowControl').innerHTML = WINDOWS.map(w => `<button type="button" role="radio" data-window="${w.id}"
        aria-checked="${w.id === state.filters.window}">${escapeHtml(w.label)}</button>`).join('');
}

const DROPDOWNS = {
    regions: {
        label() {
            const r = state.filters.regions;
            if (!r) return 'All councils';
            if (r.size === 1) return councilName([...r][0]);
            return `${r.size} councils`;
        },
        isSet: () => Boolean(state.filters.regions),
        icon: 'fa-landmark',
        menu: regionsMenu
    },
    work: {
        label() {
            const w = state.filters.workTypes;
            if (w.size === WORK_TYPES.length) return 'All types of work';
            if (setsEqual(w, defaultWorkTypes())) return 'All except small jobs';
            if (w.size === 1) return WORK_TYPE_BY_ID[[...w][0]].label;
            return w.size ? `${w.size} types of work` : 'No types of work';
        },
        isSet: () => !setsEqual(state.filters.workTypes, defaultWorkTypes()),
        icon: 'fa-helmet-safety',
        menu: workMenu
    },
    holders: {
        label() {
            const h = state.filters.holderTypes;
            if (!h) return 'All holders';
            if (h.size === 1) return HOLDER_TYPE_BY_ID[[...h][0]].label;
            return `${h.size} holder types`;
        },
        isSet: () => Boolean(state.filters.holderTypes),
        icon: 'fa-user-tie',
        menu: holdersMenu
    },
    more: {
        label() {
            const n = ['firmOnly', 'hideLawExtended', 'includeRenewing'].filter(k => state.filters[k]).length;
            return n ? `More (${n})` : 'More';
        },
        isSet: () => state.filters.firmOnly || state.filters.hideLawExtended || state.filters.includeRenewing,
        icon: 'fa-sliders',
        menu: moreMenu
    }
};

function renderControls() {
    $$('#windowControl button').forEach(b => b.setAttribute('aria-checked', String(b.dataset.window === state.filters.window)));
    for (const container of $$('[data-dropdown]')) {
        const id = container.dataset.dropdown;
        const def = DROPDOWNS[id];
        let button = $('.dropdown-btn', container);
        if (!button) {
            container.innerHTML = `<button type="button" class="dropdown-btn" aria-haspopup="true" aria-expanded="false" aria-controls="menu-${id}">
                <i class="fas ${def.icon}" aria-hidden="true"></i><span class="btn-text"></span><i class="fas fa-chevron-down caret" aria-hidden="true"></i></button>
                <div class="dropdown-menu" id="menu-${id}" hidden></div>`;
            button = $('.dropdown-btn', container);
        }
        $('.btn-text', button).textContent = def.label();
        button.classList.toggle('is-set', def.isSet());
        const menu = $('.dropdown-menu', container);
        if (!menu.hidden) updateMenu(id);
    }
    const chips = [];
    if (state.filters.holder) {
        chips.push(`<span class="chip"><span>Holder: ${escapeHtml(state.filters.holder)}</span><button type="button" data-action="clear-holder" aria-label="Show all holders"><i class="fas fa-xmark"></i></button></span>`);
    }
    if (!filtersAreDefault()) chips.push('<button type="button" class="link-btn" data-action="reset-filters"><i class="fas fa-rotate-left"></i> Reset filters</button>');
    $('#activeChips').innerHTML = chips.join('');
    $('#activeChips').hidden = !chips.length;
}

// Counts per option ignore that dropdown's own filter, so you can see what ticking it would add.
function countsBy(key, overrides) {
    const counts = new Map();
    for (const p of filterConsents(state.all, filterSpec(overrides))) counts.set(p[key], (counts.get(p[key]) || 0) + 1);
    return counts;
}

function checkRow({ name, value, checked, title, hint = '', count = null, icon = '' }) {
    return `<label class="check"><input type="checkbox" name="${name}" value="${escapeHtml(value)}"${checked ? ' checked' : ''}>
        <span class="check-body"><span class="check-title">${icon ? `<i class="fas ${icon}" aria-hidden="true"></i>` : ''}${escapeHtml(title)}
        ${count == null ? '' : `<span class="check-count">${formatNumber(count)}</span>`}</span>
        ${hint ? `<span class="check-hint">${escapeHtml(hint)}</span>` : ''}</span></label>`;
}

function regionsMenu() {
    const counts = countsBy('Region', { regions: null });
    const selected = state.filters.regions;
    const rows = state.councils.map(c => {
        let hint = '';
        if (c.error) hint = "Couldn't be loaded";
        else if (!c.expiries) hint = 'Publishes no expiry dates — shown under All only';
        else if (isStale(c)) hint = `Data last updated ${formatTimestamp(c.fetchedAt)}`;
        return checkRow({ name: 'region', value: c.id, checked: !selected || selected.has(c.id), title: c.short, hint, count: counts.get(c.id) || 0 });
    });
    return `<div class="menu-quick"><button type="button" data-quick="all">Select all</button><button type="button" data-quick="none">Clear</button></div>${rows.join('')}`;
}

function workMenu() {
    const counts = countsBy('_work', { workTypes: null });
    const selected = state.filters.workTypes;
    const row = t => checkRow({ name: 'work', value: t.id, checked: selected.has(t.id), title: t.label, hint: t.hint, count: counts.get(t.id) || 0, icon: t.icon });
    return `<div class="menu-quick"><button type="button" data-quick="all">Select all</button><button type="button" data-quick="default">Default</button><button type="button" data-quick="none">Clear</button></div>
        ${WORK_TYPES.filter(t => !t.minor).map(row).join('')}
        <div class="menu-group-label">Usually smaller jobs — hidden by default</div>
        ${WORK_TYPES.filter(t => t.minor).map(row).join('')}`;
}

function holdersMenu() {
    const counts = countsBy('_holderType', { holderTypes: null });
    const selected = state.filters.holderTypes;
    const named = state.councils.filter(c => c.holders).map(c => c.short);
    return `<div class="menu-quick"><button type="button" data-quick="all">Select all</button><button type="button" data-quick="none">Clear</button></div>
        ${HOLDER_TYPES.map(t => checkRow({ name: 'holder', value: t.id, checked: !selected || selected.has(t.id), title: t.label, count: counts.get(t.id) || 0 })).join('')}
        <p class="menu-note">Only ${escapeHtml(named.join(' and ') || 'some councils')} publish holder names. For other councils the type is a best guess from what the consent is for.</p>`;
}

function moreMenu() {
    const f = state.filters;
    return `${checkRow({ name: 'toggle', value: 'firmOnly', checked: f.firmOnly, title: 'Only firm expiry dates', hint: "Freshwater consents at their 35-year limit and wastewater network consents — the law changes can't push these out." })}
        ${checkRow({ name: 'toggle', value: 'hideLawExtended', checked: f.hideLawExtended, title: 'Hide 31 Dec 2027 extension dates', hint: 'Dates set by RMA s123C; many will likely be extended again under the Planning Act 2026.' })}
        ${checkRow({ name: 'toggle', value: 'includeRenewing', checked: f.includeRenewing, title: 'Include renewals already lodged', hint: 'Expired consents still operating under s124 while a replacement application is processed.' })}
        <p class="menu-note"><button type="button" class="link-btn" data-action="help-law">How the law changes affect expiry dates</button></p>`;
}

function fillMenu(id) {
    $(`#menu-${id}`).innerHTML = DROPDOWNS[id].menu();
}

// Refresh ticks and counts without rebuilding the open menu (keeps focus and scroll).
const MENU_COUNTS = {
    regions: () => [countsBy('Region', { regions: null }), v => !state.filters.regions || state.filters.regions.has(v)],
    work: () => [countsBy('_work', { workTypes: null }), v => state.filters.workTypes.has(v)],
    holders: () => [countsBy('_holderType', { holderTypes: null }), v => !state.filters.holderTypes || state.filters.holderTypes.has(v)],
    more: () => [null, v => Boolean(state.filters[v])]
};

function updateMenu(id) {
    const [counts, isChecked] = MENU_COUNTS[id]();
    for (const input of $$(`#menu-${id} input[type="checkbox"]`)) {
        input.checked = isChecked(input.value);
        const count = counts && input.closest('.check').querySelector('.check-count');
        if (count) count.textContent = formatNumber(counts.get(input.value) || 0);
    }
}

function openDropdown(id) {
    closeDropdowns(id);
    const container = $(`[data-dropdown="${id}"]`);
    const menu = $('.dropdown-menu', container);
    fillMenu(id);
    menu.hidden = false;
    $('.dropdown-btn', container).setAttribute('aria-expanded', 'true');
}

function closeDropdowns(except) {
    for (const container of $$('[data-dropdown]')) {
        if (container.dataset.dropdown === except) continue;
        const menu = $('.dropdown-menu', container);
        if (menu && !menu.hidden) {
            menu.hidden = true;
            $('.dropdown-btn', container).setAttribute('aria-expanded', 'false');
        }
    }
}

function handleMenuChange(id, input) {
    const f = state.filters;
    if (id === 'regions') {
        const all = state.councils.map(c => c.id);
        const set = f.regions ? new Set(f.regions) : new Set(all);
        input.checked ? set.add(input.value) : set.delete(input.value);
        f.regions = set.size === all.length ? null : set;
    } else if (id === 'work') {
        const set = new Set(f.workTypes);
        input.checked ? set.add(input.value) : set.delete(input.value);
        f.workTypes = set;
    } else if (id === 'holders') {
        const all = HOLDER_TYPES.map(t => t.id);
        const set = f.holderTypes ? new Set(f.holderTypes) : new Set(all);
        input.checked ? set.add(input.value) : set.delete(input.value);
        f.holderTypes = set.size === all.length ? null : set;
    } else if (id === 'more') {
        f[input.value] = input.checked;
    }
    applyFilters();
}

function handleMenuQuick(id, action) {
    const f = state.filters;
    if (id === 'regions') f.regions = action === 'all' ? null : new Set();
    if (id === 'work') f.workTypes = action === 'all' ? new Set(WORK_TYPES.map(t => t.id)) : action === 'none' ? new Set() : defaultWorkTypes();
    if (id === 'holders') f.holderTypes = action === 'all' ? null : new Set();
    applyFilters();
}

// --- Summary ---
function renderSummary() {
    const f = state.filters;
    const results = state.results;
    const win = WINDOW_BY_ID[f.window];
    let caption = win.maxDays == null ? 'consents of any status' : `current consents expiring ${WINDOW_PHRASES[f.window]}`;
    if (f.holder) caption += ` held by ${f.holder}`;
    if (f.mapArea) caption += ' in the map view';
    const counts = countStages(results);
    const stages = STAGES.filter(s => counts[s.id] > 0);
    const total = results.length || 1;
    const bar = stages.map(s => `<span style="width:${(counts[s.id] / total) * 100}%;background:${s.color}" title="${escapeHtml(s.label)}: ${formatNumber(counts[s.id])}"></span>`).join('');
    const legend = stages.map(s => `<span><i class="swatch" style="background:${s.color}"></i>${escapeHtml(s.label)} <b>${formatNumber(counts[s.id])}</b></span>`).join('');
    $('#summary').innerHTML = `
        <div class="summary-top">
            <div><div class="summary-count">${formatNumber(results.length)}</div><div class="summary-caption">${escapeHtml(caption)}</div></div>
            <div class="summary-actions"><button type="button" class="btn" data-action="export"${results.length ? '' : ' disabled'}><i class="fas fa-file-arrow-down"></i> Export</button></div>
        </div>
        ${results.length ? `<div class="stage-bar">${bar}</div><div class="stage-legend">${legend}</div>` : ''}
        <label class="map-area-toggle"><input type="checkbox" id="mapAreaToggle"${f.mapArea ? ' checked' : ''}> Only list consents in the map view</label>`;
}

function renderTabs() {
    $('#countConsents').textContent = formatNumber(state.results.length);
    const holderCount = new Set(state.results.map(p => p._holder).filter(Boolean)).size;
    $('#countHolders').textContent = formatNumber(holderCount);
    $('#countShortlist').textContent = shortlist.count() ? formatNumber(shortlist.count()) : '';
    $$('.tab').forEach(tab => {
        const active = tab.dataset.tab === state.tab;
        tab.classList.toggle('active', active);
        tab.setAttribute('aria-selected', String(active));
    });
    $('#listArea').setAttribute('aria-labelledby', `tab-${state.tab}`);
}

// --- Lists ---
function shortPurpose(p, max = 140) {
    return truncate(readableText(cleanText(p.Purpose)), max);
}

// Hawke's Bay and Horizons put the holder's industry in Category, not the activity.
const INDUSTRY_IN_CATEGORY = new Set(['HBDC', 'HRC']);

// Council consent types like "Resource Consent" or Gisborne's two-letter codes say little.
function typeLine(p) {
    const fields = INDUSTRY_IN_CATEGORY.has(p.Region) ? [p.Subtype] : [p.Subtype, p.Category];
    const parts = fields.map(v => cleanText(v))
        .filter(v => v && !/^(resource consent|consent|new|na|n\/a)$/i.test(v) && !/^[A-Z0-9]{2}$/.test(v));
    return [...new Set(parts)].join(' · ');
}

function cardTitle(p) {
    return p._holder || shortPurpose(p, 90) || typeLine(p) || WORK_TYPE_BY_ID[p._work].label;
}

function cardSubtitle(p) {
    if (p._holder) return shortPurpose(p) || typeLine(p);
    const purpose = shortPurpose(p, 90);
    return purpose && purpose !== cardTitle(p) ? purpose : typeLine(p);
}

function timeLabel(p) {
    if (p._status === 'renewing') return 'Renewal lodged';
    if (p._status !== 'live') return p.Status ? cleanText(p.Status) : 'Not current';
    if (p._stage === 'past') return 'Past expiry date';
    return describeTimeLeft(p._days);
}

function consentTags(p) {
    const tags = [];
    if (p._firm) tags.push(`<span class="tag tag-firm" title="${escapeHtml(p._firm === 'cap' ? 'At the 35-year limit for freshwater consents' : 'Wastewater network consents are excluded from the automatic extensions')}">Firm date</span>`);
    if (p._lawExtended && p._status === 'live') tags.push('<span class="tag tag-law" title="Extended to this date by RMA s123C">31 Dec 2027 extension</span>');
    return tags.join('');
}

function consentCard(p, { note = false } = {}) {
    const work = WORK_TYPE_BY_ID[p._work];
    const id = escapeHtml(p.GlobalID);
    const starred = shortlist.has(p.GlobalID);
    const meta = [councilName(p.Region), p.ConsentID, readableText(cleanText(p.SiteAddress))].filter(Boolean).join(' · ');
    const sub = cardSubtitle(p);
    const noteText = note ? shortlist.note(p.GlobalID) : '';
    return `<li class="card${p.GlobalID === state.selectedId ? ' selected' : ''}" style="${stageStyle(p)}">
        <button type="button" class="card-main" data-action="open" data-id="${id}">
            <span class="card-title"><i class="fas ${work.icon}" title="${escapeHtml(work.label)}" aria-hidden="true"></i><span>${escapeHtml(cardTitle(p))}</span></span>
            ${sub ? `<span class="card-sub">${escapeHtml(sub)}</span>` : ''}
            <span class="card-meta">${escapeHtml(meta)}</span>
            <span class="card-foot"><span class="pill">${escapeHtml(timeLabel(p))}</span>${p._expiry ? `<span class="date-text">${formatDate(p._expiry)}</span>` : ''}${consentTags(p)}</span>
            ${noteText ? `<span class="card-note"><i class="fas fa-pen"></i> ${escapeHtml(truncate(noteText, 160))}</span>` : ''}
        </button>
        <button type="button" class="star-btn${starred ? ' on' : ''}" data-action="star" data-id="${id}" aria-pressed="${starred}"
            aria-label="${starred ? 'Remove from shortlist' : 'Add to shortlist'}" title="${starred ? 'Remove from shortlist' : 'Add to shortlist'}"><i class="${starred ? 'fas' : 'far'} fa-star"></i></button>
    </li>`;
}

function moreButton(total) {
    if (state.shown >= total) return '';
    return `<div class="list-more" id="listMore"><button type="button" class="btn" data-action="more">Show ${formatNumber(Math.min(PAGE_SIZE, total - state.shown))} more of ${formatNumber(total - state.shown)}</button></div>`;
}

function emptyState(icon, title, text, action = '') {
    return `<div class="empty"><i class="fas ${icon}" aria-hidden="true"></i><h3>${escapeHtml(title)}</h3><p>${escapeHtml(text)}</p>${action}</div>`;
}

let listObserver;
function observeMore() {
    if (listObserver) listObserver.disconnect();
    const more = $('#listMore');
    if (!more || !('IntersectionObserver' in window)) return;
    listObserver = new IntersectionObserver(entries => {
        if (entries.some(e => e.isIntersecting)) showMore();
    }, { root: $('#panelScroll'), rootMargin: '400px' });
    listObserver.observe(more);
}

function showMore() {
    state.shown += PAGE_SIZE;
    renderList();
}

function renderList() {
    const area = $('#listArea');
    if (state.tab === 'holders') area.innerHTML = holdersListHtml();
    else if (state.tab === 'shortlist') area.innerHTML = shortlistHtml();
    else area.innerHTML = consentsListHtml();
    observeMore();
}

function consentsListHtml() {
    const results = state.results;
    if (!results.length) {
        const f = state.filters;
        const hint = f.search ? 'Try different search words, or clear the search.'
            : f.window !== 'all' && f.window !== '5y' ? 'Try a longer time window, or tick more councils and types of work.'
                : 'Try ticking more councils, types of work or holders.';
        return emptyState('fa-filter-circle-xmark', 'No consents match', hint,
            filtersAreDefault() ? '' : '<button type="button" class="btn" data-action="reset-filters"><i class="fas fa-rotate-left"></i> Reset filters</button>');
    }
    const sort = `<label>Sort <select id="sort" aria-label="Sort consents">${SORTS.map(s => `<option value="${s.id}"${s.id === state.sort ? ' selected' : ''}>${escapeHtml(s.label)}</option>`).join('')}</select></label>`;
    const showing = `Showing ${formatNumber(Math.min(state.shown, results.length))} of ${formatNumber(results.length)}`;
    return `<div class="list-toolbar"><span>${showing}</span>${sort}</div>
        <ul class="list">${results.slice(0, state.shown).map(p => consentCard(p)).join('')}</ul>${moreButton(results.length)}`;
}

function holdersListHtml() {
    const { holders, unnamed } = groupByHolder(state.results);
    const named = state.councils.filter(c => c.holders).map(c => c.short).join(' and ');
    const note = `<p class="list-note">Holders with the most consents in your selection. Names come from ${escapeHtml(named || 'the councils that publish them')}${unnamed ? `; ${plural(unnamed, 'consent')} here ha${unnamed === 1 ? 's' : 've'} no published holder` : ''}.</p>`;
    if (!holders.length) return note + emptyState('fa-users-slash', 'No named holders', 'None of the consents in your selection have a published holder name.');
    const cards = holders.slice(0, state.shown).map(h => {
        const soon = h.soonest;
        const works = [...h.works.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4)
            .map(([id, n]) => `<span title="${escapeHtml(WORK_TYPE_BY_ID[id].label)}"><i class="fas ${WORK_TYPE_BY_ID[id].icon}"></i> ${n}</span>`).join('');
        const next = soon ? `next ${describeTimeLeft(soon._days).replace(/^Expires /, 'expires ')} (${formatDate(soon._expiry)})` : 'no expiry dates';
        return `<li class="card holder-card" style="${soon ? stageStyle(soon) : '--stage:var(--ended)'}">
            <button type="button" class="card-main" data-action="holder" data-name="${escapeHtml(h.name)}">
                <span class="card-title"><i class="fas fa-building" aria-hidden="true"></i><span>${escapeHtml(h.name)}</span></span>
                <span class="card-sub">${plural(h.count, 'consent')} · ${escapeHtml(next)}</span>
                <span class="card-foot"><span class="tag tag-type">${escapeHtml(HOLDER_TYPE_BY_ID[h.type].label)}</span><span class="holder-icons">${works}</span>
                <span class="date-text">${escapeHtml([...h.regions].map(r => councilName(r)).join(', '))}</span></span>
            </button>
        </li>`;
    }).join('');
    return `${note}<ul class="list">${cards}</ul>${moreButton(holders.length)}`;
}

function shortlistedConsents() {
    return sortConsents(shortlist.ids().map(id => state.byId.get(id)).filter(Boolean), 'soonest');
}

function shortlistHtml() {
    const items = shortlistedConsents();
    const missing = shortlist.count() - items.length;
    if (!items.length) {
        return emptyState('fa-star', 'Your shortlist is empty', 'Star a consent to keep it here, with your own notes. The shortlist is saved in this browser.');
    }
    return `<div class="list-note" style="display:flex;justify-content:space-between;align-items:center;gap:8px">
            <span>Saved in this browser${missing ? ` · ${plural(missing, 'consent')} no longer in the data` : ''}</span>
            <span style="display:flex;gap:6px"><button type="button" class="btn btn-small" data-action="export-shortlist"><i class="fas fa-file-arrow-down"></i> Export</button>
            <button type="button" class="btn btn-small" data-action="clear-shortlist">Clear</button></span></div>
        <ul class="list">${items.map(p => consentCard(p, { note: true })).join('')}</ul>`;
}

function setTab(tab) {
    state.tab = tab;
    state.shown = PAGE_SIZE;
    renderTabs();
    renderList();
    $('#panelScroll').scrollTop = Math.min($('#panelScroll').scrollTop, $('.tabs').offsetTop);
}

function setHolderFilter(name) {
    state.filters.holder = name;
    state.tab = 'consents';
    applyFilters();
    $('#panelScroll').scrollTop = 0;
    mapView.fitTo(state.results);
}

// --- Spatial index (for "consents on this property" and "nearby") ---
const CELL_DEG = 0.002;
let grid = null;
function buildGrid() {
    grid = new Map();
    for (const p of state.all) {
        if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) continue;
        const key = `${Math.floor(p.lng / CELL_DEG)}:${Math.floor(p.lat / CELL_DEG)}`;
        let cell = grid.get(key);
        if (!cell) grid.set(key, cell = []);
        cell.push(p);
    }
}

function consentsInBounds({ west, south, east, north }) {
    if (!grid) buildGrid();
    const found = [];
    for (let x = Math.floor(west / CELL_DEG); x <= Math.floor(east / CELL_DEG); x++) {
        for (let y = Math.floor(south / CELL_DEG); y <= Math.floor(north / CELL_DEG); y++) {
            for (const p of grid.get(`${x}:${y}`) || []) if (inView(p, { west, south, east, north })) found.push(p);
        }
    }
    return found;
}

function distanceMetres(lat1, lng1, lat2, lng2) {
    const k = Math.PI / 180;
    const x = (lng2 - lng1) * k * Math.cos(((lat1 + lat2) / 2) * k);
    const y = (lat2 - lat1) * k;
    return Math.sqrt(x * x + y * y) * 6371000;
}

function consentsNear(lat, lng, metres) {
    const dLat = metres / 111320;
    const dLng = metres / (111320 * Math.cos((lat * Math.PI) / 180));
    return consentsInBounds({ west: lng - dLng, east: lng + dLng, south: lat - dLat, north: lat + dLat })
        .map(p => ({ p, d: distanceMetres(lat, lng, p.lat, p.lng) }))
        .filter(x => x.d <= metres)
        .sort((a, b) => a.d - b.d);
}

// Current consents first (soonest expiry), then the rest (most recent first).
function byRelevance(a, b) {
    const live = x => (x._status === 'live' || x._status === 'renewing' ? 0 : 1);
    return live(a) - live(b) || (live(a) === 0
        ? (a._expiry || '9999').localeCompare(b._expiry || '9999')
        : (b._expiry || '').localeCompare(a._expiry || ''));
}

function miniList(records, max = 12) {
    const rows = records.slice(0, max).map(p => `<li><button type="button" data-action="open" data-id="${escapeHtml(p.GlobalID)}">
        <span class="swatch" style="background:${STAGE_BY_ID[p._stage].color}"></span>
        <span class="mini-title">${escapeHtml(cardTitle(p))}</span>
        <span class="mini-date">${escapeHtml(p._status === 'live' && p._expiry ? formatDate(p._expiry) : timeLabel(p))}</span>
        <span class="mini-sub">${escapeHtml([WORK_TYPE_BY_ID[p._work].label, p.ConsentID, p._holder ? shortPurpose(p, 80) : ''].filter(Boolean).join(' · '))}</span>
    </button></li>`).join('');
    const more = records.length > max ? `<p class="muted" style="font-size:12.5px;margin-top:6px">and ${plural(records.length - max, 'more')}</p>` : '';
    return `<ul class="mini-list">${rows}</ul>${more}`;
}

// --- Sheets (consent details and property details) ---
const propertyCache = new Map();
let propertyRequest = null;

function pointKey(lat, lng) {
    return `${lat.toFixed(6)},${lng.toFixed(6)}`;
}

function fetchProperty(lat, lng) {
    const key = pointKey(lat, lng);
    if (!propertyCache.has(key)) {
        const promise = lookupProperty(lng, lat).catch(err => {
            propertyCache.delete(key);
            throw err;
        });
        propertyCache.set(key, promise);
        if (propertyCache.size > 60) propertyCache.delete(propertyCache.keys().next().value);
    }
    return propertyCache.get(key);
}

function currentSheet() {
    return state.sheetStack[state.sheetStack.length - 1] || null;
}

function showSheet() {
    const sheet = $('#sheet');
    sheet.hidden = false;
    const entry = currentSheet();
    $('#sheetBackLabel').textContent = state.sheetStack.length > 1
        ? (state.sheetStack[state.sheetStack.length - 2].kind === 'consent' ? 'Back to consent' : 'Back to property')
        : 'Back to list';
    if (entry.kind === 'consent') renderConsentSheet(state.byId.get(entry.id));
    else renderPropertySheet(entry);
    $('#sheetBody').scrollTop = 0;
    $('#sheetBody').focus({ preventScroll: true });
    if (isMobile()) setMobileView('list');
}

function closeSheet() {
    state.sheetStack = [];
    $('#sheet').hidden = true;
    state.selectedId = null;
    mapView.select(null);
    mapView.showParcel(null);
    $$('.card.selected').forEach(c => c.classList.remove('selected'));
    if (location.hash) history.replaceState(null, '', location.pathname + location.search);
}

function sheetBack() {
    state.sheetStack.pop();
    if (!state.sheetStack.length) {
        closeSheet();
        return;
    }
    const entry = currentSheet();
    if (entry.kind === 'consent') {
        const p = state.byId.get(entry.id);
        state.selectedId = p.GlobalID;
        mapView.select(p);
    }
    showSheet();
}

function openConsent(id, { focus = true, push = false } = {}) {
    const p = state.byId.get(id);
    if (!p) return;
    const entry = { kind: 'consent', id };
    if (push && state.sheetStack.length) state.sheetStack.push(entry);
    else state.sheetStack = [entry];
    state.selectedId = id;
    mapView.select(p);
    mapView.showParcel(null);
    if (focus) mapView.focusConsent(p, 16);
    $$('.card').forEach(card => card.classList.toggle('selected', $('[data-action="open"]', card)?.dataset.id === id));
    history.replaceState(null, '', `#consent=${encodeURIComponent(id)}`);
    showSheet();
}

function openPropertyAt(lat, lng, { push = false } = {}) {
    const entry = { kind: 'property', lat, lng };
    if (push && state.sheetStack.length) state.sheetStack.push(entry);
    else {
        state.sheetStack = [entry];
        state.selectedId = null;
        mapView.select(null);
        if (location.hash) history.replaceState(null, '', location.pathname + location.search);
    }
    showSheet();
}

function openFromHash() {
    const m = /^#consent=(.+)$/.exec(location.hash);
    if (!m) return;
    const id = decodeURIComponent(m[1]);
    if (state.byId.has(id)) openConsent(id, { focus: true });
}

function factRows(rows) {
    const html = rows.filter(([, value]) => value).map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${value}</dd>`).join('');
    return html ? `<dl class="facts">${html}</dl>` : '';
}

function timingHtml(p) {
    const stage = STAGE_BY_ID[p._stage];
    if (p._status !== 'live' && p._status !== 'renewing') {
        return `<div class="timing" style="${stageStyle(p)}"><div class="timing-head"><span class="timing-big">${escapeHtml(cleanText(p.Status) || 'Not current')}</span>
            ${p._expiry ? `<span class="timing-date">Expiry date ${formatDate(p._expiry)}</span>` : ''}</div>
            <p class="timing-advice">This consent is no longer current, so it isn't a renewal opportunity — but it shows what has been consented at this site.</p></div>`;
    }
    if (!p._expiry) {
        const council = state.councilById.get(p.Region);
        const why = council && !council.expiries ? `${council.short} doesn't publish expiry dates.` : 'No expiry date is published for this consent — many land use consents never expire.';
        return `<div class="timing" style="${stageStyle(p)}"><div class="timing-head"><span class="timing-big">No expiry date</span></div><p class="timing-advice">${escapeHtml(why)}</p></div>`;
    }
    const advice = lodgementAdvice(p, state.today);
    let adviceHtml = '';
    if (advice) {
        if (advice.kind === 'ok') adviceHtml = `Apply for a replacement by <strong>${formatDate(advice.deadline)}</strong> (6 months before expiry) and the holder can keep operating while it's processed (RMA s124).`;
        else if (advice.kind === 'discretion') adviceHtml = `The 6-month s124 date (${formatDate(advice.missed)}) has passed. Applying by <strong>${formatDate(advice.deadline)}</strong> (3 months before expiry) still lets the council allow operation to continue.`;
        else if (advice.kind === 'late') adviceHtml = 'Less than 3 months to expiry — too late for s124 protection, so a gap between consents is likely unless a new consent is granted in time.';
        else if (advice.kind === 'renewing') adviceHtml = 'A replacement application has been lodged; the holder is operating under s124 until it is decided.';
        else adviceHtml = 'The expiry date has passed, though the council still lists the consent as current.';
    }
    return `<div class="timing" style="${stageStyle(p)}">
        <div class="timing-head"><span class="timing-big">${escapeHtml(p._stage === 'past' ? 'Past expiry date' : describeTimeLeft(p._days))}</span>
        <span class="timing-date">${escapeHtml(stage.label)} · ${formatDate(p._expiry)}</span></div>
        <p class="timing-advice">${adviceHtml}</p>
        ${timelineHtml(p)}
    </div>`;
}

function timelineHtml(p) {
    if (p._days == null || p._days < 0 || p._status !== 'live') return '';
    const today = state.today;
    const expiry = today + p._days;
    const lodge = dayNumber(lodgeByDate(p));
    const first = Math.min(today, lodge);
    const start = first - Math.max(15, (expiry - first) * 0.06);
    const end = expiry;
    const pos = d => `${(((d - start) / (end - start)) * 100).toFixed(2)}%`;
    return `<div class="timeline" aria-hidden="true">
        <span class="timeline-track"></span>
        <span class="timeline-fill" style="left:${pos(today)};width:calc(${pos(expiry)} - ${pos(today)})"></span>
        <span class="tl-dot lodge" style="left:${pos(lodge)}"></span>
        <span class="tl-dot expiry" style="left:${pos(expiry)}"></span>
        <span class="tl-dot today" style="left:${pos(today)}"></span>
        <span class="tl-label above" style="left:${pos(today)}">Today</span>
        <span class="tl-label below" style="left:${pos(lodge)}">Lodge by</span>
        <span class="tl-label below end" style="left:${pos(expiry)}">Expires</span>
    </div>`;
}

function lawCallouts(p) {
    const out = [];
    if (p._firm === 'cap') {
        out.push(`<div class="callout callout-firm"><i class="fas fa-lock"></i><div><strong>Firm date.</strong> As a freshwater consent granted ${formatDate(p.GrantedDate)}, it reaches the 35-year maximum term on ${formatDate(freshwaterCapDate(p))}, so the law changes can't extend it — a replacement will be needed.</div></div>`);
    } else if (p._firm === 'wastewater') {
        out.push('<div class="callout callout-firm"><i class="fas fa-lock"></i><div><strong>Firm date.</strong> Wastewater network consents are excluded from the automatic extensions, so this renewal should go ahead on time.</div></div>');
    }
    if (p._lawExtended && p._status === 'live') {
        out.push('<div class="callout callout-law"><i class="fas fa-scale-balanced"></i><div>31 December 2027 is the date most consents were extended to under RMA s123C. The Planning Act 2026 is expected to extend many again (to around 2031), so check with the council before relying on it. <button type="button" class="link-btn" data-action="help-law">More about the law changes</button></div></div>');
    }
    return out.join('');
}

function holderHtml(p) {
    if (p._holder) {
        return `${escapeHtml(p._holder)} <span class="tag tag-type">${escapeHtml(HOLDER_TYPE_BY_ID[p._holderType].label)}</span>`;
    }
    if (p._holderType === 'private' && !p._holderGuess) return 'A private individual (name withheld by the council)';
    const guess = p._holderGuess ? `<br>Probably ${escapeHtml(HOLDER_TYPE_BY_ID[p._holderType].singular)}, going by the activity` : '';
    return `<span class="muted">Not published by ${escapeHtml(councilName(p.Region))}</span>${guess}`;
}

const EXTRA_FIELD_LABELS = {
    ConsentID: 'Consent ID', ProjectNumber: 'Project / application', Status: 'Status', PrimaryConsentHolder: 'Holder',
    PrimaryConsentHolderAddress: 'Holder address', LocalAuthority: 'Local authority', SiteAddress: 'Site address',
    Purpose: 'Purpose', Subtype: 'Type', Category: 'Category', WaterManagementZone: 'Water management zone',
    WaterManagementArea: 'Water management area', ComplianceOfficer: 'Compliance officer', GrantedDate: 'Granted',
    LodgedDate: 'Lodged', ExpiryDate: 'Expiry', StatusDate: 'Status date', CapID: 'Reference', FactorySupplyNumber: 'Supply / bore number',
    PublicDocumentsLink: 'Documents link', DeemedPermitted: 'Deemed permitted', ApplicationHistoricID: 'Historic application ID',
    WorkflowID: 'Workflow ID', AuthPrimaryIndustry: 'Primary industry', ActPrimaryIndustry: 'Activity industry',
    AuthSecondaryIndustry: 'Secondary industry', ActSecondaryIndustry: 'Secondary activity industry',
    AuthorisationLegal1: 'Legal description', AuthorisationLegal2: 'Legal description (2)', WaterMeterRequired: 'Water meter required',
    WaterMeterInstalled: 'Water meter installed', DateWaterMeterRequired: 'Water meter required by', WellNumber: 'Well number'
};

function allFieldsHtml(p) {
    const keys = [...COMMON_FIELDS, ...Object.keys(p).filter(k => !k.startsWith('_') && !COMMON_FIELDS.includes(k) && !['lat', 'lng', 'Region', 'HolderDisplay', 'GlobalID', 'NoExpiryDateAvailable'].includes(k))];
    const rows = keys.filter(k => k !== 'HolderDisplay' && k !== 'GlobalID' && p[k] !== '' && p[k] != null && p[k] !== true)
        .map(k => [EXTRA_FIELD_LABELS[k] || k, escapeHtml(cleanText(p[k]))]);
    return `<details class="more-fields section"><summary>Everything the council publishes</summary>${factRows(rows)}</details>`;
}

function consentSummaryText(p) {
    const lines = [
        `${p._holder || 'Holder not published'} — ${WORK_TYPE_BY_ID[p._work].label}`,
        cleanText(p.Purpose),
        p.SiteAddress ? `Site: ${cleanText(p.SiteAddress)}` : '',
        `${councilName(p.Region, false)} consent ${p.ConsentID} (${cleanText(p.Status) || 'status not stated'})`,
        p._expiry ? `Expires ${formatDate(p._expiry)} (${describeTimeLeft(p._days).toLowerCase()}); lodge a replacement by ${formatDate(lodgeByDate(p))} for s124 protection` : 'No expiry date published',
        safeUrl(p.PublicDocumentsLink) ? `Council documents: ${safeUrl(p.PublicDocumentsLink)}` : '',
        location.href
    ];
    return lines.filter(Boolean).join('\n');
}

function renderConsentSheet(p) {
    const work = WORK_TYPE_BY_ID[p._work];
    const starred = shortlist.has(p.GlobalID);
    $('#sheetActions').innerHTML = `
        <button type="button" class="btn btn-small" data-action="zoom" title="Show on the map"><i class="fas fa-location-crosshairs"></i> Map</button>
        <button type="button" class="btn btn-small" data-action="star" data-id="${escapeHtml(p.GlobalID)}" aria-pressed="${starred}">
            <i class="${starred ? 'fas' : 'far'} fa-star" style="color:#eab308"></i> ${starred ? 'Shortlisted' : 'Shortlist'}</button>`;
    const docs = safeUrl(p.PublicDocumentsLink);
    const cap = freshwaterCapDate(p);
    const capDay = dayNumber(cap);
    const zone = [p.WaterManagementZone, p.WaterManagementArea].filter(Boolean).map(cleanText).join(' · ');
    const legal = [p.AuthorisationLegal1, p.AuthorisationLegal2].filter(Boolean).map(cleanText).filter((v, i, a) => a.indexOf(v) === i).join('; ');
    const facts = factRows([
        ['Holder', holderHtml(p)],
        ['Holder address', escapeHtml(cleanText(p.PrimaryConsentHolderAddress))],
        ['Site', escapeHtml(readableText(cleanText(p.SiteAddress)))],
        ['Legal description', escapeHtml(legal)],
        ['Council', escapeHtml(councilName(p.Region, false))],
        ['Status', escapeHtml(cleanText(p.Status))],
        ['Consent type', escapeHtml(typeLine(p))],
        ['Industry', INDUSTRY_IN_CATEGORY.has(p.Region) ? escapeHtml(cleanText(p.Category)) : ''],
        ['Granted', formatDate(p.GrantedDate)],
        ['Expires', p._expiry ? formatDate(p._expiry) : ''],
        ['Lodge by (s124)', p._expiry && p._status === 'live' ? formatDate(lodgeByDate(p)) : ''],
        ['35-year limit', capDay != null && capDay > state.today - 3650 ? formatDate(cap) : ''],
        ['Zone', escapeHtml(zone)],
        ['Project / application', escapeHtml(p.ProjectNumber)]
    ]);
    const note = starred ? `<div class="section note-box"><div class="section-title"><i class="fas fa-pen"></i> Your notes</div>
        <textarea id="noteInput" placeholder="Who to contact, follow-up dates…" aria-label="Notes for this consent">${escapeHtml(shortlist.note(p.GlobalID))}</textarea>
        <div class="saved" id="noteSaved">Saved in this browser</div></div>` : '';
    $('#sheetBody').innerHTML = `
        <div class="detail-kicker"><i class="fas ${work.icon}" aria-hidden="true"></i> ${escapeHtml(work.label)}</div>
        <h2 class="detail-title">${escapeHtml(p._holder || shortPurpose(p, 90) || work.label)}</h2>
        <div class="detail-subtitle">${escapeHtml(councilName(p.Region, false))} · Consent ${escapeHtml(p.ConsentID)}</div>
        ${timingHtml(p)}
        ${lawCallouts(p)}
        <div class="section"><div class="section-title">What it's for</div><p class="purpose">${escapeHtml(readableText(cleanText(p.Purpose)) || 'No description published.')}</p></div>
        <div class="section">${facts}</div>
        <div class="action-row">
            ${docs ? `<a class="btn btn-primary" href="${escapeHtml(docs)}" target="_blank" rel="noopener"><i class="fas fa-folder-open"></i> Council documents</a>` : ''}
            <a class="btn" href="https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lng}" target="_blank" rel="noopener"><i class="fas fa-map-location-dot"></i> Google Maps</a>
            <button type="button" class="btn" data-action="copy-summary"><i class="far fa-copy"></i> Copy summary</button>
            <button type="button" class="btn" data-action="copy-link"><i class="fas fa-link"></i> Copy link</button>
        </div>
        ${note}
        <div class="section" id="propertySection"><div class="section-title"><i class="fas fa-vector-square"></i> Property</div><div class="loading-line"><span class="mini-spinner"></span> Looking up the land parcel…</div></div>
        <div class="section" id="siteSection"></div>
        ${allFieldsHtml(p)}`;
    renderSiteConsents(p);
    loadConsentProperty(p);
}

function renderSiteConsents(p) {
    const others = consentsNear(p.lat, p.lng, SITE_RADIUS_M).map(x => x.p).filter(o => o.GlobalID !== p.GlobalID).sort(byRelevance);
    $('#siteSection').innerHTML = others.length
        ? `<div class="section-title"><i class="fas fa-layer-group"></i> Other consents within ${SITE_RADIUS_M} m (${formatNumber(others.length)})</div>${miniList(others)}`
        : '';
}

async function loadConsentProperty(p) {
    const section = $('#propertySection');
    const id = p.GlobalID;
    try {
        const result = await fetchProperty(p.lat, p.lng);
        if (currentSheet()?.id !== id || !section.isConnected) return;
        if (!result.parcel) {
            section.innerHTML = `<div class="section-title"><i class="fas fa-vector-square"></i> Property</div><p class="muted">No land parcel at this point — it may be in a river, lake or the coastal marine area.</p>`;
            return;
        }
        const { parcel, titles } = result;
        mapView.showParcel(parcel.geometry);
        const titleText = titles.length ? `${titles.length === 1 ? 'Title' : 'Titles'} ${titles.map(t => t.titleNo).slice(0, 3).join(', ')}${titles.length > 3 ? '…' : ''}` : '';
        section.innerHTML = `<div class="section-title"><i class="fas fa-vector-square"></i> Property</div>
            <div class="property-box">
                <div class="appellation">${escapeHtml(parcel.appellation || 'Land parcel')}</div>
                <div class="muted">${escapeHtml([result.addresses[0]?.text, formatArea(parcel.area), titleText].filter(Boolean).join(' · '))}</div>
                <div class="action-row" style="margin-top:10px"><button type="button" class="btn btn-small" data-action="open-property" data-lat="${p.lat}" data-lng="${p.lng}">
                    <i class="fas fa-circle-info"></i> Property details and all its consents</button></div>
            </div>`;
    } catch (err) {
        if (currentSheet()?.id !== id || !section.isConnected) return;
        section.innerHTML = `<div class="section-title"><i class="fas fa-vector-square"></i> Property</div>
            <p class="muted">Couldn't load property details right now (${escapeHtml(err.message || 'service unavailable')}).</p>
            <button type="button" class="btn btn-small" data-action="retry-property" style="margin-top:8px"><i class="fas fa-rotate-right"></i> Try again</button>`;
    }
}

// Consents around a point, for when there's no parcel to list them by.
function nearbySection(lat, lng) {
    const nearby = consentsNear(lat, lng, NEARBY_RADIUS_M).map(x => x.p).sort(byRelevance);
    return nearby.length
        ? `<div class="section"><div class="section-title">Consents within ${NEARBY_RADIUS_M} m (${formatNumber(nearby.length)})</div>${miniList(nearby, 15)}</div>`
        : '';
}

function renderPropertySheet(entry) {
    const { lat, lng } = entry;
    $('#sheetActions').innerHTML = `<a class="btn btn-small" href="https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat},${lng}" target="_blank" rel="noopener"><i class="fas fa-street-view"></i> Street View</a>`;
    $('#sheetBody').innerHTML = `<div class="detail-kicker"><i class="fas fa-vector-square"></i> Property</div>
        <div class="loading-line" style="margin-top:12px"><span class="mini-spinner"></span> Looking up the land parcel…</div>`;
    const request = {};
    propertyRequest = request;
    fetchProperty(lat, lng).then(result => {
        if (propertyRequest !== request || currentSheet() !== entry) return;
        renderPropertyResult(entry, result);
    }).catch(err => {
        if (propertyRequest !== request || currentSheet() !== entry) return;
        $('#sheetBody').innerHTML = `<div class="detail-kicker"><i class="fas fa-vector-square"></i> Property</div>
            <h2 class="detail-title">Property details unavailable</h2>
            <p class="detail-subtitle">The LINZ parcel service didn't respond (${escapeHtml(err.message || 'error')}). Try again in a moment.</p>
            <div class="action-row"><button type="button" class="btn" data-action="retry-property"><i class="fas fa-rotate-right"></i> Try again</button></div>
            ${nearbySection(lat, lng)}`;
    });
}

function renderPropertyResult(entry, result) {
    const { lat, lng } = entry;
    if (!result.parcel) {
        mapView.showParcel(null);
        $('#sheetBody').innerHTML = `<div class="detail-kicker"><i class="fas fa-vector-square"></i> Property</div>
            <h2 class="detail-title">No land parcel here</h2>
            <p class="detail-subtitle">This point may be in a river, lake or the coastal marine area.</p>
            ${nearbySection(lat, lng)}`;
        return;
    }
    const { parcel, titles, addresses, problems } = result;
    mapView.showParcel(parcel.geometry);
    const bounds = geometryBounds(parcel.geometry);
    const onParcel = consentsInBounds(bounds).filter(p => pointInGeometry(p.lng, p.lat, parcel.geometry)).sort(byRelevance);
    const onParcelIds = new Set(onParcel.map(p => p.GlobalID));
    const centre = { lat: (bounds.south + bounds.north) / 2, lng: (bounds.west + bounds.east) / 2 };
    const nearby = consentsNear(centre.lat, centre.lng, NEARBY_RADIUS_M).map(x => x.p).filter(p => !onParcelIds.has(p.GlobalID)).sort(byRelevance);
    const live = onParcel.filter(p => p._status === 'live' || p._status === 'renewing').length;

    const titleItems = titles.map(t => {
        const detail = [t.type, t.status && t.status !== 'Live' ? t.status : '', t.issued ? `issued ${formatDate(t.issued)}` : '',
            t.owners != null ? plural(t.owners, 'owner') : ''].filter(Boolean).join(' · ');
        return `<li><b>${escapeHtml(t.titleNo)}</b>${detail ? ` <span class="muted">· ${escapeHtml(detail)}</span>` : ''}${t.estate ? `<div class="muted">${escapeHtml(t.estate)}</div>` : ''}</li>`;
    }).join('');
    const facts = factRows([
        ['Address', escapeHtml(addresses.map(a => a.text).slice(0, 4).join('; ')) + (addresses.length > 4 ? ` <span class="muted">and ${addresses.length - 4} more</span>` : '')],
        ['Area', escapeHtml(formatArea(parcel.area)) + (parcel.areaSource === 'survey' ? '' : ` <span class="muted">(${parcel.areaSource})</span>`)],
        ['Land district', escapeHtml(parcel.landDistrict)],
        ['Parcel type', escapeHtml(parcel.intent)],
        ['Statutory actions', escapeHtml(truncate(parcel.statutoryActions, 300))],
        ['Survey plans', escapeHtml(truncate(parcel.surveys, 200))],
        ['Parcel ID', escapeHtml(parcel.id)]
    ]);
    $('#sheetBody').innerHTML = `<div class="detail-kicker"><i class="fas fa-vector-square"></i> Property</div>
        <h2 class="detail-title">${escapeHtml(parcel.appellation || 'Land parcel')}</h2>
        <div class="detail-subtitle">${escapeHtml(onParcel.length ? `${plural(onParcel.length, 'consent')} on this parcel${live ? ` · ${formatNumber(live)} current` : ''}` : 'No consents recorded on this parcel')}</div>
        <div class="section">${facts}</div>
        ${titles.length ? `<div class="section"><div class="section-title"><i class="fas fa-file-contract"></i> Records of title</div><ul class="title-list">${titleItems}</ul></div>` : ''}
        <div class="action-row">
            <button type="button" class="btn" data-action="zoom-parcel"><i class="fas fa-expand"></i> Zoom to parcel</button>
            <button type="button" class="btn" data-action="copy-legal" data-text="${escapeHtml([parcel.appellation, titles.map(t => t.titleNo).join(', ')].filter(Boolean).join(' — '))}"><i class="far fa-copy"></i> Copy legal description</button>
            <a class="btn" href="https://www.google.com/maps/search/?api=1&query=${lat},${lng}" target="_blank" rel="noopener"><i class="fas fa-map-location-dot"></i> Google Maps</a>
        </div>
        <div class="section"><div class="section-title"><i class="fas fa-layer-group"></i> Consents on this parcel (${formatNumber(onParcel.length)})</div>
            ${onParcel.length ? miniList(onParcel, 25) : '<p class="muted">None recorded by the councils in this app.</p>'}</div>
        ${nearby.length ? `<div class="section"><div class="section-title">Nearby, within ${NEARBY_RADIUS_M} m (${formatNumber(nearby.length)})</div>${miniList(nearby, 10)}</div>` : ''}
        ${problems.length ? `<div class="callout callout-warn"><i class="fas fa-triangle-exclamation"></i><div>${problems.map(escapeHtml).join('<br>')}</div></div>` : ''}
        <p class="attribution">Parcel, title and address data: Toitū Te Whenua LINZ (CC BY 4.0). Owner names aren't shown — LINZ releases them only under its Licence for Personal Data, which rules out unsolicited direct marketing.</p>`;
    entry.bounds = bounds;
}

// --- Map interaction ---
let lastZoomToast = 0;
function handleMapClick(latlng, zoom) {
    closeDropdowns();
    if (zoom < PROPERTY_MIN_ZOOM) {
        if (Date.now() - lastZoomToast > 20000) {
            toast('Zoom in to street level, then click a property to see its details');
            lastZoomToast = Date.now();
        }
        return;
    }
    openPropertyAt(latlng.lat, latlng.lng);
}

const refreshForMapArea = debounce(() => refreshResults(), 200);
function handleMapMove(zoom) {
    if (state.filters.mapArea) refreshForMapArea();
    let dismissed = false;
    try { dismissed = localStorage.getItem(HINT_KEY) === '1'; } catch { /* ignore */ }
    const hint = $('#mapHint');
    if (zoom >= PROPERTY_MIN_ZOOM && !dismissed) {
        hint.innerHTML = `<span><i class="fas fa-hand-pointer"></i> Click any property for its legal description, titles and consents</span>
            <button type="button" data-action="dismiss-hint" aria-label="Dismiss"><i class="fas fa-xmark"></i></button>`;
        hint.hidden = false;
    } else {
        hint.hidden = true;
    }
}

// --- Search (consents as you type; places on request) ---
let placeRequest = 0;
let placeQuery = ''; // the text last sent to the place search, whose results are showing
function renderSearchMenu(content) {
    const menu = $('#searchMenu');
    menu.innerHTML = content;
    menu.hidden = !content;
    $('#search').setAttribute('aria-expanded', String(Boolean(content)));
}

function searchMenuDefault() {
    const q = $('#search').value.trim();
    if (q.length < 2) return renderSearchMenu('');
    renderSearchMenu(`<div class="menu-note">${plural(state.results.length, 'consent')} match — shown in the list</div>
        <button type="button" data-action="find-place" role="option"><i class="fas fa-location-dot"></i><span><span class="place-name">Find “${escapeHtml(truncate(q, 60))}” on the map</span>
        <span class="place-detail">Search addresses and places in New Zealand (press Enter)</span></span></button>`);
}

async function findPlace() {
    const q = $('#search').value.trim();
    if (!q) return;
    placeQuery = q;
    const request = ++placeRequest;
    renderSearchMenu('<div class="menu-note"><span class="mini-spinner" style="display:inline-block;vertical-align:-2px"></span> Searching places…</div>');
    try {
        const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&countrycodes=nz&limit=6&accept-language=en&q=${encodeURIComponent(q)}`;
        const places = await fetchJson(url);
        if (request !== placeRequest) return;
        if (!places.length) return renderSearchMenu(`<div class="menu-note">No places found for “${escapeHtml(q)}”.</div>`);
        renderSearchMenu(places.map(place => {
            const [name, ...rest] = String(place.display_name).split(', ');
            const box = Array.isArray(place.boundingbox) ? place.boundingbox.map(Number).join(',') : '';
            return `<button type="button" data-action="go-place" data-lat="${Number(place.lat)}" data-lng="${Number(place.lon)}"
                data-rank="${Number(place.place_rank) || 0}" data-bbox="${escapeHtml(box)}" role="option">
                <i class="fas fa-location-dot"></i><span><span class="place-name">${escapeHtml(name)}</span><span class="place-detail">${escapeHtml(rest.slice(0, 4).join(', '))}</span></span></button>`;
        }).join('') + '<div class="menu-note" style="font-size:11.5px">Place search © OpenStreetMap contributors</div>');
    } catch {
        if (request === placeRequest) renderSearchMenu('<div class="menu-note">Place search is unavailable right now.</div>');
    }
}

// Nominatim's place_rank: 30 = a house or building, 26–27 = a street, lower = suburbs, towns, regions.
function goToPlace(lat, lng, rank, bbox) {
    renderSearchMenu('');
    // The address was for the map, not a consent search.
    $('#search').value = '';
    $('#searchClear').hidden = true;
    placeQuery = '';
    if (state.filters.search) {
        state.filters.search = '';
        applyFilters();
    }
    const [south, north, west, east] = (bbox || '').split(',').map(Number);
    if (rank >= 29) {
        mapView.flyTo(lat, lng, 18);
        openPropertyAt(lat, lng);
    } else if ([south, north, west, east].every(Number.isFinite)) {
        mapView.focusBounds({ west, south, east, north }, 17);
    } else {
        mapView.flyTo(lat, lng, rank >= 26 ? 17 : 13);
    }
    if (isMobile() && rank < 29) setMobileView('map');
}

// --- Export ---
function exportRows(records) {
    const headers = ['Council', 'Consent ID', 'Holder', 'Holder type', 'Type of work', 'Activity', 'Consent type', 'Status', 'Site address',
        'Granted', 'Expiry', 'Lodge by (s124)', 'Days to expiry', 'Expiry note', 'Shortlisted', 'Notes', 'Council documents', 'Latitude', 'Longitude', 'Map link'];
    const rows = records.map(p => [
        councilName(p.Region, false), p.ConsentID, p._holder, (p._holderGuess ? 'Likely: ' : '') + HOLDER_TYPE_BY_ID[p._holderType].label,
        WORK_TYPE_BY_ID[p._work].label, cleanText(p.Purpose), typeLine(p), cleanText(p.Status), cleanText(p.SiteAddress),
        p.GrantedDate, p._expiry, p._status === 'live' ? lodgeByDate(p) : '', p._days ?? '',
        [p._firm === 'cap' ? 'Firm: 35-year limit' : p._firm === 'wastewater' ? 'Firm: wastewater network' : '', p._lawExtended ? 'Law-extended date (s123C)' : ''].filter(Boolean).join('; '),
        shortlist.has(p.GlobalID) ? 'Yes' : '', shortlist.note(p.GlobalID), safeUrl(p.PublicDocumentsLink), p.lat, p.lng,
        `https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lng}`
    ]);
    return toCsv(headers, rows);
}

function exportCsv(records, name) {
    const date = new Date().toISOString().slice(0, 10);
    downloadFile(`${name}-${date}.csv`, exportRows(records), 'text/csv;charset=utf-8');
    toast(`Exported ${plural(records.length, 'consent')}`);
}

// --- Data sources ---
function daysSinceUpdate(council) {
    const d = council.fetchedAt ? new Date(council.fetchedAt) : null;
    return d && !Number.isNaN(d.getTime()) ? state.today - todayNumber(d) : null;
}

function isStale(council) {
    const days = daysSinceUpdate(council);
    return days != null && days > STALE_AFTER_DAYS;
}

function renderDataPanel() {
    const ok = state.councils.filter(c => !c.error);
    const stale = state.councils.filter(c => c.error || isStale(c));
    const newest = ok.map(c => c.fetchedAt || '').sort().pop();
    $('#dataLabel').textContent = stale.length ? `${stale.length} out of date` : (newest ? `Updated ${formatTimestamp(newest)}` : 'Data');
    $('#dataBtn').classList.toggle('has-warning', stale.length > 0);
    const rows = state.councils.map(c => {
        let note = '';
        if (c.error) note = '<span class="data-failed">Failed to load in your browser</span>';
        else if (isStale(c)) note = `<span class="data-stale"><i class="fas fa-triangle-exclamation"></i> Not refreshed for ${formatNumber(daysSinceUpdate(c))} days — the council's service isn't answering the daily download.</span>`;
        const features = [c.holders ? 'holder names' : '', c.expiries ? '' : 'no expiry dates'].filter(Boolean).join(', ');
        const name = safeUrl(c.source) ? `<a href="${escapeHtml(c.source)}" target="_blank" rel="noopener">${escapeHtml(c.name)}</a>` : escapeHtml(c.name);
        return `<tr><td>${name}${features ? `<div class="muted" style="font-size:12px">${escapeHtml(features)}</div>` : ''}${note}</td>
            <td class="num">${c.error ? '—' : formatNumber(c.loaded)}</td><td class="num">${formatTimestamp(c.fetchedAt) || '—'}</td></tr>`;
    }).join('');
    $('#dataBody').innerHTML = `<p class="muted" style="font-size:13px">Consents are downloaded from each council's public map service every day. Check important details with the council before relying on them.</p>
        <table class="data-table"><thead><tr><th>Council</th><th class="num">Consents</th><th class="num">Updated</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function togglePopover(id, open) {
    const panel = $(`#${id}`);
    const show = open ?? panel.hidden;
    panel.hidden = !show;
    if (id === 'dataPanel') $('#dataBtn').setAttribute('aria-expanded', String(show));
}

function openHelp(sectionId) {
    const modal = $('#helpModal');
    modal.hidden = false;
    const target = sectionId ? $(`#${sectionId}`) : null;
    $('.modal-body', modal).scrollTop = target ? target.offsetTop - 60 : 0;
    $('[data-close]', modal).focus();
}

// --- Events ---
function bindEvents() {
    $('#windowControl').addEventListener('click', e => {
        const button = e.target.closest('[data-window]');
        if (!button) return;
        state.filters.window = button.dataset.window;
        applyFilters();
    });

    // Dropdowns
    for (const container of $$('[data-dropdown]')) {
        container.addEventListener('click', e => {
            const id = container.dataset.dropdown;
            if (e.target.closest('.dropdown-btn')) {
                const menu = $('.dropdown-menu', container);
                menu.hidden ? openDropdown(id) : closeDropdowns();
                return;
            }
            const quick = e.target.closest('[data-quick]');
            if (quick) handleMenuQuick(id, quick.dataset.quick);
        });
        container.addEventListener('change', e => {
            if (e.target.matches('input[type="checkbox"]')) handleMenuChange(container.dataset.dropdown, e.target);
        });
    }
    document.addEventListener('click', e => {
        if (!e.target.closest('[data-dropdown]')) closeDropdowns();
        if (!e.target.closest('#searchWrap')) renderSearchMenu('');
        if (!$('#dataPanel').hidden && !e.target.closest('#dataPanel') && !e.target.closest('#dataBtn')) togglePopover('dataPanel', false);
    });

    // Delegated actions anywhere in the page
    document.addEventListener('click', e => {
        const el = e.target.closest('[data-action]');
        if (!el) return;
        const action = el.dataset.action;
        switch (action) {
            case 'open': openConsent(el.dataset.id, { focus: true, push: Boolean(el.closest('#sheet')) }); break;
            case 'star': {
                const on = shortlist.toggle(el.dataset.id);
                toast(on ? 'Added to your shortlist' : 'Removed from your shortlist');
                break;
            }
            case 'more': showMore(); break;
            case 'holder': setHolderFilter(el.dataset.name); break;
            case 'clear-holder': state.filters.holder = ''; applyFilters(); break;
            case 'reset-filters': resetFilters(); break;
            case 'export': exportCsv(state.results, 'consent-renewals'); break;
            case 'export-shortlist': exportCsv(shortlistedConsents(), 'consent-shortlist'); break;
            case 'clear-shortlist':
                if (confirm('Remove every consent from your shortlist? Your notes will be deleted too.')) shortlist.clear();
                break;
            case 'help-law': closeDropdowns(); openHelp('help-law'); break;
            case 'zoom': {
                const p = state.byId.get(currentSheet()?.id);
                if (p) {
                    mapView.focusConsent(p, 17);
                    if (isMobile()) setMobileView('map');
                }
                break;
            }
            case 'zoom-parcel': {
                const entry = currentSheet();
                if (entry && entry.bounds) {
                    mapView.focusBounds(entry.bounds);
                    if (isMobile()) setMobileView('map');
                }
                break;
            }
            case 'open-property': openPropertyAt(Number(el.dataset.lat), Number(el.dataset.lng), { push: true }); break;
            case 'retry-property': showSheet(); break;
            case 'copy-summary': {
                const p = state.byId.get(currentSheet()?.id);
                if (p) copyText(consentSummaryText(p), 'Summary copied — paste it into an email or note');
                break;
            }
            case 'copy-link': copyText(location.href, 'Link copied'); break;
            case 'copy-legal': copyText(el.dataset.text || '', 'Legal description copied'); break;
            case 'find-place': findPlace(); break;
            case 'go-place': goToPlace(Number(el.dataset.lat), Number(el.dataset.lng), Number(el.dataset.rank), el.dataset.bbox); break;
            case 'dismiss-hint':
                try { localStorage.setItem(HINT_KEY, '1'); } catch { /* ignore */ }
                $('#mapHint').hidden = true;
                break;
            default: break;
        }
    });

    shortlist.onChange(() => {
        renderTabs();
        if (state.tab === 'shortlist') renderList();
        else {
            for (const btn of $$('.star-btn')) {
                const on = shortlist.has(btn.dataset.id);
                btn.classList.toggle('on', on);
                btn.setAttribute('aria-pressed', String(on));
                btn.innerHTML = `<i class="${on ? 'fas' : 'far'} fa-star"></i>`;
            }
        }
        const entry = currentSheet();
        if (entry && entry.kind === 'consent') {
            const scroll = $('#sheetBody').scrollTop;
            renderConsentSheet(state.byId.get(entry.id));
            $('#sheetBody').scrollTop = scroll;
        }
    });

    $('#sheetBody').addEventListener('input', debounce(e => {
        if (e.target.id !== 'noteInput') return;
        const entry = currentSheet();
        if (!entry || entry.kind !== 'consent') return;
        shortlist.setNote(entry.id, e.target.value);
        const saved = $('#noteSaved');
        if (saved) saved.textContent = 'Saved in this browser ✓';
    }, 300));

    $('#summary').addEventListener('change', e => {
        if (e.target.id !== 'mapAreaToggle') return;
        state.filters.mapArea = e.target.checked;
        refreshResults();
        savePrefs();
    });

    $$('.tab').forEach(tab => tab.addEventListener('click', () => setTab(tab.dataset.tab)));
    $('#listArea').addEventListener('change', e => {
        if (e.target.id !== 'sort') return;
        state.sort = e.target.value;
        refreshResults();
        savePrefs();
    });

    // Search
    const search = $('#search');
    const runSearch = debounce(() => {
        state.filters.search = search.value;
        applyFilters();
        // Don't replace place results the user asked for with the default menu.
        if (document.activeElement === search && search.value.trim() !== placeQuery) searchMenuDefault();
    }, 250);
    search.addEventListener('input', () => {
        $('#searchClear').hidden = !search.value;
        placeQuery = '';
        runSearch();
    });
    search.addEventListener('focus', searchMenuDefault);
    search.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
            e.preventDefault();
            findPlace();
        } else if (e.key === 'Escape') {
            renderSearchMenu('');
        }
    });
    $('#searchClear').addEventListener('click', () => {
        search.value = '';
        $('#searchClear').hidden = true;
        state.filters.search = '';
        renderSearchMenu('');
        applyFilters();
        search.focus();
    });

    $('#sheetBack').addEventListener('click', sheetBack);
    $('#dataBtn').addEventListener('click', () => togglePopover('dataPanel'));
    $('#helpBtn').addEventListener('click', () => openHelp());
    $$('[data-close]').forEach(btn => btn.addEventListener('click', () => {
        const box = btn.closest('.popover, .modal');
        box.hidden = true;
        if (box.id === 'dataPanel') $('#dataBtn').setAttribute('aria-expanded', 'false');
    }));
    $('#helpModal').addEventListener('click', e => { if (e.target.id === 'helpModal') e.currentTarget.hidden = true; });

    $$('.mobile-switch button').forEach(btn => btn.addEventListener('click', () => setMobileView(btn.dataset.view)));

    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') {
            if (!$('#helpModal').hidden) { $('#helpModal').hidden = true; return; }
            if (!$('#dataPanel').hidden) { togglePopover('dataPanel', false); return; }
            if ($$('.dropdown-menu').some(m => !m.hidden)) { closeDropdowns(); return; }
            if (!$('#sheet').hidden && !e.target.closest('input, textarea')) sheetBack();
        } else if (e.key === '/' && !e.target.closest('input, textarea, select')) {
            e.preventDefault();
            $('#search').focus();
        }
    });
    window.addEventListener('hashchange', openFromHash);
}

loadPrefs();
loadData();
