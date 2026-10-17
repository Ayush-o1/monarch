/**
 * Pure settlement calculations for rental deposits and deduction lines.
 *
 * @param {Object} params
 * @param {number|string|bigint} params.depositPaise - Total deposit in paise
 * @param {Array<Object>} [params.lines=[]] - Deduction line objects
 * @param {string|Date|null} [params.moveOutSubmittedAt=null] - Move-out submission timestamp
 * @param {number|null} [params.refundWindowDays=null] - Landlord refund window in days
 * @param {string|Date} [params.now=new Date()] - Reference timestamp for date calculations
 * @returns {Object} Settlement breakdown
 */
export function computeSettlement({
  depositPaise = 0,
  lines = [],
  moveOutSubmittedAt = null,
  refundWindowDays = null,
  now = new Date(),
} = {}) {
  const deposit = Number(depositPaise || 0);

  let acceptedPaise = 0;
  let proposedPaise = 0;
  let disputedPaise = 0;

  let proposedCount = 0;
  let acceptedCount = 0;
  let disputedCount = 0;
  let withdrawnCount = 0;

  for (const line of lines || []) {
    const status = line.status || 'proposed';
    const amount = Number(line.amountPaise ?? line.amount_paise ?? 0);

    switch (status) {
      case 'accepted':
        acceptedPaise += amount;
        acceptedCount++;
        break;
      case 'proposed':
        proposedPaise += amount;
        proposedCount++;
        break;
      case 'disputed':
        disputedPaise += amount;
        disputedCount++;
        break;
      case 'withdrawn':
        withdrawnCount++;
        // Withdrawn lines are excluded from all sums
        break;
      default:
        break;
    }
  }

  const unclaimedPaise =
    deposit - acceptedPaise - proposedPaise - disputedPaise;

  // Days calculations
  let daysSinceMoveOut = null;
  let windowRemainingDays = null;

  if (moveOutSubmittedAt) {
    const submittedTime = new Date(moveOutSubmittedAt).getTime();
    const currentTime = new Date(now).getTime();

    if (!Number.isNaN(submittedTime) && !Number.isNaN(currentTime)) {
      const diffMs = currentTime - submittedTime;
      daysSinceMoveOut = Math.max(
        0,
        Math.floor(diffMs / (24 * 60 * 60 * 1000))
      );

      if (refundWindowDays !== null && refundWindowDays !== undefined) {
        const windowDays = Number(refundWindowDays);
        if (!Number.isNaN(windowDays)) {
          windowRemainingDays = windowDays - daysSinceMoveOut;
        }
      }
    }
  }

  return {
    depositPaise: deposit,
    acceptedPaise,
    proposedPaise,
    disputedPaise,
    unclaimedPaise,
    counts: {
      proposed: proposedCount,
      accepted: acceptedCount,
      disputed: disputedCount,
      withdrawn: withdrawnCount,
      total: (lines || []).length,
    },
    daysSinceMoveOut,
    refundWindowDays:
      refundWindowDays !== null && refundWindowDays !== undefined
        ? Number(refundWindowDays)
        : null,
    windowRemainingDays,
  };
}
