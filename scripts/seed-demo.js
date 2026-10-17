import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { createApp } from '../src/app.js';
import { pool as defaultPool } from '../src/db/pool.js';
import { LocalStorage } from '../src/lib/storage/local.js';

// Helper to generate synthetic tinted photos without text
async function createSyntheticPhoto({ r = 180, g = 200, b = 220 } = {}) {
  const svg = `<svg width="400" height="300" xmlns="http://www.w3.org/2000/svg">
    <rect width="400" height="300" fill="rgb(${r},${g},${b})" />
    <rect x="20" y="20" width="360" height="260" fill="none" stroke="rgba(255,255,255,0.5)" stroke-width="6" />
    <circle cx="200" cy="150" r="40" fill="none" stroke="rgba(255,255,255,0.3)" stroke-width="4" />
  </svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 80 }).toBuffer();
}

/**
 * Runs the demo seeding process over the real HTTP API.
 * @param {object} options
 * @param {string} [options.password] - Demo user password (10-72 bytes)
 * @param {boolean} [options.add=false] - Whether to create an additional run if user exists
 * @param {pg.Pool} [options.pool] - Optional database pool to use
 * @param {object} [options.storage] - Optional storage instance
 * @param {boolean} [options.closePool=true] - Whether to close the pool when done
 * @returns {Promise<{ alreadyExists?: boolean, email: string, tenancyAId?: string, tenancyBId?: string, counts?: object }>}
 */
export async function runSeed({
  password = process.env.DEMO_PASSWORD,
  add = false,
  pool = null,
  storage = null,
  closePool = true,
} = {}) {
  if (!password) {
    throw new Error('DEMO_PASSWORD environment variable is required');
  }

  const pwByteLen = Buffer.byteLength(password, 'utf8');
  if (pwByteLen < 10 || pwByteLen > 72) {
    throw new Error('DEMO_PASSWORD must be between 10 and 72 bytes in length');
  }

  let createdTmpDir = null;
  if (!storage && process.env.NODE_ENV === 'test' && !process.env.UPLOAD_DIR) {
    createdTmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'monarch-seed-test-')
    );
    storage = new LocalStorage(createdTmpDir);
  }

  const appPool = pool || defaultPool;
  const app = createApp({
    pool: appPool,
    storage: storage || undefined,
  });

  const server = app.listen(0);
  await once(server, 'listening');
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;

  let sessionCookie = null;

  async function apiFetch(urlPath, options = {}) {
    const headers = {
      Origin: origin,
      ...(options.headers || {}),
    };
    if (sessionCookie && !headers.Cookie && !headers.cookie) {
      headers.Cookie = sessionCookie;
    }

    const res = await fetch(`${origin}${urlPath}`, {
      ...options,
      headers,
    });

    const setCookie = res.headers.get('set-cookie');
    if (setCookie) {
      sessionCookie = setCookie.split(';')[0];
    }

    return res;
  }

  try {
    const demoEmail = 'demo@handover.local';
    const demoName = 'Demo Tenant';

    // 1. Register or login demo user
    let userRes = await apiFetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: demoName,
        email: demoEmail,
        password,
      }),
    });

    if (userRes.status === 409) {
      if (!add) {
        return {
          alreadyExists: true,
          email: demoEmail,
        };
      }
      // If --add is passed, log in
      const loginRes = await apiFetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: demoEmail,
          password,
        }),
      });
      if (!loginRes.ok) {
        throw new Error('Failed to log in as existing demo user');
      }
    } else if (!userRes.ok) {
      const errData = await userRes.json().catch(() => ({}));
      throw new Error(errData.error?.message || 'Failed to register demo user');
    }

    const runSuffix = add ? ` (#${Date.now().toString().slice(-4)})` : '';

    // ==========================================
    // TENANCY A (Settling with 3 deductions)
    // ==========================================
    const labelA = `DEMO - Palm Residency, Flat 3B${runSuffix}`;
    const tenARes = await apiFetch('/api/tenancies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        propertyLabel: labelA,
        landlordName: 'Demo Landlord',
        address: 'Flat 3B, Palm Residency, 4th Cross, Indiranagar, Bengaluru',
        depositPaise: 6000000, // Rs 60,000
        refundWindowDays: 15,
        leaseStartDate: '2025-04-01',
      }),
    });

    if (!tenARes.ok) {
      const err = await tenARes.json().catch(() => ({}));
      throw new Error(
        `Failed to create Tenancy A: ${err.error?.message || tenARes.statusText}`
      );
    }

    const tenancyA = await tenARes.json();
    const tenancyAId = tenancyA.id;
    const moveInAId =
      tenancyA.inspections?.moveIn?.id || tenancyA.moveInInspectionId;

    // Items for Tenancy A Move-in
    const itemsA = [
      {
        room: 'Living room',
        name: 'Ceiling Fan',
        condition: 'good',
        note: 'Working smoothly, high speed, no wobbling',
      },
      {
        room: 'Living room',
        name: 'Main Door Lock',
        condition: 'good',
        note: 'Godrej deadbolt lock engages smoothly, 2 keys',
      },
      {
        room: 'Kitchen',
        name: 'Granite Countertop',
        condition: 'good',
        note: 'Polished granite, clean edges, no cracks or stains',
      },
      {
        room: 'Kitchen',
        name: 'Stainless Steel Sink',
        condition: 'good',
        note: 'Faucets turn easily with strong water pressure',
      },
      {
        room: 'Bedroom',
        name: 'Wooden Wardrobe',
        condition: 'good',
        note: 'Four-door wardrobe, smooth sliding drawers',
      },
      {
        room: 'Bedroom',
        name: 'Window Mesh',
        condition: 'good',
        note: 'Aluminum mesh intact, insect-proof',
      },
      {
        room: 'Bathroom',
        name: 'Geyser 15L',
        condition: 'good',
        note: 'Heats water within 10 minutes, pressure valve functional',
      },
      {
        room: 'Bathroom',
        name: 'Washbasin Mirror',
        condition: 'good',
        note: 'Wall mirror firmly mounted, silvering intact',
      },
    ];

    const createdItemsA = [];
    for (const itemDef of itemsA) {
      const itRes = await apiFetch(`/api/inspections/${moveInAId}/items`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(itemDef),
      });
      if (!itRes.ok) {
        const err = await itRes.json().catch(() => ({}));
        throw new Error(
          `Failed to add move-in item (${itRes.status}): ${err.error?.message || itRes.statusText}`
        );
      }
      createdItemsA.push(await itRes.json());
    }

    let photoCount = 0;

    // Helper to upload synthetic photo to an item
    async function uploadItemPhoto(itemId, tint) {
      const photoBuffer = await createSyntheticPhoto(tint);
      const form = new FormData();
      const blob = new Blob([photoBuffer], { type: 'image/jpeg' });
      form.append('photo', blob, 'inspection_photo.jpg');

      const photoRes = await apiFetch(`/api/items/${itemId}/media`, {
        method: 'POST',
        body: form,
      });
      if (!photoRes.ok) {
        const err = await photoRes.json().catch(() => ({}));
        throw new Error(
          `Failed to upload photo: ${err.error?.message || photoRes.statusText}`
        );
      }
      photoCount++;
    }

    // Upload move-in photos on at least 3 items (Ceiling Fan, Granite Countertop, Stainless Steel Sink)
    await uploadItemPhoto(createdItemsA[0].id, { r: 190, g: 210, b: 230 }); // Fan
    await uploadItemPhoto(createdItemsA[2].id, { r: 210, g: 200, b: 190 }); // Countertop
    await uploadItemPhoto(createdItemsA[3].id, { r: 200, g: 220, b: 210 }); // Sink

    // Submit Move-in A
    const subMoveInA = await apiFetch(`/api/inspections/${moveInAId}/submit`, {
      method: 'POST',
    });
    if (!subMoveInA.ok)
      throw new Error('Failed to submit Move-in inspection A');

    // Generate landlord review link
    const inviteARes = await apiFetch(`/api/tenancies/${tenancyAId}/invite`, {
      method: 'POST',
    });
    if (!inviteARes.ok) {
      const err = await inviteARes.json().catch(() => ({}));
      throw new Error(
        `Failed to create landlord invite: ${err.error?.message || inviteARes.statusText}`
      );
    }
    const inviteData = await inviteARes.json();
    const landlordTokenA =
      inviteData.token ||
      (inviteData.url ? inviteData.url.split('/l/')[1] : null);

    // Landlord acknowledges Move-in A
    const ackRes = await apiFetch(
      `/api/landlord/${encodeURIComponent(landlordTokenA)}/inspections/${moveInAId}/acknowledge`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Demo Landlord' }),
      }
    );
    if (!ackRes.ok) {
      const err = await ackRes.json().catch(() => ({}));
      throw new Error(
        `Failed to acknowledge Move-in inspection A: ${err.error?.message || ackRes.statusText}`
      );
    }

    // Start Move-out A
    const moveOutRes = await apiFetch(`/api/tenancies/${tenancyAId}/move-out`, {
      method: 'POST',
    });
    if (!moveOutRes.ok)
      throw new Error('Failed to start Move-out inspection A');
    const moveOutA = await moveOutRes.json();
    const moveOutAId = moveOutA.inspection?.id || moveOutA.id;

    // Get move-out inspection items
    const moveOutDetailRes = await apiFetch(`/api/inspections/${moveOutAId}`);
    const moveOutDetail = await moveOutDetailRes.json();
    const moveOutItems = moveOutDetail.items || [];

    // Assign conditions to all move-out items (move-out clones start with null condition):
    // 2 worse: Ceiling Fan ('minor_wear'), Granite Countertop ('damaged')
    // 1 better: Main Door Lock ('good', was 'minor_wear')
    // Remaining 5 items: 'good' (same)
    const fanMoveOut = moveOutItems.find((it) => it.name === 'Ceiling Fan');
    const countertopMoveOut = moveOutItems.find(
      (it) => it.name === 'Granite Countertop'
    );

    for (const item of moveOutItems) {
      if (item.name === 'Granite Countertop') {
        await apiFetch(`/api/items/${item.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            condition: 'damaged',
            note: 'Deep crack across front right corner with chipped edge',
          }),
        });
        // Both sides photo: upload move-out photo for countertop
        await uploadItemPhoto(item.id, { r: 230, g: 190, b: 190 });
      } else if (item.name === 'Ceiling Fan') {
        await apiFetch(`/api/items/${item.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            condition: 'minor_wear',
            note: 'Speed regulator stuck on max, noticeable bearing noise',
          }),
        });
        // Both sides photo: upload move-out photo for fan
        await uploadItemPhoto(item.id, { r: 220, g: 210, b: 180 });
      } else if (item.name === 'Main Door Lock') {
        await apiFetch(`/api/items/${item.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            condition: 'good',
            note: 'Upgraded digital smart lock installed with backup physical keys',
          }),
        });
      } else {
        await apiFetch(`/api/items/${item.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            condition: 'good',
            note: 'Clean and well maintained, matches move-in record',
          }),
        });
      }
    }

    // Submit Move-out A -> Tenancy transitions to 'settling'
    const subMoveOutA = await apiFetch(
      `/api/inspections/${moveOutAId}/submit`,
      {
        method: 'POST',
      }
    );
    if (!subMoveOutA.ok) {
      const err = await subMoveOutA.json().catch(() => ({}));
      throw new Error(
        `Failed to submit Move-out inspection A (${subMoveOutA.status}): ${err.error?.message || subMoveOutA.statusText}`
      );
    }

    // 3 Deductions proposed by Landlord:
    // 1. Accepted: Rs 3,500 (linked to countertop)
    const d1Res = await apiFetch(
      `/api/landlord/${encodeURIComponent(landlordTokenA)}/deductions`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Demo Landlord',
          description: 'Granite countertop corner repair and chip filling',
          amountPaise: 350000,
          itemId: countertopMoveOut?.id,
        }),
      }
    );
    if (!d1Res.ok) {
      const err = await d1Res.json().catch(() => ({}));
      throw new Error(
        `Failed to propose deduction line 1: ${err.error?.message || d1Res.statusText}`
      );
    }
    const d1Data = await d1Res.json();
    const d1 = d1Data.line || d1Data;

    // Tenant accepts Line 1
    const accRes = await apiFetch(`/api/deductions/${d1.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'accept' }),
    });
    if (!accRes.ok) {
      const err = await accRes.json().catch(() => ({}));
      throw new Error(
        `Failed to accept deduction line 1: ${err.error?.message || accRes.statusText}`
      );
    }

    // 2. Disputed: Rs 2,000 (linked to fan)
    const d2Res = await apiFetch(
      `/api/landlord/${encodeURIComponent(landlordTokenA)}/deductions`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Demo Landlord',
          description: 'Ceiling fan replacement due to motor bearing noise',
          amountPaise: 200000,
          itemId: fanMoveOut?.id,
        }),
      }
    );
    if (!d2Res.ok) {
      const err = await d2Res.json().catch(() => ({}));
      throw new Error(
        `Failed to propose deduction line 2: ${err.error?.message || d2Res.statusText}`
      );
    }
    const d2Data = await d2Res.json();
    const d2 = d2Data.line || d2Data;

    // Tenant disputes Line 2 with note
    const dispRes = await apiFetch(`/api/deductions/${d2.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'dispute',
        note: 'Motor bearing had minor sound at move-in; does not warrant complete replacement.',
      }),
    });
    if (!dispRes.ok) {
      const err = await dispRes.json().catch(() => ({}));
      throw new Error(
        `Failed to dispute deduction line 2: ${err.error?.message || dispRes.statusText}`
      );
    }

    // 3. Proposed: Rs 1,500 (unlinked)
    const d3Res = await apiFetch(
      `/api/landlord/${encodeURIComponent(landlordTokenA)}/deductions`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Demo Landlord',
          description: 'Deep cleaning fee for kitchen grease and exhaust hood',
          amountPaise: 150000,
        }),
      }
    );
    if (!d3Res.ok) {
      const err = await d3Res.json().catch(() => ({}));
      throw new Error(
        `Failed to propose deduction line 3: ${err.error?.message || d3Res.statusText}`
      );
    }

    // ==========================================
    // TENANCY B (Move-in draft with 5 items and photos)
    // ==========================================
    const labelB = `DEMO - Lake View, Flat 12${runSuffix}`;
    const tenBRes = await apiFetch('/api/tenancies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        propertyLabel: labelB,
        landlordName: 'Demo Landlord',
        address:
          'Flat 12, Lake View Apartments, Outer Ring Road, Bellandur, Bengaluru',
        depositPaise: 4500000, // Rs 45,000
        refundWindowDays: 30,
        leaseStartDate: '2025-05-01',
      }),
    });

    if (!tenBRes.ok) {
      const err = await tenBRes.json().catch(() => ({}));
      throw new Error(
        `Failed to create Tenancy B: ${err.error?.message || tenBRes.statusText}`
      );
    }

    const tenancyB = await tenBRes.json();
    const tenancyBId = tenancyB.id;
    const moveInBId =
      tenancyB.inspections?.moveIn?.id || tenancyB.moveInInspectionId;

    const itemsB = [
      {
        room: 'Hall',
        name: 'Teakwood Sofa Set',
        condition: 'good',
        note: '3+1+1 seater sofa in solid teakwood with beige cushions',
      },
      {
        room: 'Hall',
        name: 'Dining Table (Glass Top)',
        condition: 'good',
        note: '6-seater dining table, glass surface intact',
      },
      {
        room: 'Kitchen',
        name: 'Chimney and Gas Hob',
        condition: 'minor_wear',
        note: 'Chimney filter slightly greasy, 3-burner hob ignites properly',
      },
      {
        room: 'Master Bedroom',
        name: 'King Bed with Mattress',
        condition: 'good',
        note: 'Sturdy wooden frame, 8-inch memory foam mattress',
      },
      {
        room: 'Master Bedroom',
        name: 'Split AC 1.5 Ton',
        condition: 'good',
        note: 'Cooling effective, remote control functional with fresh batteries',
      },
    ];

    const createdItemsB = [];
    for (const itemDef of itemsB) {
      const itRes = await apiFetch(`/api/inspections/${moveInBId}/items`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(itemDef),
      });
      if (!itRes.ok) {
        const err = await itRes.json().catch(() => ({}));
        throw new Error(
          `Failed to add move-in item for Tenancy B (${itRes.status}): ${err.error?.message || itRes.statusText}`
        );
      }
      createdItemsB.push(await itRes.json());
    }

    // Upload photos on a couple of items in Tenancy B
    await uploadItemPhoto(createdItemsB[1].id, { r: 190, g: 220, b: 200 }); // Dining table
    await uploadItemPhoto(createdItemsB[2].id, { r: 210, g: 210, b: 190 }); // Chimney

    return {
      alreadyExists: false,
      email: demoEmail,
      tenancyAId,
      tenancyBId,
      counts: {
        tenancies: 2,
        tenancyA: {
          status: 'settling',
          items: itemsA.length,
          deductions: { accepted: 1, disputed: 1, proposed: 1, total: 3 },
        },
        tenancyB: {
          status: 'active',
          items: itemsB.length,
        },
        photosTotal: photoCount,
      },
    };
  } finally {
    await new Promise((res) => server.close(res));
    if (createdTmpDir && fs.existsSync(createdTmpDir)) {
      try {
        fs.rmSync(createdTmpDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup error
      }
    }
    if (closePool && appPool) {
      await appPool.end();
    }
  }
}

// CLI wrapper
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const add = process.argv.includes('--add');
  runSeed({ add })
    .then((result) => {
      if (result.alreadyExists) {
        console.log('Demo data already exists');
        process.exit(0);
      }
      console.log(`Demo seed complete for ${result.email}:`);
      console.log(
        `- 2 tenancies created: Tenancy A (${result.counts.tenancyA.status}), Tenancy B (${result.counts.tenancyB.status})`
      );
      console.log(`- Deductions: 1 accepted, 1 disputed, 1 proposed (total 3)`);
      console.log(
        `- Photos: ${result.counts.photosTotal} synthetic images uploaded`
      );
      process.exit(0);
    })
    .catch((err) => {
      console.error('Seed failed:', err.message);
      process.exit(1);
    });
}
