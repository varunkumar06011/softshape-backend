require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const jwt = require('jsonwebtoken');
const p = new PrismaClient();

async function main() {
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

  const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };
  const BASE = 'http://localhost:3000';
  let pass = 0, fail = 0;

  async function test(name, fn) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
      pass++;
    } catch (err) {
      console.log(`  ✗ ${name}: ${err.message}`);
      fail++;
    }
  }

  // ============================
  // PAYROLL TESTS
  // ============================
  console.log('\n=== PAYROLL ===');

  let employeeId;

  await test('Create employee', async () => {
    const res = await fetch(`${BASE}/api/payroll/employees`, {
      method: 'POST', headers,
      body: JSON.stringify({ name: 'Test Chef Ravi', age: 35, role: 'CHEF', baseSalary: 15000 })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(JSON.stringify(data));
    if (!data.id) throw new Error('No employee ID returned');
    employeeId = data.id;
    console.log(`    Employee: ${data.name}, salary: ${data.baseSalary}`);
  });

  await test('List employees', async () => {
    const res = await fetch(`${BASE}/api/payroll/employees`, { headers });
    const data = await res.json();
    if (!res.ok) throw new Error(JSON.stringify(data));
    if (!Array.isArray(data)) throw new Error('Expected array');
    console.log(`    Found ${data.length} employees`);
  });

  let recordId;
  await test('Create payroll record', async () => {
    const res = await fetch(`${BASE}/api/payroll/records`, {
      method: 'POST', headers,
      body: JSON.stringify({
        employeeId, monthYear: '2026-06',
        absentDays: 2, otDays: 3, advanceAmount: 1000, notes: 'Test payroll'
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(JSON.stringify(data));
    if (!data.id) throw new Error('No record ID returned');
    recordId = data.id;
    console.log(`    Net payable: ${data.netPayable}, status: ${data.status}`);
  });

  await test('Get payroll records', async () => {
    const res = await fetch(`${BASE}/api/payroll/records?monthYear=2026-06`, { headers });
    const data = await res.json();
    if (!res.ok) throw new Error(JSON.stringify(data));
    if (!Array.isArray(data)) throw new Error('Expected array');
    console.log(`    Found ${data.length} records for 2026-06`);
  });

  await test('Make partial payment', async () => {
    const res = await fetch(`${BASE}/api/payroll/records/${recordId}/payment`, {
      method: 'POST', headers,
      body: JSON.stringify({ amount: 5000 })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(JSON.stringify(data));
    console.log(`    Paid: ${data.paidAmount}, status: ${data.status}`);
  });

  await test('Make full payment', async () => {
    const res = await fetch(`${BASE}/api/payroll/records/${recordId}/payment`, {
      method: 'POST', headers,
      body: JSON.stringify({ amount: 20000 })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(JSON.stringify(data));
    console.log(`    Paid: ${data.paidAmount}, status: ${data.status}`);
  });

  // ============================
  // KITCHEN INVENTORY TESTS
  // ============================
  console.log('\n=== KITCHEN INVENTORY ===');

  let itemId;

  await test('Create inventory item', async () => {
    const res = await fetch(`${BASE}/api/inventory/kitchen/items`, {
      method: 'POST', headers,
      body: JSON.stringify({ name: 'Test Rice', unit: 'KG', currentStock: 50, reorderLevel: 10 })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(JSON.stringify(data));
    if (!data.id) throw new Error('No item ID returned');
    itemId = data.id;
    console.log(`    Item: ${data.name}, stock: ${data.currentStock} ${data.unit}`);
  });

  await test('List inventory items', async () => {
    const res = await fetch(`${BASE}/api/inventory/kitchen`, { headers });
    const data = await res.json();
    if (!res.ok) throw new Error(JSON.stringify(data));
    if (!Array.isArray(data)) throw new Error('Expected array');
    console.log(`    Found ${data.length} items`);
  });

  await test('Add stock entry', async () => {
    const res = await fetch(`${BASE}/api/inventory/kitchen/entries`, {
      method: 'POST', headers,
      body: JSON.stringify({ itemId, addStock: 20 })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(JSON.stringify(data));
    console.log(`    Added 20, closing: ${data.closingStock}`);
  });

  await test('Update inventory item', async () => {
    const res = await fetch(`${BASE}/api/inventory/kitchen/items`, {
      method: 'POST', headers,
      body: JSON.stringify({ id: itemId, name: 'Test Rice Updated', unit: 'KG', currentStock: 70, reorderLevel: 15 })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(JSON.stringify(data));
    console.log(`    Updated: ${data.name}, stock: ${data.currentStock}`);
  });

  // ============================
  // CLEANUP
  // ============================
  console.log('\n=== CLEANUP ===');

  await test('Delete payroll record', async () => {
    await p.payrollRecord.delete({ where: { id: recordId } });
  });

  await test('Deactivate employee', async () => {
    const res = await fetch(`${BASE}/api/payroll/employees/${employeeId}`, {
      method: 'DELETE', headers
    });
    const data = await res.json();
    if (!res.ok) throw new Error(JSON.stringify(data));
  });

  await test('Delete inventory item', async () => {
    const res = await fetch(`${BASE}/api/inventory/kitchen/items/${itemId}`, {
      method: 'DELETE', headers
    });
    const data = await res.json();
    if (!res.ok) throw new Error(JSON.stringify(data));
  });

  console.log(`\n=== RESULTS: ${pass} passed, ${fail} failed ===`);
  await p.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
