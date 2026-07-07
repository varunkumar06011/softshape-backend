import { Router } from "express";
import prisma from "../lib/prisma";
import { CHICKEN_BIRYANI_ITEMS, CHICKEN_BIRYANI_RECIPE, getExpectedUnit } from "../services/recipeEngine";

const router = Router();

const CHICKEN_BIRYANI_SET = new Set(CHICKEN_BIRYANI_ITEMS.map((n) => n.toLowerCase()));

export interface BulkPrepLine {
  ingredientName: string;
  scalingType: "linear" | "spice" | "salt";
  perParcelQty: number;
  totalQty: number;
  unit: string;
}

export interface BulkPrepResult {
  riceKg: number;
  parcels: number;
  ratio: number;
  lines: BulkPrepLine[];
  note: string;
}

export function computeBulkPrep(riceKg: number): BulkPrepResult {
  const parcels = riceKg * 5;
  const ratio = 25 / parcels;

  const lines: BulkPrepLine[] = CHICKEN_BIRYANI_RECIPE.map((ingredient) => {
    let adjustedPerParcel: number;
    switch (ingredient.scalingType) {
      case "linear":
        adjustedPerParcel = ingredient.perParcelQty;
        break;
      case "spice":
        adjustedPerParcel = ingredient.perParcelQty * Math.pow(ratio, 0.15);
        break;
      case "salt":
        adjustedPerParcel = ingredient.perParcelQty * Math.pow(ratio, 0.05);
        break;
      default:
        adjustedPerParcel = ingredient.perParcelQty;
    }

    return {
      ingredientName: ingredient.ingredientName,
      scalingType: ingredient.scalingType,
      perParcelQty: Number(adjustedPerParcel.toFixed(4)),
      totalQty: Number((adjustedPerParcel * parcels).toFixed(2)),
      unit: getExpectedUnit(ingredient.ingredientName),
    };
  });

  return {
    riceKg,
    parcels,
    ratio: Number(ratio.toFixed(6)),
    lines,
    note: "Hold back ~15% of spices and salt while cooking, taste near the end, add remainder only if needed.",
  };
}

/** POST /api/kitchen-prep/bulk */
router.post("/bulk", async (req: any, res) => {
  try {
    const { riceKg, menuItemId } = req.body as { riceKg?: number; menuItemId?: string };
    const restaurantId = req.user?.activeRestaurantId ?? req.user?.restaurantId;

    if (!restaurantId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    if (typeof riceKg !== "number" || riceKg <= 0) {
      return res.status(400).json({ error: "riceKg must be a positive number" });
    }

    if (menuItemId !== undefined) {
      const menuItem = await prisma.menuItem.findUnique({
        where: { id: menuItemId },
        select: { name: true, restaurantId: true },
      });

      if (!menuItem) {
        return res.status(400).json({ error: "menuItemId not found" });
      }

      if (menuItem.restaurantId !== restaurantId) {
        return res.status(400).json({ error: "menuItemId does not belong to the authenticated restaurant" });
      }

      if (!CHICKEN_BIRYANI_SET.has(menuItem.name.toLowerCase())) {
        return res.status(400).json({ error: `menuItemId is not a curated chicken biryani item` });
      }
    }

    const result = computeBulkPrep(riceKg);
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message || "Failed to compute bulk prep" });
  }
});

export default router;
