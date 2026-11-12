/* Sales Analytics Report — READ-ONLY (SELECT queries only)
 * Outlets: Vgrand Lounge + Vgrand Family Restaurant (combined)
 * Windows: "today" = IST business day; "60d" = last 60 IST days incl. today
 * Usage: node dev-scripts/analytics-report.js  -> writes ../analytics-report/report.html
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const OUTLETS = [
  { id: 'cmqy60ci200027dscyj9ubg8h', name: 'Vgrand Lounge' },
  { id: 'cmr03m0fa00015ot8jh16grhn', name: 'Vgrand Family Restaurant' },
];
const RIDS = OUTLETS.map(o => o.id);
const OUTLET_NAME = Object.fromEntries(OUTLETS.map(o => [o.id, o.name]));

const IST_MS = 5.5 * 3600 * 1000;
const istDayStartUTC = d => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - IST_MS);
const nowUtc = new Date();
const nowIst = new Date(nowUtc.getTime() + IST_MS);
const todayStart = istDayStartUTC(nowIst);            // UTC instant = 00:00 IST today
const tomorrowStart = new Date(todayStart.getTime() + 86400000);
const istMidnight60 = new Date(nowIst.getTime() - 59 * 86400000);
const d60Start = istDayStartUTC(istMidnight60);       // UTC instant = 00:00 IST, 59 days ago
const fmtDate = d => new Date(d.getTime() + IST_MS).toISOString().slice(0, 10).split('-').reverse().join('/');
const todayLabel = fmtDate(todayStart);
const d60Label = `${fmtDate(d60Start)} – ${fmtDate(new Date(tomorrowStart.getTime() - 1))}`;

const inr = n => '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: 0 });
const num = n => Number(n || 0).toLocaleString('en-IN');
const norm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// categories treated as beverages/drinks (excluded from food-item rankings)
const DRINK_CAT = /beverage|soft ?drink|milk ?shake|lassi|dessert.*drink|cocktail|mocktail|liquor|bar menu|bar inventory|beer|brandy|whisky|whiskey|rum|vodka|wine|breezer|gin|tequila|scotch/i;
// item-level exclusions: ice creams, milkshakes, drinks, packaging — applied even when the
// billed name can't be matched back to a menu item
const DRINK_NAME = /ice ?cream|icecream|milk ?shake|milkshake|beer|whisky|whiskey|vodka|rum\b|brandy|wine\b|breezer|scotch|cocktail|mocktail|\bsoda\b|thums|coke\b|pepsi|sprite|fanta|limca|maaza|frooti|water ?bottle|mineral ?water|lassi|container|parcel|packag|packing|paper ?bag|take ?away/i;
// explicit user-requested exclusions from item rankings
const EXCLUDE_NAME = /butter ?naan|water ?bottle|mineral ?water|onion\s+r[ai][ai]?t?h?a/i;
const STARTER_CAT = /starter|tandoori|kebab|kabob/i;
const BIRYANI_RX = /bir+yani|biryani|biriyani|biryaani/i;

async function main() {
  // ── pull data (read-only) ───────────────────────────────────────────────
  const txns = await prisma.$queryRawUnsafe(
    `SELECT t.id, t."restaurantId", t."captainId", t."orderId", t."grandTotal", t."amount",
            t.items, t."paidAt", t."billNumber"
     FROM "Transaction" t
     WHERE t."restaurantId" = ANY($1) AND t.status = 'COMPLETED' AND t."paidAt" >= $2 AND t."paidAt" < $3`,
    RIDS, d60Start, tomorrowStart);

  const orders = await prisma.$queryRawUnsafe(
    `SELECT id, "captainId", "restaurantId" FROM "Order" WHERE "restaurantId" = ANY($1) AND "isDeleted" = false`, RIDS);
  const orderCaptain = new Map(orders.map(o => [o.id, o.captainId]));

  const users = await prisma.$queryRawUnsafe(
    `SELECT id, name, "outletId" FROM "User" WHERE "outletId" = ANY($1) AND role = 'CAPTAIN'`, RIDS);
  const capName = new Map(users.map(u => [u.id, (u.name || '').trim() || 'Unknown']));

  const menu = await prisma.$queryRawUnsafe(
    `SELECT m.id, m.name, m."isVeg", m."isSpecial", m."specialActive", m."specialExpiresAt",
            m."menuType", m."restaurantId", m."isDeleted", c.name AS "catName"
     FROM "MenuItem" m LEFT JOIN "Category" c ON c.id = m."categoryId"
     WHERE m."restaurantId" = ANY($1)`, RIDS);
  // name -> menu item, per outlet
  const menuMap = new Map(); // `${rid}|${normName}` -> mi
  for (const m of menu) menuMap.set(`${m.restaurantId}|${norm(m.name)}`, m);

  const assignments = await prisma.$queryRawUnsafe(
    `SELECT "captainId", "revenueTarget" FROM "CaptainAssignment" WHERE "restaurantId" = ANY($1)`, RIDS);
  const targetMap = new Map(assignments.map(a => [a.captainId, Number(a.revenueTarget)]));

  // ── helpers ─────────────────────────────────────────────────────────────
  const isSpecialAt = (mi, at) => mi && mi.isSpecial && (mi.specialExpiresAt == null ? mi.specialActive !== false : new Date(mi.specialExpiresAt) >= at);
  const isDrink = (name, mi) => (mi && mi.catName && DRINK_CAT.test(mi.catName)) || DRINK_NAME.test(name || '') || EXCLUDE_NAME.test(name || '');
  const isVeg = mi => mi && mi.isVeg === true;
  const isStarter = (name, mi) => (mi && mi.catName && STARTER_CAT.test(mi.catName)) || STARTER_CAT.test(name || '');
  const isBiryani = (name, mi) => (mi && (mi.catName && BIRYANI_RX.test(mi.catName))) || BIRYANI_RX.test(name || '');

  const items60 = new Map();  // key norm(name) -> {name, outlets:Set, qty, rev, mi}
  const itemsToday = new Map();
  const captains = new Map(); // norm name -> {cids:Set, bills, rev, qty, specialQty, todaySpecialQty}
  const capOf = t => t.captainId || orderCaptain.get(t.orderId) || null;
  const todayTxns = [];

  let bills60 = 0, rev60 = 0, unattributedBills = 0, unattributedRev = 0;
  let billsToday = 0, revToday = 0;
  const special60 = new Map();         // norm name -> {name, qty, rev} — specials sold in 60d
  const todaySpecialByCap = new Map(); // norm captain name -> qty (today, kept for reference)

  for (const t of txns) {
    const gt = Number(t.grandTotal ?? t.amount ?? 0);
    const isToday = new Date(t.paidAt) >= todayStart;
    bills60++; rev60 += gt;
    if (isToday) { billsToday++; revToday += gt; todayTxns.push(t); }

    const cid = capOf(t);
    const ckey = cid ? norm(capName.get(cid) || '') : null;
    let cap = ckey && captains.get(ckey);
    if (ckey && !cap) { cap = { cids: new Set([cid]), bills: 0, rev: 0, qty: 0, specialQty: 0 }; captains.set(ckey, cap); }
    if (cap) { cap.cids.add(cid); cap.bills++; cap.rev += gt; } else { unattributedBills++; unattributedRev += gt; }

    for (const it of (Array.isArray(t.items) ? t.items : [])) {
      const name = String(it.name || it.n || 'Unknown').trim();
      const q = Number(it.quantity ?? it.q ?? 0) || 0;
      const p = Number(it.price ?? it.p ?? 0) || 0;
      const key = norm(name);
      const mi = menuMap.get(`${t.restaurantId}|${key}`) || null;
      const rev = p * q;

      let agg = items60.get(key);
      if (!agg) { agg = { name, outlets: new Set(), qty: 0, rev: 0, mi }; items60.set(key, agg); }
      agg.qty += q; agg.rev += rev; agg.outlets.add(OUTLET_NAME[t.restaurantId]);
      if (!agg.mi && mi) agg.mi = mi;
      const wasSpecial = isSpecialAt(mi, new Date(t.paidAt));
      if (cap) { cap.qty += q; if (wasSpecial) cap.specialQty += q; }
      if (wasSpecial) {
        let sp = special60.get(key);
        if (!sp) { sp = { name, qty: 0, rev: 0 }; special60.set(key, sp); }
        sp.qty += q; sp.rev += rev;
      }

      if (isToday) {
        let ta = itemsToday.get(key);
        if (!ta) { ta = { name, qty: 0, rev: 0, mi }; itemsToday.set(key, ta); }
        ta.qty += q; ta.rev += rev;
        if (wasSpecial && ckey) todaySpecialByCap.set(ckey, (todaySpecialByCap.get(ckey) || 0) + q);
      }
    }
  }

  // ── derive rankings ─────────────────────────────────────────────────────
  const all60 = [...items60.values()];
  const food60 = all60.filter(i => !isDrink(i.name, i.mi));
  const byQtyDesc = (a, b) => b.qty - a.qty || b.rev - a.rev;
  const byQtyAsc = (a, b) => a.qty - b.qty || a.rev - b.rev;

  const top10 = [...food60].sort(byQtyDesc).slice(0, 10);
  const highestItem = [...food60].sort(byQtyDesc)[0] || null;
  const positive = food60.filter(i => i.qty > 0);
  const leastItem = [...positive].sort(byQtyAsc)[0] || null;
  const zeroSoldFood = menu.filter(m => m.isDeleted !== true && !DRINK_CAT.test(m.catName || '') && !DRINK_NAME.test(m.name) && !EXCLUDE_NAME.test(m.name))
    .filter(m => !items60.has(norm(m.name)));

  const starters = food60.filter(i => isStarter(i.name, i.mi)).sort(byQtyDesc);
  const biryanis = food60.filter(i => isBiryani(i.name, i.mi)).sort(byQtyDesc);
  const veg = food60.filter(i => isVeg(i.mi)).sort(byQtyDesc);
  const leastVeg = [...veg.filter(i => i.qty > 0)].sort(byQtyAsc)[0] || null;

  const capRows = [...captains.entries()].map(([ckey, c]) => {
    const cids = [...c.cids];
    return {
      name: capName.get(cids[0]) || ckey, cids,
      outlet: [...new Set(cids.map(id => OUTLET_NAME[(users.find(u => u.id === id) || {}).outletId]).filter(Boolean))].join(' + ') || '—',
      bills: c.bills, rev: c.rev, qty: c.qty, specialQty: c.specialQty,
      aov: c.bills ? c.rev / c.bills : 0,
      target: cids.reduce((s, id) => s + (targetMap.get(id) || 0), 0) || null,
      todaySpecialQty: todaySpecialByCap.get(ckey) || 0,
    };
  }).sort((a, b) => b.rev - a.rev);

  const topSpecialCap = capRows.filter(c => c.specialQty > 0).sort((a, b) => b.specialQty - a.specialQty)[0] || null;
  const specials60List = [...special60.values()].sort(byQtyDesc);
  const special60QtyTotal = specials60List.reduce((s, i) => s + i.qty, 0);
  const special60RevTotal = specials60List.reduce((s, i) => s + i.rev, 0);

  const aov60 = bills60 ? rev60 / bills60 : 0;
  const aovToday = billsToday ? revToday / billsToday : 0;

  // ── HTML ────────────────────────────────────────────────────────────────
  const card = (label, val, sub) => `<div class="card"><div class="cl">${label}</div><div class="cv">${val}</div>${sub ? `<div class="cs">${sub}</div>` : ''}</div>`;
  const tbl = (heads, rows) => `<table><thead><tr>${heads.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`;

  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { size: A4; margin: 14mm 12mm; }
    * { box-sizing: border-box; }
    body { font-family: 'Segoe UI', Arial, sans-serif; color: #1a202c; font-size: 12px; }
    h1 { font-size: 20px; margin: 0; } h2 { font-size: 14px; margin: 20px 0 8px; border-left: 4px solid #2b6cb0; padding-left: 8px; }
    .sub { color: #555; margin: 4px 0 0; }
    .cards { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
    .card { border: 1px solid #cbd5e0; border-radius: 8px; padding: 10px 14px; min-width: 150px; flex: 1; }
    .cl { font-size: 10px; text-transform: uppercase; letter-spacing: .5px; color: #718096; }
    .cv { font-size: 17px; font-weight: 700; margin-top: 2px; } .cs { font-size: 10px; color: #718096; margin-top: 2px; }
    table { width: 100%; border-collapse: collapse; margin-top: 6px; }
    th { background: #2b6cb0; color: #fff; text-align: left; padding: 6px 8px; font-size: 11px; }
    td { padding: 5px 8px; border-bottom: 1px solid #e2e8f0; }
    tr:nth-child(even) td { background: #f7fafc; }
    .r { text-align: right; } .note { font-size: 10px; color: #718096; margin-top: 4px; }
    .pgbrk { page-break-before: always; }
    .head { display:flex; justify-content:space-between; align-items:flex-end; border-bottom: 2px solid #2b6cb0; padding-bottom: 8px; }
  </style></head><body>
  <div class="head"><div><h1>Sales Analytics Report</h1>
    <div class="sub">Vgrand Lounge + Vgrand Family Restaurant &nbsp;·&nbsp; Generated ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST</div>
    <div class="sub">60-day window: <b>${d60Label}</b> &nbsp;·&nbsp; Today: <b>${todayLabel}</b></div></div>
    <div class="sub">Softshape POS · Supabase (read-only)</div></div>

  <h2>1 · Headline Metrics — Last 60 Days (${d60Label})</h2>
  <div class="cards">
    ${card('Bills Total', `${num(bills60)} bills`, `${inr(rev60)} revenue`)}
    ${card('Average Order Value', inr(Math.round(aov60)), `${num(bills60)} bills`)}
    ${card('Highest Selling Item', esc(highestItem?.name || '—'), highestItem ? `${num(highestItem.qty)} sold · ${inr(highestItem.rev)}` : '')}
    ${card('Least Selling Item', esc(leastItem?.name || '—'), leastItem ? `${num(leastItem.qty)} sold · ${inr(leastItem.rev)}` : '')}
    ${card('Highest Selling Starter', esc(starters[0]?.name || '—'), starters[0] ? `${num(starters[0].qty)} sold · ${inr(starters[0].rev)}` : '')}
    ${card('Highest Selling Biryani', esc(biryanis[0]?.name || '—'), biryanis[0] ? `${num(biryanis[0].qty)} sold · ${inr(biryanis[0].rev)}` : '')}
    ${card('Highest Selling Veg Item', esc(veg[0]?.name || '—'), veg[0] ? `${num(veg[0].qty)} sold · ${inr(veg[0].rev)}` : '')}
    ${card('Least Selling Veg Item', esc(leastVeg?.name || '—'), leastVeg ? `${num(leastVeg.qty)} sold · ${inr(leastVeg.rev)}` : '')}
  </div>
  <div class="note">Item rankings exclude ice creams, milkshakes, beverage/liquor categories (Beer, Brandy, Whisky, Rum, Vodka, Wine, Breezer, Cocktails, Beverages, Soft Drinks, Lassi, Milkshakes, Bar Menu), packaging items, and Butter Naan, Water Bottle &amp; Onion Raitha as requested. Same-named items across both outlets are merged. Veg ranking uses the menu's veg flag. Food menu items with zero sales in 60 days: <b>${zeroSoldFood.length}</b>${zeroSoldFood.length ? ' (e.g. ' + zeroSoldFood.slice(0, 8).map(m => esc(m.name)).join(', ') + (zeroSoldFood.length > 8 ? '…' : '') + ')' : ''}.</div>

  <h2>2 · "Today's Specials" Items Sold — Last 60 Days</h2>
  <div class="cards">
    ${card('Specials Sold (60d)', num(special60QtyTotal) + ' pcs', `${specials60List.length} special items · ${inr(special60RevTotal)}`)}
    ${card('Top Specials Captain (60d)', esc(topSpecialCap?.name || '—'), topSpecialCap ? `${num(topSpecialCap.specialQty)} specials sold` : 'no special sales attributed')}
    ${card('Bills Today (' + todayLabel + ')', num(billsToday), inr(revToday))}
    ${card('AOV Today', inr(Math.round(aovToday)))}
  </div>
  ${tbl(['#', 'Special Item ("Today\'s Specials" feature)', 'Qty Sold (60d)', 'Revenue (60d)'],
    specials60List.length ? specials60List.map((i, x) => `<tr><td>${x + 1}</td><td>${esc(i.name)}</td><td class="r">${num(i.qty)}</td><td class="r">${inr(i.rev)}</td></tr>`)
      : ['<tr><td colspan="4">No special items sold in the window.</td></tr>'])}
  <div class="note">Items marked via the "Today's Specials" feature (isSpecial) counted while their special window covered the sale date.</div>

  <div class="pgbrk"></div>
  <h2>3 · Captain Analytics — Last 60 Days</h2>
  ${tbl(['#', 'Captain', 'Outlet', 'Bills', 'Revenue', 'AOV', 'Items Qty', 'Specials Qty (60d)', 'Daily Target'],
    capRows.map((c, i) => `<tr><td>${i + 1}</td><td><b>${esc(c.name)}</b></td><td>${c.outlet}</td><td class="r">${num(c.bills)}</td><td class="r">${inr(c.rev)}</td><td class="r">${inr(Math.round(c.aov))}</td><td class="r">${num(c.qty)}</td><td class="r">${num(c.specialQty)}</td><td class="r">${c.target ? inr(c.target) : '—'}</td></tr>`)
      .concat(unattributedBills ? [`<tr><td></td><td><i>Unattributed / no captain</i></td><td>—</td><td class="r">${num(unattributedBills)}</td><td class="r">${inr(unattributedRev)}</td><td class="r">${inr(Math.round(unattributedRev / unattributedBills))}</td><td>—</td><td>—</td><td>—</td></tr>`] : []))}
  <div class="note">Bills are attributed to the captain on the bill (Transaction.captainId, falling back to the order's captain). Same-named captains across both outlets are merged into one row. Specials Qty counts sales of special-flagged menu items while their special window covered the sale date.</div>

  <h2>4 · Item-wise Selling — Top 10 (60 days, food only)</h2>
  ${tbl(['#', 'Item', 'Outlet(s)', 'Category', 'Qty Sold', 'Revenue', 'Avg Price'],
    top10.map((i, x) => `<tr><td>${x + 1}</td><td><b>${esc(i.name)}</b></td><td>${[...i.outlets].join(' + ')}</td><td>${esc(i.mi?.catName || '—')}</td><td class="r">${num(i.qty)}</td><td class="r">${inr(i.rev)}</td><td class="r">${inr(Math.round(i.rev / (i.qty || 1)))}</td></tr>`))}

  <h2>5 · Category Highlights (60 days)</h2>
  ${tbl(['Segment', 'Top Item', 'Qty', 'Revenue'],
    [['Starters', starters[0]], ['Biryanis', biryanis[0]], ['Veg items', veg[0]]]
      .map(([s, i]) => `<tr><td>${s}</td><td>${esc(i?.name || '—')}</td><td class="r">${i ? num(i.qty) : '—'}</td><td class="r">${i ? inr(i.rev) : '—'}</td></tr>`)
      .concat([`<tr><td>Least-sold veg</td><td>${esc(leastVeg?.name || '—')}</td><td class="r">${leastVeg ? num(leastVeg.qty) : '—'}</td><td class="r">${leastVeg ? inr(leastVeg.rev) : '—'}</td></tr>`]))}

  <div class="note" style="margin-top:14px">Methodology: only COMPLETED transactions; revenue = grandTotal; item qty/revenue from the billed-items snapshot on each bill. All-day boundaries are IST (00:00–24:00). Report generated with read-only queries.</div>
  </body></html>`;

  const outDir = path.resolve(__dirname, '..', '..', 'analytics-report');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'report.html'), html);
  fs.writeFileSync(path.join(outDir, 'data.json'), JSON.stringify({
    window60: d60Label, today: todayLabel,
    bills60, rev60, aov60, billsToday, revToday, aovToday,
    captains: capRows, top10, specials60List, special60QtyTotal, special60RevTotal, topSpecialCap,
    highestItem, leastItem, leastVeg,
    topStarter: starters[0] || null, topBiryani: biryanis[0] || null, topVeg: veg[0] || null,
    zeroSoldFoodCount: zeroSoldFood.length, unattributedBills, unattributedRev,
  }, (k, v) => typeof v === 'bigint' ? Number(v) : v, 2));
  console.log('OK ->', path.join(outDir, 'report.html'));
  await prisma.$disconnect();
}

main().catch(e => { console.error('FAILED:', e); process.exit(1); });
