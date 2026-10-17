import PDFDocument from 'pdfkit';
import { formatPdfMoney, toPdfText } from './formatters.js';
import { formatEventDetails } from '../../lib/eventFormatting.js';

function formatUtc(isoStr) {
  if (!isoStr) return 'Not yet recorded';
  const d = new Date(isoStr);
  if (Number.isNaN(d.getTime())) return 'Not yet recorded';
  const pad = (n) => String(n).padStart(2, '0');
  const yyyy = d.getUTCFullYear();
  const mm = pad(d.getUTCMonth() + 1);
  const dd = pad(d.getUTCDate());
  const hh = pad(d.getUTCHours());
  const min = pad(d.getUTCMinutes());
  const ss = pad(d.getUTCSeconds());
  return `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss} UTC`;
}

function formatUtcDate(dateStr) {
  if (!dateStr) return 'Not yet recorded';
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return 'Not yet recorded';
  const pad = (n) => String(n).padStart(2, '0');
  const yyyy = d.getUTCFullYear();
  const mm = pad(d.getUTCMonth() + 1);
  const dd = pad(d.getUTCDate());
  return `${yyyy}-${mm}-${dd}`;
}

function formatCondition(cond) {
  if (!cond) return 'Not recorded';
  switch (cond) {
    case 'good':
      return 'Good';
    case 'minor_wear':
      return 'Minor wear';
    case 'damaged':
      return 'Damaged';
    case 'missing':
      return 'Missing';
    default:
      return toPdfText(cond);
  }
}

function formatOutcome(outcome) {
  switch (outcome) {
    case 'worse':
      return '[Worse]';
    case 'same':
      return '[Same]';
    case 'better':
      return '[Better]';
    case 'new_at_move_out':
      return '[New at move-out]';
    case 'not_in_move_out':
      return '[Not in move-out]';
    default:
      return `[${toPdfText(outcome)}]`;
  }
}

function ensureSpace(doc, neededHeight) {
  const bottomMargin = doc.page.margins.bottom || 50;
  if (doc.y + neededHeight > doc.page.height - bottomMargin) {
    doc.addPage();
  }
}

/**
 * Renders the tenancy PDF document.
 *
 * @param {object} data Prepared report data
 * @param {object} [options]
 * @param {boolean} [options.compress=true] Whether to compress streams
 * @returns {PDFKit.PDFDocument} Streamable document
 */
export function createReport(data, { compress = true } = {}) {
  const doc = new PDFDocument({
    size: 'A4',
    margin: 50,
    bufferPages: true,
    compress: compress !== false,
    info: {
      Title: `Handover Record - ${toPdfText(data.tenancy.propertyLabel)}`,
      Author: 'Monarch Handover System',
    },
  });

  const generatedTimeUtc = formatUtc(data.generatedAt);

  // --- Title Section ---
  doc.fontSize(18).font('Helvetica-Bold').fillColor('#111827');
  doc.text(`Handover record: ${toPdfText(data.tenancy.propertyLabel)}`);
  doc.moveDown(0.5);

  // --- Details Block ---
  doc.fontSize(13).font('Helvetica-Bold').fillColor('#1f2937');
  doc.text('Tenancy Details');
  doc.fontSize(10).font('Helvetica').fillColor('#374151');

  const details = [
    `Property Label: ${toPdfText(data.tenancy.propertyLabel)}`,
    `Address: ${toPdfText(data.tenancy.address)}`,
    `Tenant: ${toPdfText(data.tenancy.tenantName)}`,
    `Landlord: ${toPdfText(data.tenancy.landlordName)}`,
    `Deposit: ${formatPdfMoney(data.tenancy.depositPaise)}`,
    `Refund Window: ${data.tenancy.refundWindowDays ? `${data.tenancy.refundWindowDays} days` : 'Not yet recorded'}`,
    `Lease Start: ${formatUtcDate(data.tenancy.leaseStartDate)}`,
    `Status: ${toPdfText(data.tenancy.status)}`,
    `Generated: ${generatedTimeUtc}`,
  ];

  for (const line of details) {
    doc.text(line, { indent: 10 });
  }
  doc.moveDown(1);

  // --- Move-in Record ---
  ensureSpace(doc, 80);
  doc.fontSize(13).font('Helvetica-Bold').fillColor('#1f2937');
  doc.text('Move-in record');

  if (!data.moveIn) {
    doc.fontSize(10).font('Helvetica-Oblique').fillColor('#6b7280');
    doc.text('Not yet recorded', { indent: 10 });
    doc.moveDown(1);
  } else {
    doc.fontSize(10).font('Helvetica').fillColor('#374151');
    doc.text(`Status: ${toPdfText(data.moveIn.status)}`, { indent: 10 });
    doc.text(`Submitted: ${formatUtc(data.moveIn.submittedAt)}`, {
      indent: 10,
    });
    doc.text(`Acknowledged: ${formatUtc(data.moveIn.acknowledgedAt)}`, {
      indent: 10,
    });
    doc.text(
      `Acknowledged By: ${toPdfText(data.moveIn.acknowledgedByName || 'Not yet recorded')}`,
      { indent: 10 }
    );
    doc.moveDown(0.5);

    if (!data.moveIn.rooms || data.moveIn.rooms.length === 0) {
      doc.fontSize(10).font('Helvetica-Oblique').fillColor('#6b7280');
      doc.text('Not yet recorded', { indent: 10 });
    } else {
      for (const roomGroup of data.moveIn.rooms) {
        ensureSpace(doc, 40);
        doc.fontSize(10).font('Helvetica-Bold').fillColor('#1f2937');
        doc.text(toPdfText(roomGroup.room), { indent: 10 });
        doc.font('Helvetica').fillColor('#374151');
        for (const it of roomGroup.items) {
          ensureSpace(doc, 20);
          const noteText = it.note ? ` - Note: "${toPdfText(it.note)}"` : '';
          doc.text(
            `• ${toPdfText(it.name)}: ${formatCondition(it.condition)}${noteText}`,
            { indent: 20 }
          );
        }
      }
    }
    doc.moveDown(1);
  }

  // --- Move-out Record ---
  ensureSpace(doc, 80);
  doc.fontSize(13).font('Helvetica-Bold').fillColor('#1f2937');
  doc.text('Move-out record');

  if (!data.moveOut) {
    doc.fontSize(10).font('Helvetica-Oblique').fillColor('#6b7280');
    doc.text('Not yet recorded', { indent: 10 });
    doc.moveDown(1);
  } else {
    doc.fontSize(10).font('Helvetica').fillColor('#374151');
    doc.text(`Status: ${toPdfText(data.moveOut.status)}`, { indent: 10 });
    doc.text(`Submitted: ${formatUtc(data.moveOut.submittedAt)}`, {
      indent: 10,
    });
    doc.text(`Acknowledged: ${formatUtc(data.moveOut.acknowledgedAt)}`, {
      indent: 10,
    });
    doc.text(
      `Acknowledged By: ${toPdfText(data.moveOut.acknowledgedByName || 'Not yet recorded')}`,
      { indent: 10 }
    );
    doc.moveDown(0.5);

    if (!data.moveOut.rooms || data.moveOut.rooms.length === 0) {
      doc.fontSize(10).font('Helvetica-Oblique').fillColor('#6b7280');
      doc.text('Not yet recorded', { indent: 10 });
    } else {
      for (const roomGroup of data.moveOut.rooms) {
        ensureSpace(doc, 40);
        doc.fontSize(10).font('Helvetica-Bold').fillColor('#1f2937');
        doc.text(toPdfText(roomGroup.room), { indent: 10 });
        doc.font('Helvetica').fillColor('#374151');
        for (const it of roomGroup.items) {
          ensureSpace(doc, 20);
          const noteText = it.note ? ` - Note: "${toPdfText(it.note)}"` : '';
          doc.text(
            `• ${toPdfText(it.name)}: ${formatCondition(it.condition)}${noteText}`,
            { indent: 20 }
          );
        }
      }
    }
    doc.moveDown(1);
  }

  // --- Comparison Section ---
  ensureSpace(doc, 80);
  doc.fontSize(13).font('Helvetica-Bold').fillColor('#1f2937');
  doc.text('Comparison');

  if (!data.comparison || data.comparison.length === 0) {
    doc.fontSize(10).font('Helvetica-Oblique').fillColor('#6b7280');
    doc.text('Not yet recorded', { indent: 10 });
    doc.moveDown(1);
  } else {
    doc.fontSize(10).font('Helvetica').fillColor('#374151');
    for (const comp of data.comparison) {
      ensureSpace(doc, 25);
      const inCond = comp.moveIn
        ? formatCondition(comp.moveIn.condition)
        : 'Not present';
      const outCond = comp.moveOut
        ? formatCondition(comp.moveOut.condition)
        : 'Not present';
      const outcomeLabel = formatOutcome(comp.outcome);

      const line = `${toPdfText(comp.room)} - ${toPdfText(comp.name)}: ${inCond} -> ${outCond} ${outcomeLabel}`;
      doc.text(line, { indent: 10 });
    }
    doc.moveDown(1);
  }

  // --- Deductions Section ---
  ensureSpace(doc, 80);
  doc.fontSize(13).font('Helvetica-Bold').fillColor('#1f2937');
  doc.text('Deductions');

  if (!data.deductions || data.deductions.length === 0) {
    doc.fontSize(10).font('Helvetica-Oblique').fillColor('#6b7280');
    doc.text('Not yet recorded', { indent: 10 });
    doc.moveDown(0.5);
  } else {
    doc.fontSize(10).font('Helvetica').fillColor('#374151');
    for (const line of data.deductions) {
      ensureSpace(doc, 60);
      const linkedItem = line.itemName
        ? `${toPdfText(line.itemRoom)} - ${toPdfText(line.itemName)}`
        : 'None';
      const tenantNote = line.tenantNote
        ? `"${toPdfText(line.tenantNote)}"`
        : 'None';
      const times = `Created: ${formatUtc(line.createdAt)} | Responded: ${formatUtc(line.respondedAt)}`;

      doc.font('Helvetica-Bold').text(`• ${toPdfText(line.description)}`, {
        indent: 10,
      });
      doc.font('Helvetica');
      doc.text(
        `Amount: ${formatPdfMoney(line.amountPaise)} | Status: ${toPdfText(line.status)} | Linked Item: ${linkedItem}`,
        { indent: 20 }
      );
      doc.text(`Tenant Note: ${tenantNote}`, { indent: 20 });
      doc.text(`Proposed By: ${toPdfText(line.createdByName)} | ${times}`, {
        indent: 20,
      });
      doc.moveDown(0.25);
    }
    doc.moveDown(0.5);
  }

  // --- Settlement Summary ---
  ensureSpace(doc, 90);
  doc.fontSize(12).font('Helvetica-Bold').fillColor('#1f2937');
  doc.text('Settlement summary', { indent: 10 });
  doc.fontSize(10).font('Helvetica').fillColor('#374151');

  const s = data.settlement || {
    depositPaise: 0,
    acceptedPaise: 0,
    proposedPaise: 0,
    disputedPaise: 0,
    unclaimedPaise: 0,
  };

  const settlementLines = [
    `Deposit: ${formatPdfMoney(s.depositPaise)}`,
    `Accepted: ${formatPdfMoney(s.acceptedPaise)}`,
    `Awaiting: ${formatPdfMoney(s.proposedPaise)}`,
    `Disputed: ${formatPdfMoney(s.disputedPaise)}`,
    `Unclaimed: ${formatPdfMoney(s.unclaimedPaise)}`,
  ];

  for (const line of settlementLines) {
    doc.text(line, { indent: 20 });
  }
  doc.moveDown(1);

  // --- Timeline Section ---
  ensureSpace(doc, 80);
  doc.fontSize(13).font('Helvetica-Bold').fillColor('#1f2937');
  doc.text('Timeline');

  if (!data.events || data.events.length === 0) {
    doc.fontSize(10).font('Helvetica-Oblique').fillColor('#6b7280');
    doc.text('Not yet recorded', { indent: 10 });
    doc.moveDown(1);
  } else {
    doc.fontSize(10).font('Helvetica').fillColor('#374151');
    for (const ev of data.events) {
      ensureSpace(doc, 30);
      const timeStr = formatUtc(ev.created_at);
      const actorStr = `${toPdfText(ev.actor_label)} (${toPdfText(ev.actor_type)})`;
      const desc = formatEventDetails(ev, (paise) => formatPdfMoney(paise));
      const cleanDesc = desc ? ` - ${toPdfText(desc)}` : '';

      doc.text(
        `• ${timeStr} | ${toPdfText(ev.type.replace(/_/g, ' ').toUpperCase())} by ${actorStr}${cleanDesc}`,
        { indent: 10 }
      );
    }
    doc.moveDown(1);
  }

  // --- Photos Section ---
  ensureSpace(doc, 80);
  doc.fontSize(13).font('Helvetica-Bold').fillColor('#1f2937');
  doc.text('Photos');

  if (!data.photos || data.photos.length === 0) {
    doc.fontSize(10).font('Helvetica-Oblique').fillColor('#6b7280');
    doc.text('Not yet recorded', { indent: 10 });
  } else {
    for (const photo of data.photos) {
      const caption = `${toPdfText(photo.room)} • ${toPdfText(photo.itemName)} • ${toPdfText(photo.side)} • ${formatUtc(photo.uploadedAt)}`;

      if (photo.unavailable) {
        ensureSpace(doc, 35);
        doc.fontSize(9).font('Helvetica-Bold').fillColor('#374151');
        doc.text(caption, { indent: 10 });
        doc.fontSize(9).font('Helvetica-Oblique').fillColor('#9ca3af');
        doc.text('Photo unavailable', { indent: 15 });
        doc.moveDown(0.5);
      } else if (photo.buffer) {
        ensureSpace(doc, 230);
        doc.fontSize(9).font('Helvetica-Bold').fillColor('#374151');
        doc.text(caption, { indent: 10 });
        try {
          doc.image(photo.buffer, {
            fit: [300, 200],
            align: 'left',
          });
          doc.moveDown(0.5);
        } catch {
          doc.fontSize(9).font('Helvetica-Oblique').fillColor('#9ca3af');
          doc.text('Photo unavailable', { indent: 15 });
          doc.moveDown(0.5);
        }
      }
    }

    if (data.morePhotosCount > 0) {
      ensureSpace(doc, 30);
      doc.fontSize(10).font('Helvetica-Oblique').fillColor('#6b7280');
      doc.text(`${data.morePhotosCount} more photos not shown`, { indent: 10 });
    }
  }

  // --- Footers on Every Page ---
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const oldBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;

    doc.fontSize(8).font('Helvetica').fillColor('#6b7280');
    doc.text(
      'Handover records what the parties entered and acknowledged. It is not legal advice.',
      50,
      doc.page.height - 40,
      { align: 'center', width: doc.page.width - 100 }
    );
    doc.text(
      `Page ${i + 1} of ${range.count} • ${generatedTimeUtc}`,
      50,
      doc.page.height - 28,
      { align: 'center', width: doc.page.width - 100 }
    );

    doc.page.margins.bottom = oldBottom;
  }

  doc.end();
  return doc;
}
