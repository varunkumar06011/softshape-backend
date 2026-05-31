import { PrismaClient } from "@prisma/client";
import { restoreBarMenuImagesByType } from "../src/services/restoreBarMenuImages";

const prisma = new PrismaClient();

restoreBarMenuImagesByType(prisma)
  .then((result) => {
    console.log(JSON.stringify(result, null, 2));
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
