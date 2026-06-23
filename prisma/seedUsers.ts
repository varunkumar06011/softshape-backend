import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

const SALT_ROUNDS = 12;
const RESTAURANT_ID = "restaurant-001";

const CAPTAIN_NAMES = [
  "Ajay Kumar",
  "Raja Behera",
  "Sagar",
  "Durga Prasad",
  "Subbaiah",
  "Happy",
  "Subbu",
  "Sunil",
  "Rama Rao",
];

function toInternalEmail(name: string): string {
  return name.toLowerCase().replace(/\s+/g, ".") + "@vgrand.internal";
}

async function main() {
  const superAdminEmail = process.env.SEED_SUPER_ADMIN_EMAIL || "superadmin@vgrand.internal";
  const superAdminPassword = process.env.SEED_SUPER_ADMIN_PASSWORD || "superadmin123";
  const adminEmail = process.env.SEED_ADMIN_EMAIL || "admin@vgrand.internal";
  const adminPassword = process.env.SEED_ADMIN_PASSWORD || "admin123";
  const cashierEmail = process.env.SEED_CASHIER_EMAIL || "cashier@vgrand.internal";
  const cashierPassword = process.env.SEED_CASHIER_PASSWORD || "cashier123";
  const captainDefaultPin = process.env.SEED_CAPTAIN_DEFAULT_PIN || "1234";

  // SUPER_ADMIN
  await prisma.staffUser.upsert({
    where: { email: superAdminEmail },
    update: {},
    create: {
      restaurantId: RESTAURANT_ID,
      email: superAdminEmail,
      passwordHash: await bcrypt.hash(superAdminPassword, SALT_ROUNDS),
      role: "SUPER_ADMIN",
      name: "Super Admin",
    },
  });
  console.log("[Seed] SUPER_ADMIN:", superAdminEmail);

  // ADMIN
  await prisma.staffUser.upsert({
    where: { email: adminEmail },
    update: {},
    create: {
      restaurantId: RESTAURANT_ID,
      email: adminEmail,
      passwordHash: await bcrypt.hash(adminPassword, SALT_ROUNDS),
      role: "ADMIN",
      name: "Admin",
    },
  });
  console.log("[Seed] ADMIN:", adminEmail);

  // CASHIER
  await prisma.staffUser.upsert({
    where: { email: cashierEmail },
    update: {},
    create: {
      restaurantId: RESTAURANT_ID,
      email: cashierEmail,
      passwordHash: await bcrypt.hash(cashierPassword, SALT_ROUNDS),
      role: "CASHIER",
      name: "Cashier",
    },
  });
  console.log("[Seed] CASHIER:", cashierEmail);

  // CAPTAINs
  const hashedPin = await bcrypt.hash(captainDefaultPin, SALT_ROUNDS);
  for (const name of CAPTAIN_NAMES) {
    const email = toInternalEmail(name);
    await prisma.staffUser.upsert({
      where: { email },
      update: {},
      create: {
        restaurantId: RESTAURANT_ID,
        email,
        passwordHash: await bcrypt.hash("captain" + Math.random().toString(36).slice(2), SALT_ROUNDS),
        role: "CAPTAIN",
        name,
        pin: hashedPin,
      },
    });
    console.log("[Seed] CAPTAIN:", name, "→", email);
  }

  console.log("[Seed] Done.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
