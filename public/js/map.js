// === Map ===
// Leaflet map with consent markers coloured by how soon they expire, clusters coloured by
// their most urgent consent, LINZ parcel boundaries when zoomed in, and a highlight for the
// selected consent and parcel. Leaflet and Leaflet.markercluster are loaded as globals (L).

import { STAGES, STAGE_BY_ID, WORK_TYPE_BY_ID, cleanText, describeTimeLeft, stageRank } from './consents.js';
import { BOUNDARY_TILE_ZOOM, PROPERTY_ATTRIBUTION, fetchBoundaryTile, tilesForBounds } from './property.js';
import { escapeHtml, formatDate, readableText, truncate } from './format.js';

// LINZ Basemaps key; visible to every visitor, as is normal for browser map keys.
const LINZ_BASEMAPS_KEY = 'd01hep5551e30kxb7w85hck49tp';
export const PROPERTY_MIN_ZOOM = 14;   // map clicks look up the property from here in
export const BOUNDARY_MIN_ZOOM = 17;   // parcel outlines are drawn from here in
const NORTH_ISLAND = [[-41.75, 172.6], [-34.35, 178.7]];
const MAX_BOUNDARY_TILES = 24;
const BOUNDARY_CONCURRENCY = 4;
const BOUNDARY_CACHE_SIZE = 120;
const BOUNDARY_RETRY_MS = 120000;

function baseLayers() {
    const linzAttribution = '<a href="https://www.linz.govt.nz/data/linz-data/linz-basemaps/data-attribution">LINZ CC BY 4.0</a> © Imagery Basemap contributors';
    const aerial = () => L.tileLayer(`https://basemaps.linz.govt.nz/v1/tiles/aerial/WebMercatorQuad/{z}/{x}/{y}.webp?api=${LINZ_BASEMAPS_KEY}`, {
        attribution: linzAttribution, maxNativeZoom: 19, maxZoom: 20
    });
    return {
        'Aerial + labels': L.layerGroup([
            aerial(),
            L.tileLayer('https://{s}.basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}{r}.png', {
                attribution: '© CARTO', maxNativeZoom: 19, maxZoom: 20, pane: 'shadowPane'
            })
        ]),
        Aerial: aerial(),
        Streets: L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '© OpenStreetMap contributors', maxNativeZoom: 19, maxZoom: 20
        }),
        Topographic: L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
            attribution: '© OpenTopoMap contributors', maxNativeZoom: 17, maxZoom: 20
        })
    };
}

function compactCount(n) {
    if (n < 1000) return String(n);
    if (n < 10000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
    return `${Math.round(n / 1000)}k`;
}

export function createMap(element, {
    onConsentClick = () => {},
    onMapClick = () => {},
    onViewChange = () => {},
    onBaseLayerChange = () => {},
    onBoundariesToggle = () => {},
    onFitResults = () => {},
    initialBaseLayer = 'Aerial + labels',
    boundariesOn = true
} = {}) {
    const map = L.map(element, { preferCanvas: true, minZoom: 5, maxZoom: 20, zoomControl: true });
    // A map with no size (e.g. hidden) can't animate or fit bounds, so it jumps instead.
    const hasSize = () => map.getSize().x > 0 && map.getSize().y > 0;
    if (hasSize()) map.fitBounds(NORTH_ISLAND);
    else map.setView([-38.9, 175.7], 6);
    map.attributionControl.addAttribution(PROPERTY_ATTRIBUTION);

    // Panes keep parcel outlines under the consent markers.
    map.createPane('boundaries').style.zIndex = 350;
    map.createPane('parcel').style.zIndex = 380;
    map.createPane('selection').style.zIndex = 420;

    const layers = baseLayers();
    let currentBase = layers[initialBaseLayer] ? initialBaseLayer : 'Aerial + labels';
    layers[currentBase].addTo(map);

    // --- Property boundaries (overlay) ---
    const boundaryGroup = L.layerGroup();
    const boundaryCache = new Map(); // tile key → { layer, status, failedAt, used }
    let inFlight = 0;
    const queue = [];
    let boundaryProblem = false;

    function boundaryStyle() {
        return currentBase.startsWith('Aerial')
            ? { color: '#fde047', weight: 1.1, opacity: 0.85, fill: false }
            : { color: '#6d28d9', weight: 1, opacity: 0.6, fill: false };
    }

    function pumpBoundaryQueue() {
        while (inFlight < BOUNDARY_CONCURRENCY && queue.length) {
            const { tile, entry } = queue.shift();
            inFlight++;
            fetchBoundaryTile(tile)
                .then(shapes => {
                    entry.status = 'ok';
                    entry.layer = L.geoJSON({ type: 'FeatureCollection', features: shapes.map(geometry => ({ type: 'Feature', geometry, properties: {} })) },
                        { pane: 'boundaries', interactive: false, style: boundaryStyle });
                    boundaryProblem = false;
                })
                .catch(() => {
                    entry.status = 'error';
                    entry.failedAt = Date.now();
                    boundaryProblem = true;
                })
                .finally(() => {
                    inFlight--;
                    refreshBoundaries();
                    pumpBoundaryQueue();
                });
        }
    }

    function refreshBoundaries() {
        const visible = map.hasLayer(boundaryGroup) && map.getZoom() >= BOUNDARY_MIN_ZOOM;
        if (!visible) {
            boundaryGroup.clearLayers();
            updateStatus();
            return;
        }
        const b = map.getBounds().pad(0.1);
        const tiles = tilesForBounds({ west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() }, BOUNDARY_TILE_ZOOM, MAX_BOUNDARY_TILES);
        const wanted = new Set(tiles.map(t => t.key));
        boundaryGroup.eachLayer(layer => { if (!wanted.has(layer.tileKey)) boundaryGroup.removeLayer(layer); });
        const now = Date.now();
        for (const tile of tiles) {
            let entry = boundaryCache.get(tile.key);
            if (entry && entry.status === 'error' && now - entry.failedAt > BOUNDARY_RETRY_MS) {
                boundaryCache.delete(tile.key);
                entry = null;
            }
            if (!entry) {
                entry = { status: 'loading', layer: null, used: now };
                boundaryCache.set(tile.key, entry);
                queue.push({ tile, entry });
            }
            entry.used = now;
            if (entry.layer && !boundaryGroup.hasLayer(entry.layer)) {
                entry.layer.tileKey = tile.key;
                boundaryGroup.addLayer(entry.layer);
            }
        }
        // Forget the least recently used tiles.
        if (boundaryCache.size > BOUNDARY_CACHE_SIZE) {
            const oldest = [...boundaryCache.entries()].filter(([key]) => !wanted.has(key)).sort((a, b) => a[1].used - b[1].used);
            for (const [key] of oldest.slice(0, boundaryCache.size - BOUNDARY_CACHE_SIZE)) boundaryCache.delete(key);
        }
        pumpBoundaryQueue();
        updateStatus();
    }

    // --- Status line (bottom right) ---
    const StatusControl = L.Control.extend({
        onAdd() {
            this._div = L.DomUtil.create('div', 'map-status');
            L.DomEvent.disableClickPropagation(this._div);
            return this._div;
        }
    });
    const status = new StatusControl({ position: 'bottomright' }).addTo(map);
    function updateStatus() {
        const zoom = map.getZoom();
        let text = '';
        if (map.hasLayer(boundaryGroup)) {
            if (zoom >= BOUNDARY_MIN_ZOOM) {
                const loading = [...boundaryCache.values()].some(e => e.status === 'loading');
                text = boundaryProblem ? '<i class="fas fa-triangle-exclamation"></i> Property boundaries unavailable right now'
                    : loading ? '<span class="mini-spinner"></span> Loading property boundaries…' : '';
            } else if (zoom >= PROPERTY_MIN_ZOOM) {
                text = '<i class="fas fa-magnifying-glass-plus"></i> Zoom in to see property boundaries';
            }
        }
        status._div.innerHTML = text;
        status._div.hidden = !text;
    }

    const overlays = { 'Property boundaries': boundaryGroup };
    if (boundariesOn) boundaryGroup.addTo(map);
    L.control.layers(layers, overlays, { position: 'topright' }).addTo(map);
    map.on('baselayerchange', e => {
        currentBase = e.name;
        boundaryGroup.eachLayer(layer => layer.setStyle(boundaryStyle()));
        onBaseLayerChange(e.name);
    });
    map.on('overlayadd overlayremove', e => {
        if (e.layer === boundaryGroup) {
            onBoundariesToggle(e.type === 'overlayadd');
            refreshBoundaries();
        }
    });

    // --- Legend (bottom left) ---
    const LegendControl = L.Control.extend({
        onAdd() {
            this._div = L.DomUtil.create('div', 'map-legend');
            L.DomEvent.disableClickPropagation(this._div);
            return this._div;
        }
    });
    const legend = new LegendControl({ position: 'bottomleft' }).addTo(map);
    function setLegend(stageIds) {
        const rows = STAGES.filter(s => stageIds.includes(s.id))
            .map(s => `<div><span class="swatch" style="background:${s.color}"></span>${escapeHtml(s.id === 'ended' ? 'Not current' : s.label)}</div>`);
        legend._div.innerHTML = rows.length ? `<div class="legend-title">Expires in</div>${rows.join('')}` : '';
        legend._div.hidden = !rows.length;
    }

    // --- Consent markers ---
    function clusterIcon(cluster) {
        let best = Infinity;
        for (const marker of cluster.getAllChildMarkers()) {
            if (marker.options.rank < best) best = marker.options.rank;
        }
        const stage = STAGES[best] || STAGE_BY_ID.ended;
        const count = cluster.getChildCount();
        const size = count < 10 ? 28 : count < 100 ? 34 : count < 1000 ? 40 : 46;
        return L.divIcon({
            html: `<div class="cluster-icon" style="width:${size}px;height:${size}px;background:${stage.color}">${compactCount(count)}</div>`,
            className: '', iconSize: [size, size]
        });
    }

    const clusters = L.markerClusterGroup({
        chunkedLoading: true,
        chunkInterval: 120,
        // Only identical locations stay clustered close in, so they can spiderfy.
        maxClusterRadius: zoom => (zoom >= 16 ? 1 : zoom >= 13 ? 40 : 60),
        spiderfyOnMaxZoom: true,
        showCoverageOnHover: false,
        iconCreateFunction: clusterIcon
    });
    map.addLayer(clusters);

    function tooltipFor(p) {
        const work = WORK_TYPE_BY_ID[p._work];
        const title = p._holder || truncate(readableText(cleanText(p.Purpose)), 70) || work.label;
        const when = p._status === 'live' || p._status === 'renewing'
            ? `${describeTimeLeft(p._days)}${p._expiry ? ` · ${formatDate(p._expiry)}` : ''}` : (p.Status || 'Not current');
        return `<strong>${escapeHtml(title)}</strong><br>${escapeHtml(work.label)} · ${escapeHtml(when)}`;
    }

    function markerFor(p) {
        if (!p._marker) {
            const stage = STAGE_BY_ID[p._stage];
            const marker = L.circleMarker([p.lat, p.lng], {
                radius: 6, weight: 1.5, color: '#ffffff', fillColor: stage.color, fillOpacity: 0.95,
                bubblingMouseEvents: false, rank: stageRank(p._stage)
            });
            marker.bindTooltip(() => tooltipFor(p), { direction: 'top', offset: [0, -6], className: 'marker-tooltip' });
            marker.on('click', () => onConsentClick(p));
            p._marker = marker;
        }
        return p._marker;
    }

    function setConsents(records) {
        clusters.clearLayers();
        const markers = [];
        for (const p of records) {
            if (Number.isFinite(p.lat) && Number.isFinite(p.lng)) markers.push(markerFor(p));
        }
        clusters.addLayers(markers);
    }

    // --- Selection & parcel highlight ---
    const selectionHalo = L.circleMarker([0, 0], {
        pane: 'selection', radius: 12, weight: 3, color: '#111827', fillColor: '#ffffff', fillOpacity: 0.35, interactive: false
    });
    function select(p) {
        if (p && Number.isFinite(p.lat)) selectionHalo.setLatLng([p.lat, p.lng]).addTo(map);
        else selectionHalo.remove();
    }

    const parcelLayer = L.layerGroup().addTo(map);
    function showParcel(geometry) {
        parcelLayer.clearLayers();
        if (!geometry) return;
        const feature = { type: 'Feature', geometry, properties: {} };
        L.geoJSON(feature, { pane: 'parcel', interactive: false, style: { color: '#0f172a', weight: 6, opacity: 0.55, fill: false } }).addTo(parcelLayer);
        L.geoJSON(feature, { pane: 'parcel', interactive: false, style: { color: '#22d3ee', weight: 3, opacity: 1, fillColor: '#22d3ee', fillOpacity: 0.12 } }).addTo(parcelLayer);
    }

    function flyTo(lat, lng, zoom) {
        if (hasSize()) map.flyTo([lat, lng], zoom, { duration: 0.7 });
        else map.setView([lat, lng], zoom, { animate: false });
    }

    function focusConsent(p, minZoom = 16) {
        if (Number.isFinite(p.lat)) flyTo(p.lat, p.lng, Math.max(map.getZoom(), minZoom));
    }

    // Fly to show every consent in `records`.
    function fitTo(records) {
        let south = 90, north = -90, west = 180, east = -180, count = 0;
        for (const p of records) {
            if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) continue;
            count++;
            if (p.lat < south) south = p.lat;
            if (p.lat > north) north = p.lat;
            if (p.lng < west) west = p.lng;
            if (p.lng > east) east = p.lng;
        }
        if (!count) return;
        if (north - south < 0.001 && east - west < 0.001) flyTo((south + north) / 2, (west + east) / 2, Math.max(map.getZoom(), 16));
        else focusBounds({ west, south, east, north }, 16);
    }

    const FitControl = L.Control.extend({
        onAdd() {
            const bar = L.DomUtil.create('div', 'leaflet-bar leaflet-control fit-control');
            const link = L.DomUtil.create('a', '', bar);
            link.href = '#';
            link.title = 'Zoom to all results';
            link.setAttribute('role', 'button');
            link.setAttribute('aria-label', 'Zoom to all results');
            link.innerHTML = '<i class="fas fa-expand"></i>';
            L.DomEvent.disableClickPropagation(bar);
            L.DomEvent.on(link, 'click', e => {
                L.DomEvent.preventDefault(e);
                onFitResults();
            });
            return bar;
        }
    });
    new FitControl({ position: 'topleft' }).addTo(map);

    function focusBounds({ west, south, east, north }, maxZoom = 18) {
        const bounds = [[south, west], [north, east]];
        if (hasSize()) map.flyToBounds(bounds, { maxZoom, padding: [40, 40], duration: 0.7 });
        else map.setView(L.latLngBounds(bounds).getCenter(), Math.min(maxZoom, 14), { animate: false });
    }

    map.on('click', e => onMapClick(e.latlng, map.getZoom()));
    map.on('moveend', () => {
        refreshBoundaries();
        onViewChange(map.getZoom());
    });
    refreshBoundaries();

    return {
        map,
        setConsents,
        setLegend,
        select,
        showParcel,
        focusConsent,
        focusBounds,
        fitTo,
        flyTo,
        getBounds() {
            const b = map.getBounds();
            return { west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() };
        },
        getZoom: () => map.getZoom(),
        invalidateSize: () => map.invalidateSize()
    };
}
