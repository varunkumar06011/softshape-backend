import crypto from "crypto";
import { MenuType, PrismaClient } from "@prisma/client";

const BAR_ID = "bar-001";
const RESTAURANT_ID = "restaurant-001";

/** Bar menu name → restaurant menu name (Cloudinary source) */
const BAR_IMAGE_ALIASES: Record<string, string> = {
  "v grand spl chicken soup": "V-Grand Spl Cream of Chicken Soup",
  "hot & sour soup": "Veg Hot and Sour Soup",
  "hot & sour soup (nv)": "Chicken Hot and Sour Soup",
  "paneer mejestick": "Paneer Majestic",
  "chicken mejestick": "Majestic Chicken",
  "chilli wings": "Chicken Wings (Bones)",
  "today spl tandoori": "V-Grand Special Tandoori Platter",
  "cashewnut curry": "Cashew Nut Curry",
  "cashewnut biryani": "Cashew Nut Biryani",
  "omlet curry": "Omelette Curry",
  "sambhar rice": "Sambar Rice",
  "white rice": "Plain Rice",
  "chilli gobi": "Gobi Chilli",
  "chilli paneer": "Paneer Chilli",
  "chilli mushroom": "Mushroom Chilli",
  "chilli baby corn": "Baby Corn Chilli",
  "chilli mutton": "Mutton Fry",
  "chilli fish": "Fish Chilli",
  "mushroom fry": "Mushroom Curry",
  "dilkush biryani": "Rambo Biryani",
  "egg fry": "Boiled Egg (Starters)",
  "egg roast": "Boiled Egg (Starters)",
  "chilli egg": "Egg Burji Curry",
  "egg manchurian": "Egg Burji Curry",
  "egg 65": "Egg Burji Curry",
  "velvet egg": "Egg Burji Curry",
  "mutton soup": "Mutton Curry",
  "finger chips": "Crispy Corn",
};

function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

function stripParens(name: string): string {
  return name.replace(/\s*\([^)]*\)\s*$/g, "").trim();
}

function slugify(name: string): string {
  return name
   .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function tokenSet(name: string): Set<string> {
  return new Set(
    normalizeName(stripParens(name))
      .split(" ")
      .filter((t) => t.length > 1)
  );
}

function tokenOverlapScore(a: string, b: string): number {
  const ta = tokenSet(a);
  const tb = tokenSet(b);
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  return inter / Math.max(ta.size, tb.size);
}

type ImageIndex = Map<string, string>;

function buildNameIndex(
  rows: Array<{ name: string; imageUrl: string | null }>
): ImageIndex {
  const index: ImageIndex = new Map();
  for (const row of rows) {
    if (!row.imageUrl?.startsWith("http")) continue;
    const url = row.imageUrl.trim();
    const keys = [
      normalizeName(row.name),
      normalizeName(stripParens(row.name)),
      slugify(row.name),
      slugify(stripParens(row.name)),
    ];
    for (const key of keys) {
      if (key && !index.has(key)) index.set(key, url);
    }
  }
  return index;
}

function findImageUrl(
  itemName: string,
  indexes: ImageIndex[],
  fuzzyRows: Array<{ name: string; imageUrl: string | null }>
): string | null {
  const aliasTarget = BAR_IMAGE_ALIASES[normalizeName(itemName)];
  if (aliasTarget) {
    for (const row of fuzzyRows) {
      if (row.imageUrl?.startsWith("http") && normalizeName(row.name) === normalizeName(aliasTarget)) {
        return row.imageUrl.trim();
      }
    }
  }

  const n = normalizeName(itemName);
  const base = stripParens(itemName);
  const baseNorm = normalizeName(base);

  for (const index of indexes) {
    if (index.has(n)) return index.get(n)!;
    if (index.has(baseNorm)) return index.get(baseNorm)!;
    if (index.has(slugify(itemName))) return index.get(slugify(itemName))!;
    if (index.has(slugify(base))) return index.get(slugify(base))!;
  }

  const prefixes = [
    "veg ",
    "chicken ",
    "mutton ",
    "prawn ",
    "egg ",
    "paneer ",
    "boiled ",
    "spl ",
    "special ",
    "v grand spl ",
    "v-grand spl ",
  ];
  for (const prefix of prefixes) {
    const key = normalizeName(`${prefix}${base}`);
    for (const index of indexes) {
      if (index.has(key)) return index.get(key)!;
    }
  }

  if (/\(nv\)/i.test(itemName)) {
    for (const prefix of ["chicken ", "mutton ", "prawn ", "egg "]) {
      const key = normalizeName(`${prefix}${base}`);
      for (const index of indexes) {
        if (index.has(key)) return index.get(key)!;
      }
    }
  }

  let best: { url: string; score: number } | null = null;
  for (const row of fuzzyRows) {
    if (!row.imageUrl?.startsWith("http")) continue;
    const score = tokenOverlapScore(itemName, row.name);
    if (score >= 0.55 && (!best || score > best.score)) {
      best = { url: row.imageUrl.trim(), score };
    }
  }
  return best?.url ?? null;
}

interface CloudinaryResource {
  public_id: string;
  secure_url: string;
  filename?: string;
  created_at?: string;
  context?: { custom?: Record<string, string> };
  tags?: string[];
}

function cloudinarySign(params: Record<string, string>, apiSecret: string): string {
  const sorted = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  return crypto.createHash("sha1").update(sorted + apiSecret).digest("hex");
}

async function listCloudinaryResources(): Promise<CloudinaryResource[]> {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME || "dnlhxmtqu";
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;

  if (!apiKey || !apiSecret) {
    console.warn("[RestoreBarImages] CLOUDINARY_API_KEY/SECRET not set — skipping Cloudinary library scan");
    return [];
  }

  const all: CloudinaryResource[] = [];
  let nextCursor: string | undefined;

  do {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const params: Record<string, string> = {
      max_results: "500",
      timestamp,
      type: "upload",
    };
    if (nextCursor) params.next_cursor = nextCursor;

    const signature = cloudinarySign(params, apiSecret);
    const qs = new URLSearchParams({ ...params, api_key: apiKey, signature });
    const url = `https://api.cloudinary.com/v1_1/${cloudName}/resources/image?${qs.toString()}`;
    const res = await fetch(url);
    if (!res.ok) {
      const detail = await res.text().catch(() => res.statusText);
      throw new Error(`Cloudinary list failed (${res.status}): ${detail}`);
    }
    const data = (await res.json()) as { resources?: CloudinaryResource[]; next_cursor?: string };
    all.push(...(data.resources ?? []));
    nextCursor = data.next_cursor;
  } while (nextCursor);

  console.log(`[RestoreBarImages] Listed ${all.length} Cloudinary resources`);
  return all;
}

function buildCloudinaryIndex(resources: CloudinaryResource[]): ImageIndex {
  const index: ImageIndex = new Map();

  for (const res of resources) {
    const url = res.secure_url?.trim();
    if (!url) continue;

    const keys = new Set<string>();
    keys.add(normalizeName(res.public_id.split("/").pop() ?? ""));
    keys.add(slugify(res.public_id.split("/").pop() ?? ""));
    if (res.filename) {
      keys.add(normalizeName(res.filename.replace(/\.[^.]+$/, "")));
      keys.add(slugify(res.filename.replace(/\.[^.]+$/, "")));
    }
    const custom = res.context?.custom ?? {};
    for (const val of Object.values(custom)) {
      if (val) {
        keys.add(normalizeName(val));
        keys.add(slugify(val));
      }
    }
    for (const tag of res.tags ?? []) {
      keys.add(normalizeName(tag));
      keys.add(slugify(tag));
    }

    for (const key of keys) {
      if (key && !index.has(key)) index.set(key, url);
    }
  }

  return index;
}

export interface RestoreBarImagesResult {
  totalBarItems: number;
  alreadyHadImage: number;
  restoredFromRestaurant: number;
  restoredFromArchive: number;
  restoredFromCloudinary: number;
  stillMissing: number;
  missingNames: string[];
}

export async function restoreBarMenuImages(
  prisma: PrismaClient
): Promise<RestoreBarImagesResult> {
  const barItems = await prisma.menuItem.findMany({
    where: { restaurantId: BAR_ID, isDeleted: false },
    select: { id: true, name: true, imageUrl: true, menuType: true },
  });

  const restaurantItems = await prisma.menuItem.findMany({
    where: { restaurantId: RESTAURANT_ID, isDeleted: false },
    select: { name: true, imageUrl: true },
  });

  const archivedBarItems = await prisma.menuItem.findMany({
    where: { restaurantId: BAR_ID, isDeleted: true, imageUrl: { not: null } },
    select: { name: true, imageUrl: true },
    orderBy: { updatedAt: "desc" },
  });

  const allKnownItems = await prisma.menuItem.findMany({
    where: { imageUrl: { not: null } },
    select: { name: true, imageUrl: true },
  });

  const restaurantIndex = buildNameIndex(restaurantItems);
  const archiveIndex = buildNameIndex(archivedBarItems);
  const globalIndex = buildNameIndex(allKnownItems);

  let cloudinaryIndex: ImageIndex = new Map();
  let orphanResources: CloudinaryResource[] = [];
  try {
    const resources = await listCloudinaryResources();
    cloudinaryIndex = buildCloudinaryIndex(resources);

    const usedUrls = new Set(
      allKnownItems
        .map((i) => i.imageUrl?.trim())
        .filter((u): u is string => Boolean(u?.startsWith("http")))
    );
    orphanResources = resources.filter((r) => r.secure_url && !usedUrls.has(r.secure_url.trim()));
    console.log(`[RestoreBarImages] ${orphanResources.length} orphan Cloudinary resources`);
  } catch (err) {
    console.error("[RestoreBarImages] Cloudinary scan error:", err);
  }

  const indexes = [restaurantIndex, archiveIndex, globalIndex, cloudinaryIndex];
  const fuzzyRows = [...restaurantItems, ...archivedBarItems, ...allKnownItems];

  let alreadyHadImage = 0;
  let restoredFromRestaurant = 0;
  let restoredFromArchive = 0;
  let restoredFromCloudinary = 0;
  const missingNames: string[] = [];

  for (const item of barItems) {
    if (item.imageUrl?.startsWith("http")) {
      alreadyHadImage += 1;
      continue;
    }

    let url: string | null = null;
    let source: "restaurant" | "archive" | "cloudinary" | null = null;

    const fromRestaurant = findImageUrl(item.name, [restaurantIndex], restaurantItems);
    if (fromRestaurant) {
      url = fromRestaurant;
      source = "restaurant";
    }

    if (!url) {
      const fromArchive = findImageUrl(item.name, [archiveIndex], archivedBarItems);
      if (fromArchive) {
        url = fromArchive;
        source = "archive";
      }
    }

    if (!url) {
      const fromGlobal = findImageUrl(item.name, [globalIndex], allKnownItems);
      if (fromGlobal) {
        url = fromGlobal;
        source = "archive";
      }
    }

    if (!url && cloudinaryIndex.size > 0) {
      const fromCloud = findImageUrl(item.name, [cloudinaryIndex], []);
      if (fromCloud) {
        url = fromCloud;
        source = "cloudinary";
      }
    }

    // Match orphan Cloudinary uploads (e.g. liquor bottles) via context.alt tag
    if (!url && orphanResources.length > 0) {
      const itemNorm = normalizeName(item.name);
      for (const res of orphanResources) {
        const alt = res.context?.custom?.alt ?? res.context?.custom?.caption ?? "";
        if (!alt) continue;
        const altNorm = normalizeName(alt);
        if (altNorm === itemNorm || altNorm === normalizeName(stripParens(item.name))) {
          url = res.secure_url.trim();
          source = "cloudinary";
          break;
        }
        if (tokenOverlapScore(item.name, alt) >= 0.8) {
          url = res.secure_url.trim();
          source = "cloudinary";
          break;
        }
      }
    }

    if (!url) {
      for (const index of indexes) {
        const fallback = findImageUrl(item.name, [index], fuzzyRows);
        if (fallback) {
          url = fallback;
          source = index === cloudinaryIndex ? "cloudinary" : "restaurant";
          break;
        }
      }
    }

    if (!url) {
      missingNames.push(item.name);
      continue;
    }

    await prisma.menuItem.update({
      where: { id: item.id },
      data: { imageUrl: url },
    });

    if (source === "restaurant") restoredFromRestaurant += 1;
    else if (source === "archive") restoredFromArchive += 1;
    else if (source === "cloudinary") restoredFromCloudinary += 1;
  }

  // Heuristic: pair orphan Cloudinary uploads with liquor items when counts match
  // (typical when images were bulk-uploaded in menu order but DB links were lost)
  const stillMissingLiquor = await prisma.menuItem.findMany({
    where: {
      restaurantId: BAR_ID,
      isDeleted: false,
      menuType: MenuType.LIQUOR,
      OR: [{ imageUrl: null }, { imageUrl: "" }],
    },
    select: { id: true, name: true, category: { select: { name: true, sortOrder: true } } },
    orderBy: [{ category: { sortOrder: "asc" } }, { name: "asc" }],
  });

  const assignedUrls = new Set(
    (
      await prisma.menuItem.findMany({
        where: { restaurantId: BAR_ID, imageUrl: { not: null } },
        select: { imageUrl: true },
      })
    )
      .map((i) => i.imageUrl?.trim())
      .filter(Boolean)
  );

  const availableOrphans = orphanResources
    .filter((r) => r.secure_url && !assignedUrls.has(r.secure_url.trim()))
    .sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? ""));

  if (
    stillMissingLiquor.length > 0 &&
    availableOrphans.length === stillMissingLiquor.length
  ) {
    console.log(
      `[RestoreBarImages] Heuristic liquor pairing: ${stillMissingLiquor.length} items ↔ ${availableOrphans.length} orphan uploads`
    );
    for (let i = 0; i < stillMissingLiquor.length; i += 1) {
      const item = stillMissingLiquor[i];
      const orphan = availableOrphans[i];
      await prisma.menuItem.update({
        where: { id: item.id },
        data: { imageUrl: orphan.secure_url.trim() },
      });
      restoredFromCloudinary += 1;
      const idx = missingNames.indexOf(item.name);
      if (idx >= 0) missingNames.splice(idx, 1);
    }
  }

  return {
    totalBarItems: barItems.length,
    alreadyHadImage,
    restoredFromRestaurant,
    restoredFromArchive,
    restoredFromCloudinary,
    stillMissing: missingNames.length,
    missingNames,
  };
}

export async function restoreBarMenuImagesByType(prisma: PrismaClient) {
  const result = await restoreBarMenuImages(prisma);
  const liquorMissing = await prisma.menuItem.count({
    where: {
      restaurantId: BAR_ID,
      isDeleted: false,
      menuType: MenuType.LIQUOR,
      OR: [{ imageUrl: null }, { imageUrl: "" }],
    },
  });
  return { ...result, liquorStillMissing: liquorMissing };
}
