const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const VENUE_ID = 'venue-001';

// Updated getSectionTag with ID-based disambiguation
function getSectionTag(sectionName, sectionId) {
  if (sectionId === 'section-parcel') return 'venue-restaurant-parcel';
  if (sectionId === 'section-bar-parcel') return 'venue-bar-parcel';
  if (sectionId === 'section-family-restaurant') return 'venue-family-restaurant';
  if (sectionId === 'section-conference') return 'venue-bar-conference';
  if (sectionId === 'section-pdr') return 'venue-bar-pdr';
  if (sectionId === 'section-rooms') return 'venue-bar-rooms';
  const n = (sectionName || '').trim().toLowerCase();
  if (n.includes('bar ac') || n === 'bar hall' || n === 'main hall') return 'venue-bar-ac-hall';
  if (n.includes('conference')) return 'venue-bar-conference';
  if (n.includes('pdr')) return 'venue-bar-pdr';
  if (n.includes('rooms') || n.includes('room')) return 'venue-bar-rooms';
  if (n.includes('parcel') && n.includes('restaurant')) return 'venue-restaurant-parcel';
  if (n.includes('bar') && n.includes('parcel')) return 'venue-bar-parcel';
  if (n.includes('family restaurant')) return 'venue-family-restaurant';
  return 'venue-unknown';
}

async function main() {
  console.log('Running full sectionTag backfill with ID-based disambiguation...');

  const tables = await prisma.table.findMany({
    where: { restaurantId: VENUE_ID },
    include: { section: true },
  });

  let updated = 0;
  for (const table of tables) {
    const tag = getSectionTag(table.section?.name, table.section?.id);
    if (table.sectionTag !== tag) {
      await prisma.table.update({ 
        where: { id: table.id }, 
        data: { sectionTag: tag }
      });
      updated++;
      if (updated <= 10) {
        console.log(`  Updated: Table ${table.number} | Section: ${table.section?.name} (${table.section?.id}) → ${tag}`);
      }
    }
  }
  console.log(`\nTotal updated: ${updated} tables`);

  // Verify
  const result = await prisma.$queryRaw`
    SELECT s.name as "sectionName", s.id as "sectionId", t."sectionTag", COUNT(*)::int as count
    FROM "Table" t
    JOIN "Section" s ON s.id = t."sectionId"
    WHERE t."restaurantId" = 'venue-001'
    GROUP BY s.name, s.id, t."sectionTag"
    ORDER BY s.name
  `;
  console.log('\nFinal DB state:');
  console.table(result);
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
