// ─────────────────────────────────────────────────────────────────────────────
// ota.ts — OTA web bundle update endpoints for Capacitor Android apps
// ─────────────────────────────────────────────────────────────────────────────
// Replaces the server.url OTA mechanism. Android apps load from local bundled
// assets and check this endpoint for JS bundle updates.
//
//   GET /api/ota/version   — returns latest web bundle version + download info
//   GET /api/ota/health    — simple health check (no auth required)
//
// The version is driven by environment variables so deployments can update
// the bundle without code changes:
//   OTA_BUNDLE_VERSION  — semver string, e.g. "10.0.1"
//   OTA_BUNDLE_URL      — public download URL for the bundle ZIP
//   OTA_BUNDLE_SHA256   — SHA-256 hash of the bundle ZIP for integrity verification
//
// Desktop apps (Tauri) use the Tauri updater for full-app updates — no OTA
// endpoint needed for them.
// ─────────────────────────────────────────────────────────────────────────────

import { Router, type Response } from "express";
import logger from "../lib/logger";

const router = Router();

// ─── GET /api/ota/version — Latest web bundle metadata ───────────────────────
//
// No authentication required — this is a public endpoint. The bundle itself
// is served from a CDN/GitHub Releases, not from this server. This endpoint
// just tells the app what version is available and where to download it.
//
// Response: {
//   version: string,          — semver, e.g. "10.0.1"
//   downloadUrl: string,      — URL to download the bundle ZIP
//   sha256: string,           — expected SHA-256 hash of the ZIP
//   minAppVersion: string,    — minimum native app version required (optional)
//   releaseNotes: string|null — human-readable changelog
// }

router.get("/version", (_req: any, res: Response) => {
  try {
    const version = process.env.OTA_BUNDLE_VERSION || null;
    const downloadUrl = process.env.OTA_BUNDLE_URL || null;
    const sha256 = process.env.OTA_BUNDLE_SHA256 || null;
    const minAppVersion = process.env.OTA_BUNDLE_MIN_APP_VERSION || null;
    const releaseNotes = process.env.OTA_BUNDLE_RELEASE_NOTES || null;

    if (!version || !downloadUrl || !sha256) {
      // No OTA bundle configured — app stays on its bundled assets
      return res.json({
        version: null,
        downloadUrl: null,
        sha256: null,
        minAppVersion: null,
        releaseNotes: null,
      });
    }

    res.json({
      version,
      downloadUrl,
      sha256,
      minAppVersion,
      releaseNotes,
    });
  } catch (err: any) {
    logger.error({ err }, "[OTA] Version endpoint error");
    res.status(500).json({ error: "Failed to fetch OTA version" });
  }
});

// ─── GET /api/ota/health — Simple health check ───────────────────────────────

router.get("/health", (_req: any, res: Response) => {
  res.json({ ok: true, service: "ota" });
});

export default router;
