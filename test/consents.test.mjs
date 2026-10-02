import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    addMonthsIso, classifyHolder, classifyWork, countStages, csvEscape, dayNumber, describeTimeLeft,
    enrich, expandRegionData, filterConsents, freshwaterCapDate, groupByHolder, lodgeByDate,
    lodgementAdvice, sortConsents, statusGroup, todayNumber, toCsv
} from '../public/js/consents.js';

const TODAY = dayNumber('2026-10-01');

// A consent as expandRegionData() would produce it, with enrich() applied.
function consent(fields) {
    const [p] = expandRegionData({ region: fields.Region || 'BOPRC', fields: [], constants: {}, records: [[176, -38]] });
    Object.assign(p, fields);
    return enrich(p, TODAY);
}

describe('dates', () => {
    it('counts whole calendar days', () => {
        assert.equal(dayNumber('2026-10-02') - dayNumber('2026-10-01'), 1);
        assert.equal(dayNumber('2027-04-05') - dayNumber('2026-09-27'), 190); // across NZ daylight saving
        assert.equal(dayNumber('not a date'), null);
        assert.equal(dayNumber(''), null);
    });

    it("reads today's date in local time", () => {
        assert.equal(todayNumber(new Date(2026, 9, 1, 23, 59)), dayNumber('2026-10-01'));
        assert.equal(todayNumber(new Date(2026, 9, 1, 0, 1)), dayNumber('2026-10-01'));
    });

    it('adds calendar months, clamping to shorter months', () => {
        assert.equal(addMonthsIso('2027-08-31', -6), '2027-02-28');
        assert.equal(addMonthsIso('2028-08-31', -6), '2028-02-29');
        assert.equal(addMonthsIso('2026-01-15', -6), '2025-07-15');
        assert.equal(addMonthsIso('1992-02-29', 35 * 12), '2027-02-28');
        assert.equal(addMonthsIso('', 6), '');
    });
});

describe('statusGroup', () => {
    it('groups council status words', () => {
        const cases = {
            Current: 'live', 'Not yet commenced': 'live', 'Variation Applies': 'live', 'Current - S125 Review pre IRIS': 'live',
            'Expired s124': 'renewing', 'Expired - S.124 Protection': 'renewing', 'Existing Use Protection Applies (s124)': 'renewing',
            Processing: 'pending', 'On Hold': 'pending', 'Under Appeal': 'pending',
            Expired: 'ended', Surrenderred: 'ended', 'Lapsed (s125)': 'ended', Superseded: 'ended', '': 'unknown'
        };
        for (const [status, group] of Object.entries(cases)) assert.equal(statusGroup(status), group, status);
    });
});

describe('classifyWork', () => {
    const cases = [
        // [Region, Subtype, Category, Purpose, expected]
        ['WRC', 'Water Permit', 'Ground water take', 'Agricultural farming - dairy', 'water'],
        ['WRC', 'Discharge Permit', 'Farm animal effluent onto land', 'Agricultural farming - dairy', 'farm'],
        ['WRC', 'Land Use Consent', 'Whitebait stand', 'Whitebaiting', 'minor'],
        ['WRC', 'Coastal Permit', 'Occupation', 'Coastal - mooring', 'minor'],
        ['WRC', 'Land Use Consent', 'Bed - structure', 'Transport services - road', 'roads'],
        ['WRC', 'Discharge Permit', 'Water - stormwater', 'Stormwater municipal', 'stormwater'],
        ['WRC', 'Land Use Consent', 'Land - well', 'Water supply - municipal/community', 'water'],
        ['WRC', 'NES - Plantation Forestry 2017', 'Harvesting', 'Forestry', 'forestry'],
        ['HBDC', 'Resource Consent', 'Orchard', 'Water Supply - Irrigation', 'water'],
        ['HBDC', 'Resource Consent', 'Residential - Single property', 'Sewage - Secondary Treated', 'minor'],
        ['HBDC', 'Resource Consent', 'Government', 'Sewage - Secondary Treated', 'wastewater'],
        ['HBDC', 'Resource Consent', 'Agriculture - Dairying', 'Wastewater - Untreated', 'farm'],
        ['HRC', 'Water Permit', 'Municipal Water Supply', 'Municipal or Drinking Water Supply', 'water'],
        ['HRC', 'Land Use Permit', 'Forestry', 'Forestry | Earthworks or Quarrying', 'forestry'],
        ['HRC', 'Water Permit', 'Agriculture', 'Agriculture | Pasture Cultivation (Irrigation, Animal Effluent, Fertiliser or Biosolids)', 'water'],
        ['BOPRC', 'Discharge', 'Water', 'Discharge dairyshed waste via oxid ponds', 'farm'],
        ['BOPRC', 'Land Use', 'Bore', 'Install & test a bore', 'minor'],
        ['BOPRC', 'Water Use', 'Geothermal', 'take geothermal fluid for space heating', 'energy'],
        ['BOPRC', 'Coastal', 'Dredging', 'Remove Dredged Material from the Coastal Marine Area', 'coastal'],
        ['NRC', 'Bore Construction', '', 'Bore Consent', 'minor'],
        ['NRC', 'MM4 Swing Mooring', '', 'Coastal Permit', 'minor'],
        ['NRC', 'Dam Water Take', '', 'Water Take', 'water'],
        ['NRC', 'Sewage', '', 'Land Discharge', 'wastewater'],
        ['TRC', 'Discharge Permit', '', 'To discharge farm dairy effluent onto land', 'farm'],
        ['TRC', 'Land Use Consent', '', 'To install and use a pipeline for conveying hydrocarbons under the bed of an unnamed tributary', 'energy'],
        ['TRC', 'Coastal Permit', '', 'To discharge treated municipal wastewater from the Patea Wastewater Treatment Plant into the Coastal Marine Area', 'wastewater'],
        ['TRC', 'Land Use Consent', '', 'To install piping in an unnamed tributary of the Waingongoro River, including streambed disturbance and reclamation', 'rivers'],
        ['GDC', 'RC', '', 'Construct Roads And Landings, Fell Trees And Extract Logs By Ground Based Methods', 'forestry'],
        ['GDC', 'SG', '', 'PROPOSED STAGED SUBDIVISION OF 125 WHEATSTONE ROAD', 'land'],
        ['GDC', 'LV', '', '**CLUSTER VARIATION** To change the "in accordance" conditions', 'forestry'],
        ['GDC', 'LL', '', 'To undertake road remedial works along Waikura Road', 'roads'],
        ['GWRC', 'Coastal', 'CP - BOATSHED', 'To continue occupying the coastal marine area with an existing boatshed structure.', 'minor'],
        ['GWRC', 'Discharge', 'DP - DISCHARGE TO AIR', 'to discharge contaminants to air from a crematorium', 'industry'],
        ['GWRC', 'Water Use', 'WP - SURFACE WATER DIVERSION', 'to permanently divert the Wainuiomata River around rock riprap set in cement', 'rivers'],
        ['GWRC', 'Water Use', 'WP - GROUNDWATER TAKE', 'to take groundwater for irrigation', 'water'],
        ['BOPRC', 'Pre-Application', 'NA', '', 'other']
    ];
    for (const [Region, Subtype, Category, Purpose, expected] of cases) {
        it(`${Region}: ${Purpose || Subtype} → ${expected}`, () => {
            assert.equal(classifyWork({ Region, Subtype, Category, Purpose }), expected);
        });
    }
});

describe('classifyHolder', () => {
    it('classifies published holder names', () => {
        const cases = {
            'Whakatane District Council': 'public',
            'Waka Kotahi NZ Transport Agency (Regional Office)': 'public',
            'Department of Internal Affairs (Taupo Harbourmaster)': 'public',
            'Manawa Energy Limited': 'utility',
            'Port of Tauranga Limited': 'utility',
            'Port Blakely Limited': 'business',
            'Oji Fibre Solutions (NZ) Limited': 'business',
            'Kaingaroa Timberlands': 'business',
            'P and J McCarthy': 'private',
            'Lisa and John Dalziel Family Trust': 'private'
        };
        for (const [name, type] of Object.entries(cases)) {
            assert.deepEqual(classifyHolder({}, name), { type, inferred: false }, name);
        }
    });

    it('guesses the holder type from the activity when no name is published', () => {
        assert.deepEqual(classifyHolder({ Subtype: 'Water Permit', Category: 'Municipal Water Supply', Purpose: '' }, ''), { type: 'public', inferred: true });
        assert.deepEqual(classifyHolder({ Subtype: 'Water Permit', Category: '', Purpose: 'take water for stock' }, ''), { type: 'unknown', inferred: false });
    });

    it("doesn't treat Hawke's Bay districts or Waikato's \"Private\" as holder names", () => {
        const hb = consent({ Region: 'HBDC', HolderDisplay: 'Hastings District', LocalAuthority: 'Hastings District', Status: 'Current' });
        assert.equal(hb._holder, '');
        const wrc = consent({ Region: 'WRC', PrimaryConsentHolder: 'Private', HolderDisplay: 'Private', Status: 'Current' });
        assert.equal(wrc._holder, '');
        assert.equal(wrc._holderType, 'private');
        const amp = consent({ Region: 'WRC', PrimaryConsentHolder: 'R Mourits &amp; G Oldham', Status: 'Current' });
        assert.equal(amp._holder, 'R Mourits & G Oldham');
    });
});

describe('enrich', () => {
    it('works out timing from the expiry date', () => {
        const p = consent({ Status: 'Current', ExpiryDate: '2027-03-31' });
        assert.equal(p._status, 'live');
        assert.equal(p._days, 181);
        assert.equal(p._stage, 'now');
        assert.equal(lodgeByDate(p), '2026-09-30');
        assert.deepEqual(lodgementAdvice(p, TODAY), { kind: 'discretion', deadline: '2026-12-31', missed: '2026-09-30' });
        assert.deepEqual(lodgementAdvice(consent({ Status: 'Current', ExpiryDate: '2028-06-01' }), TODAY), { kind: 'ok', deadline: '2027-12-01' });
        assert.deepEqual(lodgementAdvice(consent({ Status: 'Current', ExpiryDate: '2026-11-15' }), TODAY), { kind: 'late' });
    });

    it('treats placeholder and missing expiry dates as no expiry', () => {
        for (const ExpiryDate of ['9999-08-18', '']) {
            const p = consent({ Status: 'Current', ExpiryDate });
            assert.equal(p._expiry, '');
            assert.equal(p._days, null);
            assert.equal(p._stage, 'none');
        }
    });

    it('marks consents that are no longer current', () => {
        assert.equal(consent({ Status: 'Expired', ExpiryDate: '2027-01-01' })._stage, 'ended');
        assert.equal(consent({ Status: 'Current', ExpiryDate: '2026-09-01' })._stage, 'past');
    });

    it('flags law-change dates', () => {
        assert.equal(consent({ Status: 'Current', ExpiryDate: '2027-12-31' })._lawExtended, true);
        const capped = consent({ Status: 'Current', Subtype: 'Water Take', Category: 'Ground', Purpose: 'take groundwater for irrigation', GrantedDate: '1992-12-31', ExpiryDate: '2027-12-31' });
        assert.equal(capped._firm, 'cap');
        assert.equal(freshwaterCapDate(capped), '2027-12-31');
        const younger = consent({ Status: 'Current', Subtype: 'Water Take', Category: 'Ground', Purpose: 'take groundwater for irrigation', GrantedDate: '2012-06-01', ExpiryDate: '2027-12-31' });
        assert.equal(younger._firm, '');
        const network = consent({ Status: 'Current', PrimaryConsentHolder: 'Tauranga City Council', Subtype: 'Discharge', Category: 'Water', Purpose: 'discharge treated wastewater from the Te Maunga wastewater treatment plant', ExpiryDate: '2027-06-30' });
        assert.equal(network._work, 'wastewater');
        assert.equal(network._firm, 'wastewater');
    });
});

describe('filterConsents', () => {
    const records = [
        consent({ ConsentID: 'A', Region: 'BOPRC', Status: 'Current', ExpiryDate: '2026-12-01', PrimaryConsentHolder: 'Tauranga City Council', Subtype: 'Discharge', Category: 'Water', Purpose: 'discharge stormwater from the city network' }),
        consent({ ConsentID: 'B', Region: 'WRC', Status: 'Current', ExpiryDate: '2027-12-31', PrimaryConsentHolder: 'Kaingaroa Tipu Limited', Subtype: 'NES - Plantation Forestry 2017', Category: 'Harvesting', Purpose: 'Forestry' }),
        consent({ ConsentID: 'C', Region: 'GWRC', Status: 'Current', ExpiryDate: '2030-01-01', Subtype: 'Coastal', Category: 'CP - MOORING', Purpose: 'swing mooring' }),
        consent({ ConsentID: 'D', Region: 'BOPRC', Status: 'Expired', ExpiryDate: '2027-01-01', Subtype: 'Discharge', Category: 'Water', Purpose: 'discharge stormwater' }),
        consent({ ConsentID: 'E', Region: 'BOPRC', Status: 'Expired s124', ExpiryDate: '2027-02-01', Subtype: 'Water Take', Category: 'Ground', Purpose: 'take groundwater' })
    ];
    const ids = (f) => filterConsents(records, f).map(p => p.ConsentID);

    it('limits to current consents expiring within the window', () => {
        assert.deepEqual(ids({ window: '6m' }), ['A']);
        assert.deepEqual(ids({ window: '2y' }), ['A', 'B']);
        assert.deepEqual(ids({ window: '5y' }), ['A', 'B', 'C']);
        assert.deepEqual(ids({ window: 'all' }), ['A', 'B', 'C', 'D', 'E']);
        assert.deepEqual(ids({ window: '2y', includeRenewing: true }), ['A', 'B', 'E']);
    });

    it('filters by region, work type, holder type and holder', () => {
        assert.deepEqual(ids({ window: 'all', regions: new Set(['WRC', 'GWRC']) }), ['B', 'C']);
        assert.deepEqual(ids({ window: '5y', workTypes: new Set(['stormwater', 'forestry']) }), ['A', 'B']);
        assert.deepEqual(ids({ window: '5y', holderTypes: new Set(['public']) }), ['A']);
        assert.deepEqual(ids({ window: 'all', holder: 'Kaingaroa Tipu Limited' }), ['B']);
    });

    it('applies the law-change toggles', () => {
        assert.deepEqual(ids({ window: '5y', hideLawExtended: true }), ['A', 'C']);
        assert.deepEqual(ids({ window: '5y', firmOnly: true }), []);
    });

    it('matches every search word anywhere in the record', () => {
        assert.deepEqual(ids({ window: 'all', terms: ['tauranga', 'stormwater'] }), ['A']);
        assert.deepEqual(ids({ window: 'all', terms: ['MOORING'.toLowerCase()] }), ['C']);
        assert.deepEqual(ids({ window: 'all', terms: ['gwrc'] }), ['C']);
    });
});

describe('sorting and grouping', () => {
    const records = [
        consent({ ConsentID: '1', Status: 'Current', ExpiryDate: '2028-01-01', PrimaryConsentHolder: 'Beta Ltd' }),
        consent({ ConsentID: '2', Status: 'Current', ExpiryDate: '', PrimaryConsentHolder: 'Alpha Ltd' }),
        consent({ ConsentID: '3', Status: 'Current', ExpiryDate: '2027-01-01', PrimaryConsentHolder: 'Beta Ltd' }),
        consent({ ConsentID: '4', Status: 'Current', ExpiryDate: '2029-01-01', Region: 'GWRC' })
    ];

    it('sorts by expiry with undated consents last', () => {
        assert.deepEqual(sortConsents([...records], 'soonest').map(p => p.ConsentID), ['3', '1', '4', '2']);
        assert.deepEqual(sortConsents([...records], 'latest').map(p => p.ConsentID), ['4', '1', '3', '2']);
        assert.deepEqual(sortConsents([...records], 'holder').map(p => p.ConsentID), ['2', '3', '1', '4']);
    });

    it('groups by holder, biggest first', () => {
        const { holders, unnamed } = groupByHolder(records);
        assert.equal(unnamed, 1);
        assert.deepEqual(holders.map(h => [h.name, h.count, h.soonest && h.soonest.ConsentID]), [['Beta Ltd', 2, '3'], ['Alpha Ltd', 1, null]]);
    });

    it('counts consents per urgency stage', () => {
        const counts = countStages(records);
        assert.equal(counts.now, 1);   // 2027-01-01 is 92 days away
        assert.equal(counts.plan, 1);
        assert.equal(counts.later, 1);
        assert.equal(counts.none, 1);
    });
});

describe('describeTimeLeft', () => {
    it('reads naturally', () => {
        assert.equal(describeTimeLeft(null), 'No expiry date');
        assert.equal(describeTimeLeft(0), 'Expires today');
        assert.equal(describeTimeLeft(1), 'Expires tomorrow');
        assert.equal(describeTimeLeft(45), 'Expires in 45 days');
        assert.equal(describeTimeLeft(181), 'Expires in 6 months');
        assert.equal(describeTimeLeft(1000), 'Expires in 2.7 years');
        assert.equal(describeTimeLeft(-3), 'Expired 3 days ago');
    });
});

describe('CSV', () => {
    it('quotes and neutralises values', () => {
        assert.equal(csvEscape('plain'), 'plain');
        assert.equal(csvEscape('a, "b"'), '"a, ""b"""');
        assert.equal(csvEscape('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
        assert.equal(csvEscape(-12), '-12');
        assert.equal(csvEscape(null), '');
    });

    it('starts with a BOM so Excel reads UTF-8', () => {
        assert.equal(toCsv(['A', 'B'], [['Tairāwhiti', 1]]), '﻿A,B\r\nTairāwhiti,1\r\n');
    });
});
