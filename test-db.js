const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const prisma = new PrismaClient();
async function main() {
    const tables = await prisma.table.findMany({ include: { section: true } });
    const tags = [...new Set(tables.map(t => t.sectionTag))];
    
    // Check tables per section tag
    const grouped = {};
    for (const t of tables) {
        if (!grouped[t.sectionTag]) grouped[t.sectionTag] = [];
        grouped[t.sectionTag].push({ number: t.number, sectionName: t.section?.name });
    }
    fs.writeFileSync('tables-output.json', JSON.stringify({tags, grouped}, null, 2));
}
main().finally(() => prisma.$disconnect());
