import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    REGIONS, canonicalizeStatus, ddmmyyyyToIsoDate, endDate, keepRecord, normalizeRegion, text, timestampToIsoDate
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

    it("reads Canterbury's issued and terminated statuses", () => {
        assert.equal(canonicalizeStatus('Issued - Active'), 'Current');
        assert.equal(canonicalizeStatus('Issued - Inactive'), 'Issued - Inactive');
        assert.equal(canonicalizeStatus('Terminated - Replaced'), 'Replaced');
        assert.equal(canonicalizeStatus('Terminated - Annulled '), 'Annulled');
    });
});

describe('text', () => {
    it('decodes HTML entities and tidies whitespace', () => {
        assert.equal(text('R Mourits &amp; G Oldham'), 'R Mourits & G Oldham');
        assert.equal(text('Discharge treated wastewater \r\nto land  '), 'Discharge treated wastewater to land');
        assert.equal(text(null, ' second '), 'second');
        assert.equal(text(), '');
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

    it('converts NZTM coordinates a server sent instead of WGS84', () => {
        const [r] = normalizeRegion(region('GDC'), { features: [point(2030138, 5706422, { ConsentApplication: '10000' })] });
        assert.deepEqual([r.lng, r.lat], [177.944306, -38.686259]);
    });

    it('merges rows that repeat one consent at several locations', () => {
        const bore = { IRISID: 'AUT.1', ActivityType: 'Bore Consent', CurrentStatus: 'Current' };
        const records = normalizeRegion(region('NRC'), { features: [
            point(174.1, -35.1, bore),
            point(174.2, -35.2, bore),
            // Same number, different consent: kept, with its own GlobalID
            point(174.3, -35.3, { ...bore, ActivityType: 'Water Take' }),
            point(174.4, -35.4, { ...bore, ActivityType: 'Water Take' })
        ] });
        assert.deepEqual(records.map(r => [r.fields.GlobalID, r.lng, r.fields.Purpose]), [
            ['NRC:AUT.1', 174.1, 'Bore Consent'],
            ['NRC:AUT.1#2', 174.3, 'Water Take']
        ]);
    });

    it('lists the differing details of merged rows', () => {
        const well = (n) => ({ AuthorisationIRISID: 'AUTH-1', AuthorisationCurrentStatus: 'Current', ActPrimaryPurpose: 'Water Supply', WellNumber: n });
        const [r, ...rest] = normalizeRegion(region('HBDC'), { features: [point(176.1, -39.1, well('1859')), point(176.2, -39.2, well('1860')), point(176.3, -39.3, well('1859'))] });
        assert.equal(rest.length, 0);
        assert.equal(r.fields.WellNumber, '1859; 1860');
        assert.equal(r.fields.FactorySupplyNumber, '1859; 1860');
    });

    it("fills in GlobalID when a region's mapping leaves it out", () => {
        const def = { id: 'X', normalize: (p) => ({ ConsentID: p.id, Status: 'Current' }) };
        const [r] = normalizeRegion(def, { features: [point(175, -38, { id: 'A' })] });
        assert.equal(r.fields.GlobalID, 'X:A');
    });
});

describe('keepRecord', () => {
    const cutoff = '2016-11-05';

    it('keeps current, renewing and in-progress consents however old', () => {
        assert.equal(keepRecord({ Status: 'Current', ExpiryDate: '1990-01-01' }, cutoff), true);
        assert.equal(keepRecord({ Status: 'Expired - S.124 Protection', ExpiryDate: '2001-01-01' }, cutoff), true);
        assert.equal(keepRecord({ Status: 'Processing' }, cutoff), true);
    });

    it('keeps ended consents for ten years after they end', () => {
        assert.equal(keepRecord({ Status: 'Expired', ExpiryDate: '2017-03-01' }, cutoff), true);
        assert.equal(keepRecord({ Status: 'Expired', ExpiryDate: '2015-03-01' }, cutoff), false);
        // Replaced early: the date it ended counts, not its original expiry
        assert.equal(keepRecord({ Status: 'Replaced', ExpiryDate: '2041-01-01', StatusDate: '2010-06-30' }, cutoff), false);
        // No end date: the latest other date (placeholder expiries don't count)
        assert.equal(keepRecord({ Status: 'Withdrawn', LodgedDate: '2020-01-01' }, cutoff), true);
        assert.equal(keepRecord({ Status: 'Expired', ExpiryDate: '9999-12-31', GrantedDate: '1990-01-01' }, cutoff), false);
    });

    it('keeps undated consents, but not undated applications that never became one', () => {
        assert.equal(keepRecord({ Status: 'Expired' }, cutoff), true); // Northland publishes no dates
        assert.equal(keepRecord({ Status: 'Application Withdrawn' }, cutoff), false);
        assert.equal(keepRecord({ Status: 'Refused' }, cutoff), false);
    });

    it('works out when a consent ended', () => {
        assert.equal(endDate({ StatusDate: '2020-01-01', ExpiryDate: '2030-01-01' }), '2020-01-01');
        assert.equal(endDate({ ExpiryDate: '2030-01-01', GrantedDate: '2000-01-01' }), '2030-01-01');
        assert.equal(endDate({ GrantedDate: '2000-01-01', LodgedDate: '2001-02-03' }), '2001-02-03');
        assert.equal(endDate({}), '');
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
        assert.equal(r.fields.PrimaryConsentHolder, 'Polynesian Spa Limited');
        assert.equal(r.fields.HolderDisplay, undefined); // the app reads the holder field
        assert.equal(r.fields.ExpiryDate, '2026-10-01');
        assert.equal(r.fields.GrantedDate, '1974-10-03');
        assert.equal(r.fields.FactorySupplyNumber, '');
        assert.equal(r.fields.GlobalID, '{B2417088-72BA-4D91-9D1B-843E66BB2D40}');
    });

    it("HBDC reads the Hub copy's ISO dates and activity type", () => {
        const [r] = normalizeRegion(region('HBDC'), { features: [point(176.8, -39.6, {
            AuthorisationIRISID: 'AUTH-133051-02', AuthorisationType: 'Resource Consent', AuthorisationActivityType: 'Discharge Permit',
            AuthorisationCurrentStatus: 'Current', AuthPrimaryPurpose: 'Stormwater', AuthPrimaryIndustry: 'Fruit/Vegetable Packhouse',
            DecisionServedDate: '2026-10-13T00:00:00Z', ExpiryDate: '2041-05-31T00:00:00Z',
            DocumentLink: 'https://consents.hbrc.govt.nz/consentdocuments/AUTH-133051-02.pdf'
        })] });
        assert.equal(r.fields.Subtype, 'Discharge Permit');
        assert.equal(r.fields.Category, 'Fruit/Vegetable Packhouse');
        assert.equal(r.fields.GrantedDate, '2026-10-13');
        assert.equal(r.fields.ExpiryDate, '2041-05-31');
        assert.equal(r.fields.DeemedPermitted, '');
        assert.equal(r.fields.PublicDocumentsLink, 'https://consents.hbrc.govt.nz/consentdocuments/AUTH-133051-02.pdf');
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
        // The district isn't the consent holder; Hawke's Bay doesn't publish holders
        assert.equal(r.fields.HolderDisplay, undefined);
        assert.equal(r.fields.LocalAuthority, "Central Hawke's Bay District");
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

    it('TRC maps the activity subtype and commencement date', () => {
        const [r] = normalizeRegion(region('TRC'), { features: [point(174.1, -39.5, {
            Consent: 'R2/0017-3.1', Status: 'Current', ActivityType: 'Water Permit', Activity_Subtype: 'Water - Take',
            AuthorisationDescription: 'To take and use water from the Waiokura Stream', CommencementDate: 1544659200000, ExpiryDate: 1874966400000
        })] });
        assert.equal(r.fields.Category, 'Water - Take');
        assert.equal(r.fields.GrantedDate, '2018-12-13');
        assert.equal(r.fields.ExpiryDate, '2029-06-01');
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

    it('ECAN joins its activities and dates when a consent ended early', () => {
        const [r] = normalizeRegion(region('ECAN'), { features: [point(171.57, -44.1, {
            ConsentNo: 'CRC150783', ConsentType: 'Water Permit (s14)', ConsentStatus: 'Terminated - Replaced', FileNo: 'CRC150783',
            HolderName: 'Brander Farms Limited', Location: 'Pyes Road, LOWCLIFFE', fmDate: 1404172800000,
            toDate: 1686009600000, toDateText: 'Termination Date', Expires: 2041286400000,
            GIS_TerritorialAuthority: 'Ashburton District', GIS_CWMSZone: 'Ashburton', GIS_Catchment: '6920600 - Stormy Creek',
            Activities: [
                { FeatureType: 'Water Take/Use', ActivityText: 'Take Groundwater' },
                { FeatureType: 'Irrigation Area', ActivityText: 'Take Groundwater' },
                { FeatureType: 'Bore Gallery', ActivityText: null }
            ]
        })] });
        assert.equal(r.fields.Status, 'Replaced');
        assert.equal(r.fields.PrimaryConsentHolder, 'Brander Farms Limited');
        assert.equal(r.fields.Subtype, 'Water Permit (s14)');
        assert.equal(r.fields.Purpose, 'Take Groundwater; Bore Gallery');
        assert.equal(r.fields.Category, 'Water Take/Use; Irrigation Area; Bore Gallery');
        assert.equal(r.fields.LocalAuthority, 'Ashburton District');
        assert.equal(r.fields.WaterManagementZone, 'Ashburton');
        assert.equal(r.fields.WaterManagementArea, 'Stormy Creek');
        assert.deepEqual([r.fields.GrantedDate, r.fields.ExpiryDate, r.fields.StatusDate], ['2014-07-01', '2034-09-08', '2023-06-06']);
        assert.equal(r.fields.PublicDocumentsLink, 'https://www.ecan.govt.nz/data/consent-search/consentdetails/CRC150783');
        assert.equal(r.fields.GlobalID, 'ECAN:CRC150783');
    });

    it('ORC', () => {
        const [r] = normalizeRegion(region('ORC'), { features: [point(169.4, -46.0, {
            ConsentNumber: 'RM22.031.02', ConsentType: 'Discharge to Land Permit', ConsentStatus: 'Current',
            ConsentHolder: 'Grasslands Otago Limited', ExpiryDate: 2118394800000, DistrictAuthority: 'Clutha District',
            PurposeActivity: 'To discharge liquid animal effluent to land', ConsentCatchment: 'Flynn Road'
        })] });
        assert.equal(r.fields.ConsentID, 'RM22.031.02');
        assert.equal(r.fields.PrimaryConsentHolder, 'Grasslands Otago Limited');
        assert.equal(r.fields.ExpiryDate, '2037-02-17');
        assert.equal(r.fields.LocalAuthority, 'Clutha District');
        assert.equal(r.fields.WaterManagementArea, 'Flynn Road');
        assert.equal(r.fields.GlobalID, 'ORC:RM22.031.02');
    });

    it('ES maps current and expired consents (expired ones have no holder)', () => {
        const def = region('ES');
        assert.equal(def.layers.length, 1);
        const [current, expired] = normalizeRegion(def, { features: [
            point(168.35, -45.67, {
                IRISID: 'AUTH-20242166-02', Contact: 'J J & A M Coppus', Type: 'Water Permit', Subtype: 'Groundwater Take (Consumptive)',
                Details: 'To take and use up to 210,000 L/day of groundwater', StartDate: 1737284400000, ExpiryDate: 2064139200000,
                CommonName: '657 Elli Road, Mossburn - E44/0514', Primary_: 'Dairying - Cows', Status: 'Current'
            }),
            point(168.32, -46.09, { IRISID: 'AUTH-20146460', Type: 'Water Permit', Status: 'Expired' })
        ] });
        assert.equal(current.fields.PrimaryConsentHolder, 'J J & A M Coppus');
        assert.equal(current.fields.Category, 'Groundwater Take (Consumptive)');
        assert.equal(current.fields.Industry, 'Dairying - Cows');
        assert.equal(current.fields.SiteAddress, '657 Elli Road, Mossburn - E44/0514');
        assert.deepEqual([current.fields.GrantedDate, current.fields.ExpiryDate], ['2025-01-20', '2035-05-31']);
        assert.equal(expired.fields.PrimaryConsentHolder, '');
        assert.equal(expired.fields.GlobalID, 'ES:AUTH-20146460');
    });

    it('MDC derives a status from the decision and leaves out subdivisions', () => {
        const base = { ConsentTypeParentDescription: 'Land use', ConsentTypeDescription: 'Land Use - Activity', ApplicantNames: 'Gratton, Carl' };
        const records = normalizeRegion(region('MDC'), { features: [
            point(174.1, -41.2, { ...base, ConsentNumber: '130606.01', ConsentNumberPFOL: 'U130606', DecisionMadeDescription: 'Granted',
                DecisionDate: 1381230000000, ExpiryDate: 1887966000000, ConsentStatusDescription: 'Active',
                PropertyFilesLink: 'https://www.marlborough.govt.nz/services/property-files-online?searchType=Resource+Consent+Number&resourceConsentNumber=U130606' }),
            point(174.2, -41.3, { ...base, ConsentNumber: '250647.TMP.12577', DecisionMadeDescription: null, ConsentStatusDescription: null }),
            point(174.3, -41.4, { ...base, ConsentNumber: '200001.01', DecisionMadeDescription: 'Withdrawn/Closed', DecisionDate: 1381230000000 }),
            point(174.4, -41.5, { ...base, ConsentNumber: '200002.01', ConsentTypeParentDescription: 'Subdivision', ConsentStatusDescription: 'Active' })
        ] });
        assert.deepEqual(records.map(r => [r.fields.ConsentID, r.fields.Status, r.fields.GrantedDate, r.fields.StatusDate]), [
            ['130606.01', 'Current', '2013-10-09', ''],
            ['250647.TMP.12577', 'Application in process', '', ''],
            ['200001.01', 'Withdrawn', '', '2013-10-09']
        ]);
        assert.equal(records[0].fields.Subtype, 'Land Use - Activity');
        assert.equal(records[0].fields.ExpiryDate, '2029-10-30');
        assert.equal(records[0].fields.ProjectNumber, 'U130606');
    });

    it('WCRC trims file numbers', () => {
        const [r] = normalizeRegion(region('WCRC'), { features: [point(170.96, -42.72, {
            filenumber: 'RC88054     ', currentstatus: 'Current', nameforservice: 'West Coast Regional Council',
            authorisationtype: 'Resource Consent', authorisationactivitytype: 'Land Use Consent',
            authorisationactivitysubtype: 'Works in or on Beds of Rivers and Lakes', authdescription: 'To deposit excavated material',
            commencementdate: 1484006400000, expirydate: 2588371200000, locality: 'Granite Creek'
        })] });
        assert.equal(r.fields.ConsentID, 'RC88054');
        assert.equal(r.fields.GlobalID, 'WCRC:RC88054');
        assert.equal(r.fields.Category, 'Works in or on Beds of Rivers and Lakes');
        assert.deepEqual([r.fields.GrantedDate, r.fields.ExpiryDate], ['2017-01-10', '2052-01-09']);
        assert.equal(r.fields.SiteAddress, 'Granite Creek');
    });

    it('every region maps a consent ID, status and GlobalID', () => {
        const layerUrl = /^https:\/\/.+\/(MapServer|FeatureServer)\/\d+$/;
        assert.equal(new Set(REGIONS.map(r => r.id)).size, REGIONS.length);
        for (const def of REGIONS) {
            const records = normalizeRegion(def, { features: [point(175, -38, {})] });
            if (!records.length) continue; // a region may leave out records it can't classify
            const [r] = records;
            assert.ok(r.fields.ConsentID, `${def.id} ConsentID`);
            assert.ok(r.fields.GlobalID, `${def.id} GlobalID`);
            assert.equal(typeof r.fields.Status, 'string', `${def.id} Status`);
            for (const url of [def.url, ...(def.layers || []), ...(def.details ? [def.details.url] : [])]) {
                assert.match(url, layerUrl, `${def.id} url`);
            }
            if (def.fallback) assert.match(def.fallback.hubItemId, /^[0-9a-f]{32}$/, `${def.id} Hub item`);
        }
    });
});
