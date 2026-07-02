import { Prisma } from "@prisma/client";
import { isBeerItem } from "./itemHelpers";
import { BAR_UNIT_ML } from "./barConstants";
import logger from "../lib/logger";

const MARKUP_PERCENTAGE = 150;

/**
 * Auto-updates menu item variant prices based on the new cost per bottle.
 * Extracted from barInventory.ts to avoid duplication between PATCH and record-purchase.
 *
 * @param tx - Prisma transaction client
 * @param menuItemId - The menu item ID whose variants should be updated
 * @param bottleSize - Bottle size in ml
 * @param costPerBottle - New cost per bottle
 * @param skipPriceUpdate - If true, no price update is performed (opt-out flag)
 */
export async function autoUpdateVariantPrices(
  tx: any,
  menuItemId: string,
  bottleSize: number,
  costPerBottle: number,
  skipPriceUpdate?: boolean
): Promise<void> {
  if (skipPriceUpdate) {
    logger.info(`[BarInventory] Skipping auto-price-update for ${menuItemId} (skipPriceUpdate=true)`);
    return;
  }

  const menuItemWithVariants = await tx.menuItem.findUnique({
    where: { id: menuItemId },
    include: { variants: true },
  });

  if (!menuItemWithVariants || menuItemWithVariants.variants.length === 0) return;

  const isBeer = isBeerItem(menuItemWithVariants);
  const isSpirit = !isBeer && menuItemWithVariants.variants.some(
    (v: any) => v.name.trim().toLowerCase() === "30ml"
  );
  const mlPerUnit = isBeer ? 650 : isSpirit ? BAR_UNIT_ML : Number(bottleSize);

  for (const variant of menuItemWithVariants.variants) {
    const costPerMl = Number(costPerBottle) / bottleSize;
    const costForPour = costPerMl * mlPerUnit;
    const newPrice = Math.round(costForPour * (1 + MARKUP_PERCENTAGE / 100));

    await tx.menuItemVariant.update({
      where: { id: variant.id },
      data: { price: new Prisma.Decimal(newPrice) },
    });
  }

  logger.info(
    `[BarInventory] Auto-updated prices for ${menuItemWithVariants.name} based on new cost ₹${costPerBottle} (markup: ${MARKUP_PERCENTAGE}%)`
  );
}
