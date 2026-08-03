// ─────────────────────────────────────────────────────────────────────────────
// App Update Manifest — shared version policy and release metadata builder
// ─────────────────────────────────────────────────────────────────────────────
// Provides strict semver parsing, app/platform allowlist validation, and
// manifest construction for both Tauri desktop and Capacitor Android clients.
//
// Configuration is read exclusively from environment variables so releases can
// be promoted, reverted, or marked mandatory without code changes. No stale
// fallbacks are permitted: missing or invalid metadata fails safely with a
// controlled error rather than guessing a production version.
// ─────────────────────────────────────────────────────────────────────────────

import logger from "./logger";
import { basePrisma } from "../lib/prisma";

export type SemverParts = {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
};

export type AppPlatform = "cashier/windows" | "captain/android";

export type UpdateManifest = {
  app: string;
  platform: string;
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  mandatory: boolean;
  downloadUrl: string | null;
  releaseNotes: string | null;
  sha256: string | null;
  size: number | null;
  signature: string | null;
  packageId: string | null;
  certificateDigest: string | null;
  publishedAt: string | null;
};

export type TauriManifest = {
  version: string;
  notes: string;
  pub_date: string;
  platforms: Record<string, { signature: string; url: string }>;
};

const MAX_COMPONENT = 999_999;
const MAX_LENGTH = 64;

const ALLOWED = new Set<string>(["cashier/windows", "captain/android"]);

function isNonNegativeInt(n: number): boolean {
  return Number.isInteger(n) && n >= 0 && n <= MAX_COMPONENT;
}

export function parseSemver(version: string): SemverParts | null {
  if (!version || typeof version !== "string") return null;
  const trimmed = version.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_LENGTH) return null;

  // Optional single 'v' or 'V' prefix
  const withoutPrefix = trimmed.replace(/^v/i, "");

  // Split core and prerelease.  We accept numeric core + optional prerelease.
  const [core, ...rest] = withoutPrefix.split("-");
  if (!core || rest.length > 1) return null;

  const coreParts = core.split(".");
  if (coreParts.length !== 3) return null;

  const numbers = coreParts.map((p) => {
    if (!/^\d+$/.test(p)) return null;
    const n = parseInt(p, 10);
    return isNonNegativeInt(n) ? n : null;
  });

  if (numbers.some((n) => n === null)) return null;

  const [major, minor, patch] = numbers as [number, number, number];
  const prerelease = rest.length === 1 ? rest[0].trim() || null : null;

  // Reject empty prerelease segments
  if (prerelease !== null && !/^[A-Za-z0-9.]+$/.test(prerelease)) return null;

  return { major, minor, patch, prerelease };
}

export function compareSemver(a: SemverParts, b: SemverParts): -1 | 0 | 1 {
  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] !== b[key]) {
      return a[key] > b[key] ? 1 : -1;
    }
  }
  // Prereleases sort before the release itself (a version without a
  // prerelease is newer than the same version with one).  This only matters
  // when comparing two otherwise equal version strings.
  if (a.prerelease === null && b.prerelease !== null) return 1;
  if (a.prerelease !== null && b.prerelease === null) return -1;
  if (a.prerelease === b.prerelease) return 0;
  return a.prerelease! > b.prerelease! ? 1 : -1;
}

export function isNewer(current: SemverParts, latest: SemverParts): boolean {
  return compareSemver(current, latest) === -1;
}

export function isMajorBump(current: SemverParts, latest: SemverParts): boolean {
  return latest.major > current.major;
}

export function validateAppPlatform(app: string, platform: string): AppPlatform | null {
  const key = `${app}/${platform}`;
  if (ALLOWED.has(key)) return key as AppPlatform;
  return null;
}

type ReleaseConfig = {
  latestVersion: string;
  downloadUrl: string;
  releaseNotes?: string;
  sha256?: string;
  size?: string;
  signature?: string;
  packageId?: string;
  certificateDigest?: string;
  publishedAt?: string;
};

// Cache the DB release config for 60 seconds to avoid hitting the DB on every
// update check request.  CI publishes after a release, so staleness is acceptable.
let dbCache: { key: string; config: ReleaseConfig | null; ts: number } | null = null;
const DB_CACHE_TTL_MS = 60_000;

async function loadConfigFromDb(app: string, platform: string): Promise<ReleaseConfig | null> {
  const key = `${app}/${platform}`;
  const now = Date.now();
  if (dbCache && dbCache.key === key && now - dbCache.ts < DB_CACHE_TTL_MS) {
    return dbCache.config;
  }

  try {
    const row = await basePrisma.appUpdateRelease.findUnique({
      where: { app_platform: { app, platform } },
    });
    if (!row) {
      dbCache = { key, config: null, ts: now };
      return null;
    }

    const config: ReleaseConfig = {
      latestVersion: row.latestVersion,
      downloadUrl: row.downloadUrl,
      releaseNotes: row.releaseNotes || undefined,
      sha256: row.sha256 || undefined,
      size: row.size != null ? String(row.size) : undefined,
      signature: row.signature || undefined,
      packageId: row.packageId || undefined,
      certificateDigest: row.certificateDigest || undefined,
      publishedAt: row.publishedAt.toISOString(),
    };
    dbCache = { key, config, ts: now };
    return config;
  } catch (err) {
    logger.warn({ err }, "[AppUpdateManifest] Failed to read DB release config");
    return null;
  }
}

/** Invalidate the DB cache so the next read picks up fresh CI-published data. */
export function invalidateDbCache() {
  dbCache = null;
}

function loadConfigFromEnv(app: string, platform: string): ReleaseConfig {
  const appUpper = app.replace(/-/g, "_").toUpperCase();
  const platformUpper = platform.toUpperCase();

  const latestVersion =
    process.env[`${appUpper}_${platformUpper}_LATEST_VERSION`] ||
    process.env[`${appUpper}_LATEST_VERSION`];
  const downloadUrl =
    process.env[`${appUpper}_${platformUpper}_DOWNLOAD_URL`] ||
    process.env[`${appUpper}_DOWNLOAD_URL`];
  const releaseNotes =
    process.env[`${appUpper}_${platformUpper}_RELEASE_NOTES`] ||
    process.env[`${appUpper}_RELEASE_NOTES`];
  const sha256 =
    process.env[`${appUpper}_${platformUpper}_SHA256`] ||
    process.env[`${appUpper}_SHA256`];
  const size =
    process.env[`${appUpper}_${platformUpper}_SIZE`] ||
    process.env[`${appUpper}_SIZE`];
  const signature =
    platform === "windows"
      ? (process.env[`${appUpper}_${platformUpper}_SIGNATURE`] ||
        process.env[`${appUpper}_DESKTOP_APP_SIGNATURE_${platformUpper}`] ||
        process.env[`${appUpper}_DESKTOP_APP_SIGNATURE`] ||
        process.env.DESKTOP_APP_SIGNATURE)
      : (process.env[`${appUpper}_${platformUpper}_SIGNATURE`] ||
        process.env[`${appUpper}_SIGNATURE`]);
  const packageId =
    process.env[`${appUpper}_${platformUpper}_PACKAGE_ID`] ||
    process.env[`${appUpper}_PACKAGE_ID`];
  const certificateDigest =
    process.env[`${appUpper}_${platformUpper}_CERTIFICATE_DIGEST`] ||
    process.env[`${appUpper}_CERTIFICATE_DIGEST`];
  const publishedAt =
    process.env[`${appUpper}_${platformUpper}_PUBLISHED_AT`] ||
    process.env[`${appUpper}_PUBLISHED_AT`];

  if (!latestVersion || !downloadUrl) {
    throw new Error(`Update metadata not configured for ${app}/${platform}`);
  }

  return {
    latestVersion,
    downloadUrl,
    releaseNotes,
    sha256,
    size,
    signature,
    packageId,
    certificateDigest,
    publishedAt,
  };
}

function allowlistReleaseUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const allowedHosts = [
      "github.com",
      "api.github.com",
      "githubusercontent.com",
      "softshape.ai",
      "softshape.in",
      "railway.app",
      "vercel.app",
    ];
    if (u.protocol !== "https:") return false;
    return allowedHosts.some(
      (host) => u.hostname === host || u.hostname.endsWith(`.${host}`)
    );
  } catch {
    return false;
  }
}

export async function buildUpdateManifest(
  app: string,
  platform: string,
  currentVersion: string
): Promise<UpdateManifest> {
  const key = validateAppPlatform(app, platform);
  if (!key) {
    throw new Error(`Unsupported app/platform: ${app}/${platform}`);
  }

  const current = parseSemver(currentVersion);
  if (!current) {
    throw new Error(`Invalid current version: ${currentVersion}`);
  }

  // DB-published config (from CI) takes priority over env vars.
  let cfg = await loadConfigFromDb(app, platform);
  if (!cfg) {
    cfg = loadConfigFromEnv(app, platform);
  }

  const latest = parseSemver(cfg.latestVersion);
  if (!latest) {
    throw new Error(`Invalid configured latest version: ${cfg.latestVersion}`);
  }

  if (!allowlistReleaseUrl(cfg.downloadUrl)) {
    throw new Error(`Release download URL is not on an approved host`);
  }

  const updateAvailable = isNewer(current, latest);
  const mandatory = updateAvailable && isMajorBump(current, latest);

  const sizeNum = cfg.size ? parseInt(cfg.size, 10) : null;

  return {
    app,
    platform,
    currentVersion,
    latestVersion: cfg.latestVersion,
    updateAvailable,
    mandatory,
    downloadUrl: cfg.downloadUrl,
    releaseNotes: cfg.releaseNotes || null,
    sha256: cfg.sha256 || null,
    size: sizeNum && !Number.isNaN(sizeNum) ? sizeNum : null,
    signature: cfg.signature || null,
    packageId: cfg.packageId || (app === "captain" ? "ai.softshape.captain" : null),
    certificateDigest: cfg.certificateDigest || null,
    publishedAt: cfg.publishedAt || null,
  };
}

// Tauri v1/v2 updater expects a platform-keyed manifest with a signature.
// The target param is the Tauri target triple (e.g. windows-x86_64).
export async function buildTauriManifest(
  app: string,
  target: string,
  currentVersion: string
): Promise<{ manifest: TauriManifest; updateAvailable: boolean }> {
  const platform = target.startsWith("windows") ? "windows" : "unknown";
  if (platform === "unknown") {
    throw new Error(`Unsupported Tauri target: ${target}`);
  }

  const manifest = await buildUpdateManifest(app, platform, currentVersion);

  // Tauri updater requires a valid signature — an empty string causes
  // signature verification failure at install time.
  if (!manifest.signature) {
    throw new Error(`Missing signature for ${app}/${platform} Tauri manifest`);
  }
  if (!manifest.downloadUrl) {
    throw new Error(`Missing download URL for ${app}/${platform} Tauri manifest`);
  }

  return {
    updateAvailable: manifest.updateAvailable,
    manifest: {
      version: manifest.latestVersion,
      notes: manifest.releaseNotes || `SoftShape ${app} update to v${manifest.latestVersion}`,
      pub_date: manifest.publishedAt || new Date().toISOString(),
      platforms: {
        [target]: {
          signature: manifest.signature,
          url: manifest.downloadUrl,
        },
      },
    },
  };
}
