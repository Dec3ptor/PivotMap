import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    REGIONS, canonicalizeStatus, ddmmyyyyToIsoDate, normalizeRegion, timestampToIsoDate
} from '../scripts/regions.mjs';

const region = (id) => REGIONS.find(r => r.id === id);
const point = (lng, lat, properties) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [lng, lat] }, properties });

describe('timestampToIsoDate', () => {
    it('reads NZ-local midnight timestamps (BOPRC) as the NZ date', () => {
        assert.equal(timestampToIsoDate(1790766000000), '2026-10-01'); // 11:00 UTC the day before (NZDT)
        assert.equal(timestampToIsoDate(149947200000), '1974-10-03');  // 12:00 UTC the day before (NZST)
    });
    it('reads UTC-midnight timestamps as the same date', () => {
        assert.equal(timestampToIsoDate(1544659200000), '2018-12-13');
        assert.equal(timestampToIsoDate('1544659200000'), '2018-12-13');
    });
    it('returns an empty string for missing or invalid values', () => {
        for (const value of [null, undefined, '', 'not a date', NaN]) assert.equal(timestampToIsoDate(value), '');
    });
});

describe('ddmmyyyyToIsoDate', () => {
    it('converts day-first dates', () => {
        assert.equal(ddmmyyyyToIsoDate('21/05/1996'), '1996-05-21');
        assert.equal(ddmmyyyyToIsoDate(' 1/7/2017 '), '2017-07-01');
        assert.equal(ddmmyyyyToIsoDate('15/09/2026'), '2026-09-15');
    });
    it('rejects impossible or malformed dates', () => {
        for (const value of ['31/02/2020', '2020-01-01', '10/11/12', '', null, 42]) assert.equal(ddmmyyyyToIsoDate(value), '');
    });
});

describe('canonicalizeStatus', () => {
    it('maps equivalent council status words onto one label', () => {
        assert.equal(canonicalizeStatus('Active'), 'Current');
        assert.equal(canonicalizeStatus(' granted '), 'Current');
        assert.equal(canonicalizeStatus('Lapsed Consent'), 'Lapsed');
        assert.equal(canonicalizeStatus('Expired - S.124 Protection'), 'Expired - S.124 Protection');
        assert.equal(canonicalizeStatus(null), '');
    });
});

describe('normalizeRegion', () => {
    it('keeps only usable points and rounds coordinates to 6 decimals', () => {
        const records = normalizeRegion(region('NRC'), {
            features: [
                point(174.211386463206, -35.7766602018448, { IRISID: 'A' }),
                point(0, 0, { IRISID: 'placeholder' }),
                point(200, -35, { IRISID: 'out of range' }),
                { type: 'Feature', geometry: null, properties: { IRISID: 'no geometry' } },
                { type: 'Feature', geometry: { type: 'Polygon', coordinates: [] }, properties: { IRISID: 'polygon' } },
                point(174.5, -35.5, {})
            ]
        });
        assert.deepEqual(records.map(r => [r.lng, r.lat, r.fields.ConsentID]), [
            [174.211386, -35.77666, 'A'],
            // Fallback IDs count valid points only, as the app always has
            [174.5, -35.5, 'NRC-2']
        ]);
    });

    it('returns no records for an empty or malformed collection', () => {
        assert.deepEqual(normalizeRegion(region('NRC'), null), []);
        assert.deepEqual(normalizeRegion(region('NRC'), { features: 'nope' }), []);
    });
});

describe('region field mappings', () => {
    it('BOPRC', () => {
        const [r] = normalizeRegion(region('BOPRC'), { features: [point(176.2, -38.1, {
            ConsentID: '20169.0.01-DC+', ProjectNumber: '20169', Status: 'Current', PrimaryConsentHolder: 'Polynesian Spa Limited',
            ExpiryDate: 1790766000000, GrantedDate: 149947200000, FactorySupplyNumber: null,
            GlobalID: '{B2417088-72BA-4D91-9D1B-843E66BB2D40}'
        })] });
        assert.equal(r.fields.ConsentID, '20169.0.01-DC+');
        assert.equal(r.fields.HolderDisplay, 'Polynesian Spa Limited');
        assert.equal(r.fields.ExpiryDate, '2026-10-01');
        assert.equal(r.fields.GrantedDate, '1974-10-03');
        assert.equal(r.fields.FactorySupplyNumber, '');
        assert.equal(r.fields.GlobalID, '{B2417088-72BA-4D91-9D1B-843E66BB2D40}');
    });

    it('HBDC', () => {
        const [r] = normalizeRegion(region('HBDC'), { features: [point(176.4, -39.8, {
            AuthorisationIRISID: 'AUTH-121535-12', ApplicationHistoricID: 'WP140555Tj', WorkflowID: null,
            AuthorisationCurrentStatus: 'Current', AuthorisationType: 'Deemed Permitted Activity',
            AuthPrimaryPurpose: null, ActPrimaryPurpose: 'Water Supply - Irrigation', ExpiryDate: 2064182400000,
            LocalAuthority: "Central Hawke's Bay District", DateWaterMeterRequired: '10/11/2012', WellNumber: '1859'
        })] });
        assert.equal(r.fields.ConsentID, 'AUTH-121535-12');
        assert.equal(r.fields.ProjectNumber, 'WP140555Tj');
        assert.equal(r.fields.Purpose, 'Water Supply - Irrigation');
        assert.equal(r.fields.HolderDisplay, "Central Hawke's Bay District");
        assert.equal(r.fields.DeemedPermitted, 'Yes');
        assert.equal(r.fields.ExpiryDate, '2035-05-31');
        assert.equal(r.fields.DateWaterMeterRequired, '2012-11-10');
        assert.equal(r.fields.GlobalID, 'HBDC:AUTH-121535-12');
    });

    it('NRC has no expiry dates', () => {
        const [r] = normalizeRegion(region('NRC'), { features: [point(174.2, -35.7, {
            IRISID: 'AUT.031115.01.01', ActivityType: 'Bore Consent', ActivitySubType: 'Bore Construction', CurrentStatus: 'Expired'
        })] });
        assert.equal(r.fields.GlobalID, 'NRC:AUT.031115.01.01');
        assert.equal(r.fields.NoExpiryDateAvailable, true);
        assert.equal(r.fields.Purpose, 'Bore Consent');
    });

    it('GWRC parses DD/MM/YYYY dates and builds a documents link', () => {
        const [r] = normalizeRegion(region('GWRC'), { features: [point(174.9, -40.8, {
            RC_CON_FILENO: 'WGN95018302', RCstatus: 'Active', ConsentType: '', ConsentTyp: 'Coastal Permit',
            commencement_date: '21/05/1996', ExpiredDate: '29/04/2001', ElapsedDate: null, DMfolder: 'WGN950183'
        })] });
        assert.equal(r.fields.Status, 'Current');
        assert.equal(r.fields.Subtype, 'Coastal Permit');
        assert.equal(r.fields.GrantedDate, '1996-05-21');
        assert.equal(r.fields.ExpiryDate, '2001-04-29');
        assert.equal(r.fields.StatusDate, '');
        assert.equal(r.fields.PublicDocumentsLink, 'https://concessions.gw.govt.nz/documents/archive/?q=WGN95018302');
    });

    it('every region maps a consent ID, status and GlobalID', () => {
        for (const def of REGIONS) {
            const [r] = normalizeRegion(def, { features: [point(175, -38, {})] });
            assert.ok(r.fields.ConsentID, `${def.id} ConsentID`);
            assert.ok(r.fields.GlobalID, `${def.id} GlobalID`);
            assert.equal(typeof r.fields.Status, 'string', `${def.id} Status`);
            assert.match(def.url, /^https:\/\/.+\/(MapServer|FeatureServer)\/\d+$/, `${def.id} url`);
        }
    });
});
