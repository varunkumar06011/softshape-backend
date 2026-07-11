import { Router } from "express";
import prisma from "../lib/prisma";
import {
  CHICKEN_BIRYANI_ITEMS,
  EGG_BIRYANI_ITEMS,
  FISH_BIRYANI_ITEMS,
  MUTTON_BIRYANI_ITEMS,
  PROTEIN_RECIPE_MAP,
  PRAWNS_BIRYANI_ITEMS,
  getExpectedUnit,
} from "../services/recipeEngine";

const router = Router();

type ValidProtein = "chicken" | "egg" | "mutton" | "prawns" | "fish";
const VALID_PROTEINS: ValidProtein[] = ["chicken", "egg", "mutton", "prawns", "fish"];

const PROTEIN_ITEM_SETS: Record<ValidProtein, Set<string>> = {
  chicken: new Set(CHICKEN_BIRYANI_ITEMS.map((n) => n.toLowerCase())),
  egg: new Set(EGG_BIRYANI_ITEMS.map((n) => n.toLowerCase())),
  mutton: new Set(MUTTON_BIRYANI_ITEMS.map((n) => n.toLowerCase())),
  prawns: new Set(PRAWNS_BIRYANI_ITEMS.map((n) => n.toLowerCase())),
  fish: new Set(FISH_BIRYANI_ITEMS.map((n) => n.toLowerCase())),
};

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

export function computeBulkPrep(riceKg: number, protein: ValidProtein = "chicken"): BulkPrepResult {
  const parcels = riceKg * 5;
  const ratio = 25 / parcels;
  const recipe = PROTEIN_RECIPE_MAP[protein];

  const lines: BulkPrepLine[] = recipe.map((ingredient) => {
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

    const unit = getExpectedUnit(ingredient.ingredientName);
    let totalQty = adjustedPerParcel * parcels;
    if (unit === "pcs") {
      totalQty = Math.ceil(totalQty);
    }

    return {
      ingredientName: ingredient.ingredientName,
      scalingType: ingredient.scalingType,
      perParcelQty: Number(adjustedPerParcel.toFixed(4)),
      totalQty: Number(totalQty.toFixed(2)),
      unit,
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
    const { riceKg, protein, menuItemId } = req.body as {
      riceKg?: number;
      protein?: string;
      menuItemId?: string;
    };
    const restaurantId = req.user?.activeRestaurantId ?? req.user?.restaurantId;

    if (!restaurantId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    if (typeof riceKg !== "number" || riceKg <= 0) {
      return res.status(400).json({ error: "riceKg must be a positive number" });
    }

    if (!protein || !VALID_PROTEINS.includes(protein as ValidProtein)) {
      return res.status(400).json({ error: `protein must be one of: ${VALID_PROTEINS.join(", ")}` });
    }
    const selectedProtein = protein as ValidProtein;

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

      if (!PROTEIN_ITEM_SETS[selectedProtein].has(menuItem.name.toLowerCase())) {
        return res.status(400).json({
          error: `menuItemId is not a curated ${selectedProtein} biryani item for this restaurant`,
        });
      }
    }

    const result = computeBulkPrep(riceKg, selectedProtein);
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message || "Failed to compute bulk prep" });
  }
});

export default router;
