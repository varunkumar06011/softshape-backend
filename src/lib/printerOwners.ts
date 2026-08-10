// ─────────────────────────────────────────────────────────────────────────────
// printerOwners.ts — Printer ownership registry for multi-desktop routing
// ─────────────────────────────────────────────────────────────────────────────
// Tracks which edge server sockets have which printers, so the cloud can route
// print jobs to the correct desktop when multiple edge servers share the same
// outlet. Key: `${restaurantId}:${printerName}` → Set of socket IDs.
// The first socket in the set is the "primary" — it receives print jobs.
// If it disconnects, the next socket becomes primary automatically.
//
// Extracted to a separate module to avoid circular imports between index.ts
// and orderService.ts.
// ─────────────────────────────────────────────────────────────────────────────

export const printerOwners = new Map<string, Set<string>>();

// ── Update ownership for a socket ────────────────────────────────────────────
// Removes any previous registrations for this socket, then adds it to each
// printer's ownership set. Called from edge:printers_report and edge:heartbeat.
export function updatePrinterOwnership(socketId: string, restaurantId: string, printers: string[]): void {
  // Clean up previous registrations for this socket
  for (const [key, owners] of printerOwners) {
    if (owners.has(socketId)) {
      owners.delete(socketId);
      if (owners.size === 0) printerOwners.delete(key);
    }
  }
  // Register with the latest printer list
  for (const printerName of printers) {
    if (typeof printerName !== "string" || !printerName) continue;
    const key = `${restaurantId}:${printerName}`;
    let owners = printerOwners.get(key);
    if (!owners) {
      owners = new Set();
      printerOwners.set(key, owners);
    }
    owners.add(socketId);
  }
}

// ── Remove a socket from all ownership sets ──────────────────────────────────
// Called on disconnect. The next socket in each set (if any) becomes primary.
export function removePrinterOwnership(socketId: string): void {
  for (const [key, owners] of printerOwners) {
    if (owners.has(socketId)) {
      owners.delete(socketId);
      if (owners.size === 0) printerOwners.delete(key);
    }
  }
}

// ── Get the primary owner socket for a printer ───────────────────────────────
// Returns the first socket ID in the ownership set, or null if no owner.
export function getPrimaryOwner(restaurantId: string, printerName: string): string | null {
  const owners = printerOwners.get(`${restaurantId}:${printerName}`);
  if (!owners || owners.size === 0) return null;
  return owners.values().next().value ?? null;
}
