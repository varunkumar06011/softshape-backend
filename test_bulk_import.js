require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');

const p = new PrismaClient();

async function main() {
  // Get user + restaurant
  const user = await p.user.findFirst({
    where: { email: 'user-a@test.com' },
    include: { restaurant: true }
  });
  if (!user) { console.log('No user found'); process.exit(1); }

  const token = jwt.sign(
    { userId: user.id, email: user.email, role: user.role, restaurantId: user.restaurantId, restaurantCode: user.restaurant.restaurantCode, slug: user.restaurant.slug },
    process.env.JWT_SECRET || 'softshape-secret-key-2024',
    { expiresIn: '24h' }
  );

  console.log('Restaurant ID:', user.restaurantId);
  console.log('Token generated, length:', token.length);

  // Step 1: Upload CSV
  const csvPath = path.join(__dirname, 'family-menu.csv');
  const csvBuffer = fs.readFileSync(csvPath);

  const boundary = '----FormBoundary' + Math.random().toString(36).slice(2);
  const header = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="family-menu.csv"\r\nContent-Type: text/csv\r\n\r\n`;
  const footer = `\r\n--${boundary}--\r\n`;
  const body = Buffer.concat([
    Buffer.from(header, 'utf8'),
    csvBuffer,
    Buffer.from(footer, 'utf8'),
  ]);

  const uploadRes = await fetch('http://localhost:3000/api/menu/upload', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body: body,
  });

  const uploadData = await uploadRes.json();
  console.log('\n=== Upload Result ===');
  console.log('Status:', uploadRes.status);
  console.log('Rows parsed:', uploadData.rows?.length || 0);
  console.log('Confidence:', uploadData.confidence);
  console.log('Warnings:', uploadData.warnings?.length || 0);

  if (!uploadData.rows || uploadData.rows.length === 0) {
    console.log('No rows to import. Exiting.');
    process.exit(1);
  }

  // Step 2: Bulk import
  console.log('\n=== Bulk Import ===');
  const importRes = await fetch('http://localhost:3000/api/menu/bulk-import', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      restaurantId: user.restaurantId,
      rows: uploadData.rows,
    }),
  });

  const importData = await importRes.json();
  console.log('Status:', importRes.status);
  console.log('Created:', importData.created);
  console.log('Skipped:', importData.skipped?.length || 0);
  if (importData.skipped?.length > 0) {
    console.log('Skipped items (first 10):', importData.skipped.slice(0, 10));
  }
  if (importData.error) {
    console.log('Error:', importData.error);
  }

  await p.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
