# Inventory Deduction System - Developer Guide

## Quick Overview

When an order is paid via `POST /api/orders/:id/pay`, the system automatically deducts liquor inventory. This document explains how it works.

## Flow Diagram

```
Customer Order → Payment Processing → Inventory Deduction → Table Reset → Receipt
```

## Detailed Flow

### 1. Payment Request Received
```http
POST /api/orders/:id/pay
Body: { paymentMethod: "CASH" | "CARD" | "UPI" }
```

### 2. Order Marked as PAID
```typescript
const order = await tx.order.update({
  where: { id },
  data: { status: OrderStatus.PAID }
});
```

### 3. Liquor Items Filtered
```typescript
const liquorItems = order.items.filter(
  item => item.menuType === 'LIQUOR' && !item.removedFromBill
);
```

### 4. Stock Deduction (for each liquor item)

**Step A: Find Inventory Record**
```typescript
const inventoryItem = await tx.inventoryItem.findUnique({
  where: { menuItemId: item.menuItemId }
});
```

**Step B: Calculate ML Consumed**
```typescript
// Example: "Whiskey 60ml" → 60ml
// Example: "Vodka Full Bottle" → 750ml
const mlConsumed = extractServingSize(item.name, inventoryItem.bottleSize);
const totalMl = mlConsumed * item.quantity;
```

**Step C: Deduct Stock**
```typescript
await tx.inventoryItem.update({
  where: { id: inventoryItem.id },
  data: { currentStock: { decrement: totalMl } }
});
```

**Step D: Record Transaction**
```typescript
await tx.inventoryTransaction.create({
  data: {
    type: 'SALE',
    quantityChange: -totalMl,
    orderId: order.id,
    notes: `Order #${order.id} - ${item.quantity}x ${item.name}`
  }
});
```

**Step E: Check for Low Stock**
```typescript
if (updatedStock <= reorderLevel) {
  emit('inventory:low_stock', { item });
}
```

### 5. Table Reset
```typescript
await tx.table.update({
  where: { id: tableId },
  data: {
    status: TableStatus.AVAILABLE,
    currentBill: 0,
    kotHistory: []
  }
});
```

### 6. Events Emitted
```typescript
emit('order:paid', { orderId, tableId });
emit('table:updated', { table });
emit('inventory:updated', { itemId, currentStock });
emit('print_job', { type: 'BILL', data: {...} });
```

## Serving Size Detection Logic

### Priority 1: Item Name Pattern Matching
```typescript
const name = "Whiskey 60ml";

if (name.includes('30ml')) return 30;
if (name.includes('60ml')) return 60;
if (name.includes('90ml')) return 90;
if (name.includes('bottle') || name.includes('full')) return bottleSize;
```

### Priority 2: Price-Based Variant Matching
```typescript
// If name doesn't contain size, match by price
const variant = menuItem.variants.find(v => v.price === item.price);
if (variant.name.includes('60ml')) return 60;
```

### Priority 3: Default Fallback
```typescript
// If no match found, assume full bottle
return inventoryItem.bottleSize; // 750ml, 650ml, etc.
```

## Example Scenarios

### Scenario 1: Simple Order
**Input:**
```json
{
  "items": [
    { "name": "Whiskey 60ml", "quantity": 2, "menuType": "LIQUOR" }
  ]
}
```

**Processing:**
- Item name contains "60ml" → mlConsumed = 60
- Total: 60ml × 2 = 120ml
- Stock: 1500ml → 1380ml

**Transaction Record:**
```json
{
  "type": "SALE",
  "quantityChange": -120,
  "stockBefore": 1500,
  "stockAfter": 1380,
  "notes": "Order #abc123 - 2x Whiskey 60ml (60ml each)"
}
```

### Scenario 2: Mixed Food + Liquor
**Input:**
```json
{
  "items": [
    { "name": "Chicken Tikka", "quantity": 1, "menuType": "FOOD" },
    { "name": "Vodka 30ml", "quantity": 3, "menuType": "LIQUOR" },
    { "name": "Naan", "quantity": 2, "menuType": "FOOD" }
  ]
}
```

**Processing:**
- Food items ignored (Chicken Tikka, Naan)
- Only Vodka processed: 30ml × 3 = 90ml
- Vodka stock: 2000ml → 1910ml

### Scenario 3: Full Bottle Order
**Input:**
```json
{
  "items": [
    { "name": "Black Label Full Bottle", "quantity": 1, "menuType": "LIQUOR" }
  ]
}
```

**Processing:**
- Item name contains "bottle" → mlConsumed = bottleSize (750ml)
- Total: 750ml × 1 = 750ml
- Stock: 3000ml → 2250ml

### Scenario 4: Removed Items
**Input:**
```json
{
  "items": [
    { "name": "Rum 60ml", "quantity": 2, "removedFromBill": false },
    { "name": "Vodka 30ml", "quantity": 1, "removedFromBill": true }
  ]
}
```

**Processing:**
- Vodka skipped (removedFromBill = true)
- Only Rum processed: 60ml × 2 = 120ml
- Rum stock: 1000ml → 880ml

## Error Handling

### Case 1: No Inventory Entry
```typescript
if (!inventoryItem) {
  console.log(`[Inventory] No tracking for menuItem ${menuItemId}`);
  continue; // Skip gracefully
}
```

**Result:** Payment succeeds, no stock deduction

### Case 2: Insufficient Stock
```typescript
if (currentStock < totalMl) {
  console.warn(`Insufficient stock: need ${totalMl}ml, have ${currentStock}ml`);
  // Continue anyway - don't block payment
}
```

**Result:** Payment succeeds, stock goes negative (to be reconciled)

### Case 3: Transaction Failure
```typescript
await prisma.$transaction(async (tx) => {
  // All operations here
}, { timeout: 15000 });
```

**Result:** All changes rolled back, payment fails with error

## Socket Events Reference

### inventory:updated
**Emitted:** After every stock deduction
**Payload:**
```typescript
{
  restaurantId: "bar-001",
  itemId: "inv-123",
  currentStock: 1380
}
```

**Use:** Update real-time inventory displays

### inventory:low_stock
**Emitted:** When stock falls below reorder level
**Payload:**
```typescript
{
  restaurantId: "bar-001",
  item: {
    id: "inv-123",
    name: "Whiskey",
    currentStock: 140,
    reorderLevel: 150,
    unitOfMeasure: "ml"
  }
}
```

**Use:** Trigger reorder alerts, show notifications

## Database Schema

### InventoryItem
```sql
CREATE TABLE inventory_items (
  id TEXT PRIMARY KEY,
  menu_item_id TEXT UNIQUE NOT NULL,
  restaurant_id TEXT NOT NULL,
  unit_of_measure TEXT NOT NULL,
  bottle_size INT NOT NULL,
  current_stock DECIMAL(10,2) NOT NULL,
  reorder_level DECIMAL(10,2) NOT NULL
);
```

### InventoryTransaction
```sql
CREATE TABLE inventory_transactions (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  order_id TEXT,
  type TEXT NOT NULL, -- 'PURCHASE', 'SALE', 'WASTAGE', 'ADJUSTMENT'
  quantity_change DECIMAL(10,2) NOT NULL,
  stock_before DECIMAL(10,2) NOT NULL,
  stock_after DECIMAL(10,2) NOT NULL,
  notes TEXT,
  transaction_date TIMESTAMP DEFAULT NOW()
);
```

## API Endpoints Affected

### Modified Endpoint
```
POST /api/orders/:id/pay
```

**Before:** Only marked order as paid and reset table
**Now:** Also deducts inventory and records transactions

**Breaking Changes:** None (backward compatible)

## Testing Commands

### Test Stock Deduction
```bash
# Create order with liquor
POST /api/orders
{
  "tableId": "table-1",
  "restaurantId": "bar-001",
  "items": [
    { "menuItemId": "item-123", "name": "Whiskey 60ml", "quantity": 2, "price": 200, "menuType": "LIQUOR" }
  ]
}

# Pay order
POST /api/orders/{orderId}/pay
{ "paymentMethod": "CASH" }

# Check inventory
GET /api/bar/inventory/items
# Verify currentStock reduced by 120ml
```

### Test Low Stock Alert
```bash
# Set low stock via adjustment
PATCH /api/bar/inventory/items/{itemId}/adjust
{ "adjustmentType": "SET", "quantity": 100, "notes": "Testing low stock" }

# Create order that pushes below reorder level
POST /api/orders
# ... order with 60ml item

# Pay and listen for socket event
POST /api/orders/{orderId}/pay

# Socket listener should receive:
socket.on('inventory:low_stock', (data) => {
  console.log('Alert:', data);
});
```

## Performance Considerations

### Transaction Duration
- **Before:** ~50ms (order + table update)
- **After:** ~150ms (order + inventory + table update)
- **Acceptable:** Yes (still under 200ms)

### Database Queries per Payment
- 1x Order update
- Nx Inventory lookups (N = liquor items)
- Nx Stock updates
- Nx Transaction inserts
- 1x Table reset

**Example:** Order with 3 liquor items = ~8 queries

### Optimization Tips
1. Use transaction to batch all queries
2. Socket events emitted after commit (non-blocking)
3. Inventory lookups only for LIQUOR items
4. Skip items with no inventory tracking

## Troubleshooting

### Issue: Stock not deducting
**Check:**
1. Item has `menuType: 'LIQUOR'`
2. InventoryItem exists for menuItemId
3. Item not marked `removedFromBill: true`
4. Check logs for "[Inventory]" messages

### Issue: Wrong amount deducted
**Check:**
1. Item name format (should contain size: "60ml", "bottle", etc.)
2. Variant names in database
3. Item price matches variant price
4. Console logs show detected mlConsumed

### Issue: Payment failing
**Check:**
1. Database transaction timeout (15s)
2. Prisma connection pool
3. Error logs for constraint violations
4. Network connectivity to database

## Future Enhancements

### Planned (Phase 4)
- Daily inventory snapshots
- Automated wastage tracking
- Variance reports
- Low stock prediction

### Potential Improvements
- Batch deductions for performance
- Real-time stock validation before order creation
- Multi-unit support (ml, bottles, cases)
- Expiry date tracking

---

**Version:** 1.0
**Last Updated:** 2026-05-28
**Related:** PHASE_3_IMPLEMENTATION_COMPLETE.md
