// === Formatting helpers for the page ===

// Consent data comes from third-party council services, so escape every value put into HTML.
const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function escapeHtml(value) {
    return value == null ? '' : String(value).replace(/[&<>"']/g, ch => HTML_ESCAPES[ch]);
}

// Only http(s) links from the data become clickable.
export function safeUrl(url) {
    return typeof url === 'string' && /^https?:\/\//i.test(url.trim()) ? url.trim() : '';
}

const DATE_FORMAT = new Intl.DateTimeFormat('en-NZ', { day: 'numeric', month: 'short', year: 'numeric' });
const MONTH_YEAR = new Intl.DateTimeFormat('en-NZ', { month: 'short', year: 'numeric' });

// 'YYYY-MM-DD' → '3 Mar 2027' ('' when missing).
export function formatDate(iso, { monthOnly = false } = {}) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
    if (!m) return '';
    const d = new Date(+m[1], +m[2] - 1, +m[3]);
    return (monthOnly ? MONTH_YEAR : DATE_FORMAT).format(d);
}

// ISO timestamp → local date, e.g. '2 Oct 2026'.
export function formatTimestamp(iso) {
    const d = iso ? new Date(iso) : null;
    return d && !Number.isNaN(d.getTime()) ? DATE_FORMAT.format(d) : '';
}

export function formatNumber(n) {
    return Number(n || 0).toLocaleString('en-NZ');
}

export function plural(count, singular, pluralForm = `${singular}s`) {
    return `${formatNumber(count)} ${count === 1 ? singular : pluralForm}`;
}

// "Bay of Plenty Regional Council" → "Bay of Plenty"
export function councilShortName(name) {
    return String(name || '').replace(/\s+(Regional|District|City)\s+Council$/i, '').trim();
}

// Council text is often ALL CAPS; make it readable.
export function readableText(text) {
    const value = String(text || '').trim().replace(/\s+\|\s+/g, ' — ');
    if (value.length > 6 && value === value.toUpperCase() && /[A-Z]{3}/.test(value)) {
        return value.charAt(0) + value.slice(1).toLowerCase();
    }
    return value;
}

export function truncate(text, max) {
    const value = String(text || '');
    return value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;
}
