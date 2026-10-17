/**
 * Formats event payload into plain words shared between UI and PDF report.
 *
 * @param {object} ev The event object with type and payload
 * @param {function} formatMoney Formatter function for monetary amounts
 * @returns {string} Plain words description
 */
export function formatEventDetails(ev, formatMoney = (p) => `Rs ${p}`) {
  if (!ev || !ev.payload) return '';
  const parts = [];

  if (ev.payload.depositPaise) {
    parts.push(`Deposit: ${formatMoney(ev.payload.depositPaise)}`);
  }
  if (ev.payload.propertyLabel) {
    parts.push(`Property: ${ev.payload.propertyLabel}`);
  }
  if (ev.payload.refundWindowDays) {
    parts.push(`Refund Window: ${ev.payload.refundWindowDays} days`);
  }
  if (ev.payload.leaseStartDate) {
    parts.push(`Lease Start: ${ev.payload.leaseStartDate}`);
  }
  if (ev.type === 'inspection_submitted') {
    parts.push(
      `${ev.payload.itemCount || 0} items, ${ev.payload.photoCount || 0} photos`
    );
    if (ev.payload.itemsWithoutPhotos > 0) {
      parts.push(`${ev.payload.itemsWithoutPhotos} without photos`);
    }
  }
  if (ev.type === 'changes_requested' && ev.payload.note) {
    parts.push(`"${ev.payload.note}"`);
  }
  if (ev.type === 'inspection_acknowledged') {
    parts.push('Inspection acknowledged and locked');
  }
  if (ev.type === 'move_out_started') {
    parts.push(
      `Move-out inspection started (${ev.payload.itemCount || 0} items cloned)`
    );
  }
  if (ev.type === 'invite_created' && ev.payload.expiresAt) {
    parts.push(
      `Active until ${new Date(ev.payload.expiresAt).toLocaleDateString()}`
    );
  }
  if (ev.type === 'invite_revoked') {
    parts.push('Link revoked');
  }
  if (ev.type === 'deduction_proposed' && ev.payload.amountPaise) {
    parts.push(`Proposed deduction: ${formatMoney(ev.payload.amountPaise)}`);
  }
  if (ev.type === 'deduction_accepted') {
    parts.push(
      ev.payload.note
        ? `Deduction accepted: "${ev.payload.note}"`
        : 'Deduction accepted'
    );
  }
  if (ev.type === 'deduction_disputed') {
    parts.push(`Deduction disputed: "${ev.payload.note}"`);
  }
  if (ev.type === 'deduction_withdrawn') {
    parts.push('Deduction withdrawn');
  }
  if (ev.type === 'tenancy_closed') {
    const closeParts = [
      `Accepted: ${formatMoney(ev.payload.acceptedPaise || 0)}`,
      `Unclaimed: ${formatMoney(ev.payload.unclaimedPaise || 0)}`,
    ];
    if (ev.payload.unresolvedAcknowledged) {
      closeParts.push('unresolved acknowledged');
    }
    parts.push(`Tenancy closed (${closeParts.join(', ')})`);
  }

  return parts.join(' • ');
}
