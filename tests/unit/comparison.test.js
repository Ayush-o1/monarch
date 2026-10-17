import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  compareInspections,
  normalizeKey,
  CONDITION_RANKS,
} from '../../src/lib/comparison.js';

describe('Comparison Engine (pure logic)', () => {
  it('normalizes matching key by lowercasing and trimming room and name', () => {
    assert.equal(
      normalizeKey('  Living Room  ', 'Main Door'),
      'living room|main door'
    );
    assert.equal(normalizeKey('BEDROOM', '  Wardrobe '), 'bedroom|wardrobe');
    assert.equal(
      normalizeKey('\tKitchen \n', '\r\nRefrigerator\t'),
      'kitchen|refrigerator'
    );
    assert.equal(normalizeKey(null, undefined), '|');
    assert.equal(normalizeKey('', ''), '|');
    assert.equal(
      normalizeKey(' Balcony ', ' Light Fixture '),
      'balcony|light fixture'
    );
  });

  it('matches items regardless of letter case or surrounding whitespace', () => {
    const moveIn = [
      {
        id: '1',
        room: ' Master Bedroom ',
        name: ' AC Unit ',
        condition: 'good',
        note: 'Cold and quiet',
      },
    ];
    const moveOut = [
      {
        id: '2',
        room: 'master bedroom',
        name: 'ac unit',
        condition: 'minor_wear',
        note: 'Filters dusty',
      },
    ];

    const result = compareInspections(moveIn, moveOut);
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].outcome, 'worse');
    assert.equal(result.items[0].moveIn.id, '1');
    assert.equal(result.items[0].moveOut.id, '2');
  });

  it('correctly ranks all condition transitions', () => {
    const conditions = ['good', 'minor_wear', 'damaged', 'missing'];

    for (const inCond of conditions) {
      for (const outCond of conditions) {
        const moveIn = [
          { id: 'in', room: 'Hall', name: 'Item', condition: inCond },
        ];
        const moveOut = [
          { id: 'out', room: 'Hall', name: 'Item', condition: outCond },
        ];
        const res = compareInspections(moveIn, moveOut);

        const inRank = CONDITION_RANKS[inCond];
        const outRank = CONDITION_RANKS[outCond];

        let expectedOutcome;
        if (outRank < inRank) expectedOutcome = 'worse';
        else if (outRank > inRank) expectedOutcome = 'better';
        else expectedOutcome = 'same';

        assert.equal(
          res.items[0].outcome,
          expectedOutcome,
          `Expected ${inCond} -> ${outCond} to be ${expectedOutcome}`
        );
      }
    }
  });

  it('detects missing items as not_in_move_out', () => {
    const moveIn = [
      { id: '1', room: 'Kitchen', name: 'Microwave', condition: 'good' },
    ];
    const moveOut = [];

    const res = compareInspections(moveIn, moveOut);
    assert.equal(res.items.length, 1);
    assert.equal(res.items[0].outcome, 'not_in_move_out');
    assert.equal(res.items[0].moveIn.name, 'Microwave');
    assert.equal(res.items[0].moveOut, null);
    assert.equal(res.summary.notInMoveOut, 1);
  });

  it('detects additional items as new_at_move_out', () => {
    const moveIn = [];
    const moveOut = [
      { id: '2', room: 'Balcony', name: 'Planter', condition: 'good' },
    ];

    const res = compareInspections(moveIn, moveOut);
    assert.equal(res.items.length, 1);
    assert.equal(res.items[0].outcome, 'new_at_move_out');
    assert.equal(res.items[0].moveIn, null);
    assert.equal(res.items[0].moveOut.name, 'Planter');
    assert.equal(res.summary.newAtMoveOut, 1);
  });

  it('handles a comprehensive multi-item scenario with all five outcomes and deterministic sorting', () => {
    const moveIn = [
      {
        id: 'in-1',
        room: 'Kitchen',
        name: 'Sink',
        condition: 'good',
        note: 'No leaks',
        media: [{ id: 'm-in-1' }],
      },
      {
        id: 'in-2',
        room: 'Living Room',
        name: 'Sofa',
        condition: 'good',
        note: 'Clean fabric',
      },
      {
        id: 'in-3',
        room: 'Bedroom',
        name: 'Wall Paint',
        condition: 'minor_wear',
        note: 'Scuff mark',
      },
      {
        id: 'in-4',
        room: 'Balcony',
        name: 'Light Fixture',
        condition: 'good',
        note: 'Works',
      },
    ];

    const moveOut = [
      {
        id: 'out-1',
        room: 'Kitchen',
        name: 'Sink',
        condition: 'damaged',
        note: 'Crack in basin',
        media: [{ id: 'm-out-1' }, { id: 'm-out-2' }],
      },
      {
        id: 'out-2',
        room: 'Living Room',
        name: 'Sofa',
        condition: 'good',
        note: 'Same condition',
      },
      {
        id: 'out-3',
        room: 'Bedroom',
        name: 'Wall Paint',
        condition: 'good',
        note: 'Repainted fresh',
      },
      {
        id: 'out-5',
        room: 'Bathroom',
        name: 'Mirror Cabinet',
        condition: 'good',
        note: 'Tenant added cabinet',
      },
      // Note: Balcony Light Fixture is omitted in moveOut -> not_in_move_out
    ];

    const res = compareInspections(moveIn, moveOut);

    assert.equal(res.summary.total, 5);
    assert.equal(res.summary.added, 1);
    assert.equal(res.summary.missing, 1);
    assert.equal(res.summary.totalMoveIn, 4);
    assert.equal(res.summary.totalMoveOut, 4);
    assert.equal(res.summary.worse, 1); // Sink: good -> damaged
    assert.equal(res.summary.same, 1); // Sofa: good -> good
    assert.equal(res.summary.better, 1); // Wall Paint: minor_wear -> good
    assert.equal(res.summary.notInMoveOut, 1); // Balcony Light Fixture
    assert.equal(res.summary.newAtMoveOut, 1); // Bathroom Mirror Cabinet

    assert.equal(res.items.length, 5);

    // Verify deterministic alphabetical sorting by room, then name:
    // 1. Balcony - Light Fixture
    // 2. Bathroom - Mirror Cabinet
    // 3. Bedroom - Wall Paint
    // 4. Kitchen - Sink
    // 5. Living Room - Sofa
    assert.equal(res.items[0].room, 'Balcony');
    assert.equal(res.items[0].outcome, 'not_in_move_out');

    assert.equal(res.items[1].room, 'Bathroom');
    assert.equal(res.items[1].outcome, 'new_at_move_out');

    assert.equal(res.items[2].room, 'Bedroom');
    assert.equal(res.items[2].outcome, 'better');

    assert.equal(res.items[3].room, 'Kitchen');
    assert.equal(res.items[3].outcome, 'worse');
    assert.equal(res.items[3].moveIn.media.length, 1);
    assert.equal(res.items[3].moveOut.media.length, 2);

    assert.equal(res.items[4].room, 'Living Room');
    assert.equal(res.items[4].outcome, 'same');
  });

  it('handles empty inspections and prototype property condition names safely', () => {
    const emptyRes = compareInspections();
    assert.equal(emptyRes.summary.total, 0);
    assert.equal(emptyRes.items.length, 0);

    const protoItemIn = [
      { id: '1', room: 'Hall', name: 'Key', condition: 'toString' },
    ];
    const protoItemOut = [
      { id: '2', room: 'Hall', name: 'Key', condition: 'toString' },
    ];
    const protoRes = compareInspections(protoItemIn, protoItemOut);
    assert.equal(protoRes.items[0].outcome, 'same');
  });
});
