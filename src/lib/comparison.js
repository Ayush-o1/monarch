export const CONDITION_RANKS = {
  good: 3,
  minor_wear: 2,
  damaged: 1,
  missing: 0,
};

export function normalizeKey(room, name) {
  const r = (room || '').trim().toLowerCase();
  const n = (name || '').trim().toLowerCase();
  return `${r}|${n}`;
}

export function compareInspections(moveInItems = [], moveOutItems = []) {
  const moveInMap = new Map();
  for (const item of moveInItems) {
    const key = normalizeKey(item.room, item.name);
    moveInMap.set(key, item);
  }

  const moveOutMap = new Map();
  for (const item of moveOutItems) {
    const key = normalizeKey(item.room, item.name);
    moveOutMap.set(key, item);
  }

  const allKeys = new Set([...moveInMap.keys(), ...moveOutMap.keys()]);
  const items = [];

  let worseCount = 0;
  let sameCount = 0;
  let betterCount = 0;
  let newCount = 0;
  let missingCount = 0;

  for (const key of allKeys) {
    const inItem = moveInMap.get(key);
    const outItem = moveOutMap.get(key);

    const room = (outItem || inItem).room;
    const name = (outItem || inItem).name;

    const sanitizeItem = (it) => {
      if (!it) return null;
      return {
        id: it.id,
        room: it.room,
        name: it.name,
        condition: it.condition || null,
        note: it.note || null,
        media: (it.media || []).map((m) => ({ id: m.id })),
      };
    };

    if (inItem && outItem) {
      const inRank =
        inItem.condition in CONDITION_RANKS
          ? CONDITION_RANKS[inItem.condition]
          : null;
      const outRank =
        outItem.condition in CONDITION_RANKS
          ? CONDITION_RANKS[outItem.condition]
          : null;

      let outcome;
      if (inRank === null || outRank === null) {
        outcome = 'same';
        sameCount++;
      } else if (outRank < inRank) {
        outcome = 'worse';
        worseCount++;
      } else if (outRank > inRank) {
        outcome = 'better';
        betterCount++;
      } else {
        outcome = 'same';
        sameCount++;
      }

      items.push({
        room,
        name,
        moveIn: sanitizeItem(inItem),
        moveOut: sanitizeItem(outItem),
        outcome,
      });
    } else if (inItem && !outItem) {
      missingCount++;
      items.push({
        room,
        name,
        moveIn: sanitizeItem(inItem),
        moveOut: null,
        outcome: 'not_in_move_out',
      });
    } else if (!inItem && outItem) {
      newCount++;
      items.push({
        room,
        name,
        moveIn: null,
        moveOut: sanitizeItem(outItem),
        outcome: 'new_at_move_out',
      });
    }
  }

  // Sort deterministically: by room (alphabetical), then name (alphabetical)
  items.sort((a, b) => {
    const rComp = a.room.localeCompare(b.room, undefined, {
      sensitivity: 'accent',
    });
    if (rComp !== 0) return rComp;
    return a.name.localeCompare(b.name, undefined, {
      sensitivity: 'accent',
    });
  });

  return {
    summary: {
      totalMoveIn: moveInItems.length,
      totalMoveOut: moveOutItems.length,
      worse: worseCount,
      same: sameCount,
      better: betterCount,
      newAtMoveOut: newCount,
      notInMoveOut: missingCount,
    },
    items,
  };
}
