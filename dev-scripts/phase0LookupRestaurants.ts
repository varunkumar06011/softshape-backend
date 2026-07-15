import prisma from "../src/lib/prisma";

async function main() {
  const names = ["Vgrand Lounge", "Vgrand Family Restaurant"];
  for (const name of names) {
    const outlets = await prisma.outlet.findMany({
      where: { name: { contains: name, mode: "insensitive" } },
      select: { id: true, name: true },
    });
    console.log(`\nLookup: "${name}"`);
    for (const r of outlets) {
      console.log(`  - id: ${r.id}, name: ${r.name}`);
    }
  }
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); prisma.$disconnect(); });
