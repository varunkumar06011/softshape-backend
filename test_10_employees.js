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

  const employees = [
    { name: 'Ravi Kumar', age: 32, role: 'CHEF', baseSalary: 18000 },
    { name: 'Anita Sharma', age: 28, role: 'WAITER', baseSalary: 12000 },
    { name: 'Mohammed Ali', age: 35, role: 'CASHIER', baseSalary: 15000 },
    { name: 'Priya Patel', age: 26, role: 'WAITER', baseSalary: 11500 },
    { name: 'Suresh Reddy', age: 40, role: 'MANAGER', baseSalary: 25000 },
    { name: 'Lakshmi Devi', age: 45, role: 'CHEF', baseSalary: 20000 },
    { name: 'Karan Singh', age: 29, role: 'BARTENDER', baseSalary: 14000 },
    { name: 'Divya Nair', age: 31, role: 'CAPTAIN', baseSalary: 16000 },
    { name: 'Arjun Rao', age: 27, role: 'WAITER', baseSalary: 11000 },
    { name: 'Sneha Gupta', age: 33, role: 'CLEANER', baseSalary: 10000 },
  ];

  console.log('Creating 10 employees...\n');
  const created = [];

  for (let i = 0; i < employees.length; i++) {
    const emp = employees[i];
    const res = await fetch(`${BASE}/api/payroll/employees`, {
      method: 'POST',
      headers,
      body: JSON.stringify(emp)
    });
    const data = await res.json();
    if (!res.ok) {
      console.log(`  ✗ ${emp.name}: ${JSON.stringify(data)}`);
    } else {
      console.log(`  ✓ ${i + 1}. ${data.name} — ${data.role} — ₹${data.baseSalary}`);
      created.push(data);
    }
  }

  console.log(`\n=== Total created: ${created.length} ===`);
  console.log('\nView them in browser or via API:');
  console.log(`curl -H "Authorization: Bearer ${token}" http://localhost:3000/api/payroll/employees`);

  await p.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
