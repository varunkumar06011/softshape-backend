// ─────────────────────────────────────────────────────────────────────────────
// routes/output.ts — Output Intent API (R2)
// ─────────────────────────────────────────────────────────────────────────────
// Generic POST /api/output/intent endpoint for the cloud backend.
// Renders the intent via the shared package registry and routes the result
// to the print agent via the existing socket room mechanism.
// ─────────────────────────────────────────────────────────────────────────────

import { Router } from "express";
import { render } from "@softshape/output";
import { emitToRestaurant } from "../services/orderService";
import { authenticate, type AuthRequest } from "../middleware/auth";

const router = Router();

router.post("/api/output/intent", authenticate, async (req: AuthRequest, res) => {
  try {
    const intent = req.body;
    if (!intent || intent.type !== "OUTPUT" || !intent.intent) {
      return res.status(400).json({ error: "Invalid output intent" });
    }

    const restaurantId = (req as any).user?.activeRestaurantId || (req as any).user?.restaurantId;
    if (!restaurantId) {
      return res.status(401).json({ error: "Authentication required" });
    }

    const rendered = render(intent.intent, intent.payload);
    if (!rendered) {
      return res.status(400).json({ error: "Render failed" });
    }

    // Map PRINT_ intent types to the Print Agent's expected job type names
    const typeMap: Record<string, string> = {
      PRINT_KOT: "KOT",
      PRINT_LIQUOR_KOT: "BAR_KOT",
      PRINT_BILL: "FINAL_BILL",
      PRINT_CANCEL_KOT: "CANCEL_KOT",
      PRINT_TABLE_SWAP: "TABLE_SWAP",
      PRINT_X_REPORT: "X_REPORT",
      PRINT_EXPENDITURE: "EXPENDITURE",
      PRINT_VOUCHER: "VOUCHER",
      PRINT_RECEIPT: "RECEIPT",
    };
    const jobType = typeMap[intent.intent] || intent.intent;

    await emitToRestaurant(restaurantId, "print_job", {
      type: jobType,
      eventId: intent.intentId,
      data: { ...intent.payload, escposData: rendered.blocks },
    });

    res.json({ ok: true });
  } catch (err: any) {
    console.error("[output] Error processing intent:", err);
    res.status(500).json({ error: "Failed to process output intent" });
  }
});

export default router;
