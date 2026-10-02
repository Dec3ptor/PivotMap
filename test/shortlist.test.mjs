import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createShortlist, migrateWatchlist } from '../public/js/shortlist.js';

// In-memory stand-in for localStorage.
function memoryStorage(initial = {}) {
    const data = { ...initial };
    return {
        data,
        getItem: (key) => (key in data ? data[key] : null),
        setItem: (key, value) => { data[key] = String(value); }
    };
}

describe('shortlist', () => {
    it('stars, notes and clears consents', () => {
        const storage = memoryStorage();
        const list = createShortlist(storage);
        let changes = 0;
        list.onChange(() => changes++);
        assert.equal(list.toggle('BOPRC:1'), true);
        list.setNote('BOPRC:1', 'Call in March');
        assert.equal(list.note('BOPRC:1'), 'Call in March');
        assert.deepEqual(createShortlist(storage).ids(), ['BOPRC:1']); // persisted
        assert.equal(list.toggle('BOPRC:1'), false);
        assert.equal(list.count(), 0);
        assert.equal(changes, 2);
    });

    it('carries over the old watchlist folders', () => {
        const old = { folders: [
            { name: 'Tauranga', consents: ['A', 'B'], created: '2026-01-01T00:00:00.000Z' },
            { name: 'Hot leads', consents: ['B', 42] }
        ] };
        const items = migrateWatchlist(old);
        assert.deepEqual(Object.keys(items), ['A', 'B']);
        assert.equal(items.A.note, 'Folder: Tauranga');
        assert.equal(items.B.note, 'Folder: Tauranga; Folder: Hot leads');

        const storage = memoryStorage({ boprc_watchlist: JSON.stringify(old) });
        assert.deepEqual(createShortlist(storage).ids(), ['A', 'B']);
        assert.ok(storage.data['pivotmap.shortlist.v1']);
        assert.ok(storage.data.boprc_watchlist, 'the old watchlist is left in place');
    });

    it('copes with missing or broken storage', () => {
        assert.equal(createShortlist(null).count(), 0);
        const broken = memoryStorage({ 'pivotmap.shortlist.v1': '{not json' });
        assert.equal(createShortlist(broken).count(), 0);
        assert.deepEqual(migrateWatchlist(null), {});
    });
});
