// === Shortlist ===
// Consents the user has starred, each with an optional note. Saved in this browser only
// (localStorage); Export in the app turns it into a spreadsheet to share.

const STORAGE_KEY = 'pivotmap.shortlist.v1';
// The previous version of the app kept starred consents in folders under this key.
const OLD_WATCHLIST_KEY = 'boprc_watchlist';

function browserStorage() {
    try { return globalThis.localStorage || null; } catch { return null; }
}

function readJson(storage, key) {
    try {
        const text = storage && storage.getItem(key);
        return text ? JSON.parse(text) : null;
    } catch {
        return null;
    }
}

// Old watchlist folders become shortlist entries, with the folder names kept in the note.
export function migrateWatchlist(old) {
    const items = {};
    const folders = old && Array.isArray(old.folders) ? old.folders : [];
    for (const folder of folders) {
        if (!folder || !Array.isArray(folder.consents)) continue;
        for (const id of folder.consents) {
            if (typeof id !== 'string') continue;
            const item = items[id] || (items[id] = { added: folder.created || new Date().toISOString(), note: '' });
            const label = typeof folder.name === 'string' && folder.name.trim() ? `Folder: ${folder.name.trim()}` : '';
            if (label && !item.note.includes(label)) item.note = item.note ? `${item.note}; ${label}` : label;
        }
    }
    return items;
}

export function createShortlist(storage = browserStorage()) {
    const saved = readJson(storage, STORAGE_KEY);
    let items = saved && saved.items && typeof saved.items === 'object' ? saved.items : null;
    if (!items) {
        items = migrateWatchlist(readJson(storage, OLD_WATCHLIST_KEY));
        if (Object.keys(items).length) persist();
    }
    const listeners = new Set();

    function persist() {
        try { storage && storage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, items })); }
        catch { /* storage full or blocked: keep working in memory */ }
    }
    function changed() {
        persist();
        for (const fn of listeners) fn();
    }

    return {
        has: (id) => Object.prototype.hasOwnProperty.call(items, id),
        count: () => Object.keys(items).length,
        ids: () => Object.keys(items),
        note: (id) => (items[id] ? items[id].note || '' : ''),
        added: (id) => (items[id] ? items[id].added : ''),
        toggle(id) {
            if (this.has(id)) delete items[id];
            else items[id] = { added: new Date().toISOString(), note: '' };
            changed();
            return this.has(id);
        },
        setNote(id, note) {
            if (!items[id]) return;
            items[id].note = String(note || '').slice(0, 2000);
            persist(); // no re-render while typing
        },
        clear() {
            items = {};
            changed();
        },
        onChange(fn) {
            listeners.add(fn);
            return () => listeners.delete(fn);
        }
    };
}
