const { PrismaClient } = require('@prisma/client');
const crypto = require('crypto');
const p = new PrismaClient();

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('JWT_SECRET env var is required');
  process.exit(1);
}

function signToken(payload, expiry = '15m') {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const exp = now + 900; // 15 min
  const body = { ...payload, iat: now, exp };
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const data = `${enc(header)}.${enc(body)}`;
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(data).digest('base64url');
  return `${data}.${sig}`;
}

async function main() {
  const restaurantId = 'cmqy60ci200027dscyj9ubg8h'; // Vgrand Lounge - Z3695J

  // Generate a fake edge session token
  const token = signToken({
    restaurantId,
    purpose: 'agent-session',
    agentId: 'test-diag',
  });

  console.log('Token:', token.substring(0, 50) + '...');
  console.log('Testing: https://api.softshape.in/api/edge/config\n');

  const res = await fetch('https://api.softshape.in/api/edge/config', {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });

  console.log('Status:', res.status, res.statusText);

  if (!res.ok) {
    const text = await res.text();
    console.log('Error response:', text);
    await p.$disconnect();
    return;
  }

  const config = await res.json();

  console.log('\n=== BACKEND RESPONSE COUNTS ===');
  console.log('  outlet:', config.outlet?.name || config.outlet?.id || 'MISSING');
  console.log('  taxProfiles:', config.taxProfiles?.length);
  console.log('  priceProfiles:', config.priceProfiles?.length);
  console.log('  priceProfileItems:', config.priceProfileItems?.length);
  console.log('  venues:', config.venues?.length);
  console.log('  floors:', config.floors?.length);
  console.log('  sections:', config.sections?.length);
  console.log('  tables:', config.tables?.length);
  console.log('  categories:', config.categories?.length);
  console.log('  menuItems:', config.menuItems?.length);
  console.log('  menuVariants:', config.menuVariants?.length);
  console.log('  menuAddons:', config.menuAddons?.length);
  console.log('  venuePrices:', config.venuePrices?.length);
  console.log('  venueAvailability:', config.venueAvailability?.length);
  console.log('  users:', config.users?.length);

  // Check if menu items have restaurantId
  if (config.menuItems && config.menuItems.length > 0) {
    console.log('\n=== SAMPLE MENU ITEM ===');
    console.log(JSON.stringify(config.menuItems[0], null, 2));
  } else {
    console.log('\n!!! NO MENU ITEMS IN RESPONSE !!!');
  }

  if (config.tables && config.tables.length > 0) {
    console.log('\n=== SAMPLE TABLE ===');
    console.log(JSON.stringify(config.tables[0], null, 2));
  } else {
    console.log('\n!!! NO TABLES IN RESPONSE !!!');
  }

  await p.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
