# Multi-Venue Pricing System

## Overview
Menu items have different prices across 5 venues:
1. **Bar AC Hall** (base price stored in default MenuItemVariant)
2. **Conference Hall** (`venueId: venue-conference1`)
3. **PDR** (`venueId: venue-pdr`)
4. **Rooms** (`venueId: venue-rooms`)
5. **Parcel** (`venueId: venue-parcel`)

## Database Schema

### VenuePrice Model
```prisma
model VenuePrice {
  id         String   @id @default(cuid())
  venueId    String   // "venue-conference1", "venue-pdr", "venue-rooms", "venue-parcel"
  menuItemId String
  price      Decimal  @db.Decimal(10, 2)
  isActive   Boolean  @default(true)
  createdAt  DateTime @default(now())
  updatedAt  DateTime @updatedAt

  @@unique([venueId, menuItemId])
}
```

### MenuItem Model (Updated with Unit Field)
```prisma
model MenuItem {
  id            String            @id @default(uuid())
  name          String
  description   String?
  imageUrl      String?
  basePrice     Decimal           @default(0) @db.Decimal(10, 2)
  isVeg         Boolean           @default(true)
  isAvailable   Boolean           @default(true)
  isDeleted     Boolean           @default(false)
  deletedAt     DateTime?
  menuType      MenuType          @default(FOOD)
  sortOrder     Int               @default(0)
  unit          String?           @db.VarChar(20)  // ✅ NEW FIELD
  categoryId    String
  // ... relations
}
```

## API Usage

### Admin API - Get Menu with Venue Prices
```bash
GET /api/menu/items/admin?restaurantId=restaurant-001

Response:
[
  {
    "id": "uuid",
    "name": "Chicken Biryani",
    "price": 150,  // base price (Bar AC Hall)
    "unit": null,
    "venuePrices": {
      "venue-conference1": 170,
      "venue-pdr": 210,
      "venue-rooms": 170,
      "venue-parcel": 150
    }
  },
  {
    "id": "uuid",
    "name": "Royal Stag 750Ml",
    "price": 550,
    "unit": "750ml",  // ✅ Liquor items have units
    "venuePrices": {
      "venue-conference1": 600,
      "venue-pdr": 650,
      "venue-rooms": 600,
      "venue-parcel": 550
    }
  }
]
```

### POS API - Get All Items (No Venue Filter)
```bash
GET /api/menu/items?restaurantId=restaurant-001

Response: ALL items with base prices
[
  {
    "id": "uuid",
    "name": "Chicken Biryani",
    "price": 150,  // base price
    "category": "Main Course",
    "unit": null
  }
]
```

### POS API - Get Venue-Specific Menu
```bash
GET /api/menu/items?restaurantId=restaurant-001&venueId=venue-conference1

Response: ONLY items available in Conference Hall
[
  {
    "id": "uuid",
    "name": "Chicken Biryani",
    "price": 170,  // Conference Hall price
    "category": "Main Course",
    "unit": null
  }
]

# Items with price = 0 for this venue are automatically hidden
```

**Key Behavior**:
- Without `venueId`: Returns ALL menu items with base prices
- With `venueId`: Returns ONLY items where:
  - VenuePrice exists for that venue
  - `price > 0`
  - `isActive = true`

### Admin API - Create Item with Venue Prices
```bash
POST /api/menu/items
Content-Type: application/json

{
  "name": "New Dish",
  "category": "Main Course",
  "price": 100,  // base price
  "isVeg": true,
  "menuType": "FOOD",
  "unit": null,
  "venuePrices": {
    "venue-conference1": 120,
    "venue-pdr": 140,
    "venue-rooms": 120,
    "venue-parcel": 100
  }
}
```

### Admin API - Update Item with Venue Prices
```bash
PATCH /api/menu/items/:id
Content-Type: application/json

{
  "name": "Updated Dish Name",
  "price": 110,  // Update base price
  "unit": "250ml",  // Update unit
  "venuePrices": {
    "venue-conference1": 130,
    "venue-pdr": 150,
    "venue-rooms": 130,
    "venue-parcel": 110
  }
}
```

## CSV Import

### CSV Format
```csv
Item name,Bar Ac Hall,Conference Hall,pdr,rooms,parcel
Chicken Biryani,150,170,210,170,150
Mansion House 750Ml,0,0,0,0,790
Royal Stag 30Ml,40,50,60,50,40
```

### Run Import
```bash
node import_exact_menu_csv.js

# Or for bar-only update (preserves venue prices):
node import_exact_menu_csv.js --bar-only
```

### Import Logic
1. **Base Price** (Bar AC Hall) → stored in default MenuItemVariant
2. **Venue Prices** → stored in VenuePrice table
3. **Unit Field** → auto-inferred from item name
4. **Zero Prices** → `isActive: false` (item hidden in that venue)
5. **All Prices = 0** → Item should be deleted (see cleanup script)

### Unit Inference Logic
The CSV import automatically detects units from item names:

```javascript
function inferUnit(name) {
  const n = name.toLowerCase();

  if (n.includes('750ml')) return '750ml';
  if (n.includes('650ml')) return '650ml';  // Beer
  if (n.includes('375ml')) return '375ml';
  if (n.includes('180ml')) return '180ml';
  if (n.includes('90ml')) return '90ml';
  if (n.includes('60ml')) return '60ml';
  if (n.includes('30ml')) return '30ml';
  if (n.includes('2ltr')) return '2ltr';
  if (n.includes('1ltr')) return '1ltr';
  if (n.includes('bottle')) return 'bottle';

  return null;  // Food items
}
```

**Examples**:
- `"Royal Stag 30Ml"` → `unit: "30ml"`
- `"Kingfisher Beer 650Ml"` → `unit: "650ml"`
- `"Officer's Choice 750Ml"` → `unit: "750ml"`
- `"Chicken Biryani"` → `unit: null`

## Unit Field

Liquor items have a `unit` field for inventory tracking:

### Supported Units
- `"30ml"` - Single peg (spirits)
- `"60ml"` - Double peg
- `"90ml"` - Triple peg
- `"180ml"` - Quarter bottle
- `"375ml"` - Half bottle
- `"750ml"` - Full bottle (spirits)
- `"650ml"` - Beer bottle
- `"1ltr"` - 1 liter
- `"2ltr"` - 2 liter
- `"bottle"` - Generic bottle
- `null` - Food items (no unit)

### Usage
- **Inventory Deduction**: Unit determines how much stock to deduct
  - `30ml` peg → Deduct 30ml from bottle stock
  - `750ml` bottle → Deduct 1 full bottle (750ml)
  - `650ml` beer → Deduct 1 beer bottle (650ml)

- **Display**: Show unit in menu (e.g., "Royal Stag (30ml) - ₹40")

## Frontend Integration

### Cashier/Waiter Panel (Venue Selection)

**Step 1: User Selects Venue**
```typescript
const [selectedVenue, setSelectedVenue] = useState<string>('venue-conference1');

const venues = [
  { id: 'venue-conference1', name: 'Conference Hall' },
  { id: 'venue-pdr', name: 'PDR' },
  { id: 'venue-rooms', name: 'Rooms' },
  { id: 'venue-parcel', name: 'Parcel' },
];
```

**Step 2: Fetch Venue-Specific Menu**
```typescript
const fetchMenu = async (venueId: string) => {
  const response = await fetch(
    `/api/menu/items?restaurantId=restaurant-001&venueId=${venueId}`
  );
  const items = await response.json();
  // items now contains only items available in selected venue
  // with venue-specific prices
};
```

**Step 3: Display Menu**
```typescript
{items.map(item => (
  <MenuItem key={item.id}>
    <h3>{item.name} {item.unit && `(${item.unit})`}</h3>
    <p>₹{item.price}</p>
  </MenuItem>
))}
```

### Admin Panel (Multi-Venue Price Editor)

**Step 1: Fetch Admin Menu**
```typescript
const response = await fetch('/api/menu/items/admin?restaurantId=restaurant-001');
const items = await response.json();
```

**Step 2: Display Price Table**
```typescript
<table>
  <thead>
    <tr>
      <th>Item</th>
      <th>Unit</th>
      <th>Bar AC</th>
      <th>Conference</th>
      <th>PDR</th>
      <th>Rooms</th>
      <th>Parcel</th>
    </tr>
  </thead>
  <tbody>
    {items.map(item => (
      <tr key={item.id}>
        <td>{item.name}</td>
        <td>{item.unit || '-'}</td>
        <td><input value={item.price} /></td>
        <td><input value={item.venuePrices['venue-conference1'] || 0} /></td>
        <td><input value={item.venuePrices['venue-pdr'] || 0} /></td>
        <td><input value={item.venuePrices['venue-rooms'] || 0} /></td>
        <td><input value={item.venuePrices['venue-parcel'] || 0} /></td>
      </tr>
    ))}
  </tbody>
</table>
```

**Step 3: Update Prices**
```typescript
const updatePrices = async (itemId: string, prices: Record<string, number>) => {
  await fetch(`/api/menu/items/${itemId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      price: prices.base,  // Bar AC Hall price
      unit: prices.unit,
      venuePrices: {
        'venue-conference1': prices.conference,
        'venue-pdr': prices.pdr,
        'venue-rooms': prices.rooms,
        'venue-parcel': prices.parcel,
      }
    })
  });
};
```

## Example: Mansion House 750ml (Parcel-Only Item)

### Database State
```json
{
  "name": "Mansion House 750Ml",
  "menuType": "LIQUOR",
  "unit": "750ml",
  "price": 0,  // Not available in Bar AC Hall
  "venuePrices": {
    "venue-conference1": 0,  // ❌ Hidden in Conference
    "venue-pdr": 0,           // ❌ Hidden in PDR
    "venue-rooms": 0,         // ❌ Hidden in Rooms
    "venue-parcel": 790       // ✅ ONLY available for parcel
  }
}
```

### API Responses

**Conference Hall Menu:**
```bash
GET /api/menu/items?restaurantId=restaurant-001&venueId=venue-conference1
# Mansion House 750ml will NOT appear (price = 0)
```

**Parcel Menu:**
```bash
GET /api/menu/items?restaurantId=restaurant-001&venueId=venue-parcel
# Mansion House 750ml WILL appear with price = ₹790
```

**Admin View:**
```json
{
  "name": "Mansion House 750Ml",
  "unit": "750ml",
  "price": 0,
  "venuePrices": {
    "venue-conference1": 0,
    "venue-pdr": 0,
    "venue-rooms": 0,
    "venue-parcel": 790
  }
}
```

## Data Cleanup

### Problem: Items with All Prices = 0
Some items (e.g., "Buffet Nv", "Buffet Veg") have zero prices across all venues.

### Solution: Cleanup Script
```bash
npx ts-node scripts/cleanupMenu.ts
```

**Script Location**: `scripts/cleanupMenu.ts`

**What it does**:
- Finds items matching "Buffet Nv" and "Buffet Veg"
- Soft-deletes them (`isDeleted = true`, `deletedAt = now()`)
- Prevents them from appearing in any API responses

**Manual SQL (if script fails)**:
```sql
UPDATE "MenuItem"
SET "isDeleted" = true, "deletedAt" = NOW()
WHERE name ILIKE '%Buffet Nv%' OR name ILIKE '%Buffet Veg%';
```

## Database Migration

### Add Unit Field to MenuItem
```bash
# Create migration
npx prisma migrate dev --name "add_unit_field_to_menu_item"

# Generate Prisma Client
npx prisma generate

# Apply to production
npx prisma migrate deploy
```

### Migration File
The migration adds:
```sql
ALTER TABLE "MenuItem" ADD COLUMN "unit" VARCHAR(20);
```

## Statistics

- **Total menu items**: ~514 (after deleting 2 zero-price items)
- **Items with partial availability**: ~172 (33%)
- **Liquor items**: ~152 (29%)
- **Venue count**: 4 (Conference, PDR, Rooms, Parcel)
- **VenuePrice rows**: ~2,056 (514 items × 4 venues)

## Testing

### Test Venue Filtering
```bash
# Test without venue (should return ALL items)
curl "http://localhost:3000/api/menu/items?restaurantId=restaurant-001" | jq 'length'
# Expected: ~514 items

# Test with Conference Hall (should filter items)
curl "http://localhost:3000/api/menu/items?restaurantId=restaurant-001&venueId=venue-conference1" | jq 'length'
# Expected: Less items (items with price = 0 hidden)

# Test Mansion House (should NOT appear in Conference)
curl "http://localhost:3000/api/menu/items?restaurantId=restaurant-001&venueId=venue-conference1" | jq '.[] | select(.name | contains("Mansion"))'
# Expected: Empty (no results)

# Test Mansion House (SHOULD appear in Parcel)
curl "http://localhost:3000/api/menu/items?restaurantId=restaurant-001&venueId=venue-parcel" | jq '.[] | select(.name | contains("Mansion"))'
# Expected: { "name": "Mansion House 750Ml", "price": 790, "unit": "750ml", ... }
```

### Test Admin API
```bash
# Get admin menu with all prices
curl "http://localhost:3000/api/menu/items/admin?restaurantId=restaurant-001" | jq '.[0]'
# Expected: Item with venuePrices object and unit field
```

### Test Unit Field
```bash
# Check liquor items have units
curl "http://localhost:3000/api/menu/items/admin?restaurantId=restaurant-001" | jq '.[] | select(.menuType == "LIQUOR") | {name, unit}'
# Expected: Liquor items with unit: "30ml", "750ml", etc.

# Check food items have null units
curl "http://localhost:3000/api/menu/items/admin?restaurantId=restaurant-001" | jq '.[] | select(.menuType == "FOOD") | {name, unit}'
# Expected: Food items with unit: null
```

## Troubleshooting

### Issue: Items missing in venue menu
**Cause**: VenuePrice row missing or price = 0
**Solution**:
1. Check VenuePrice table: `SELECT * FROM "VenuePrice" WHERE "menuItemId" = 'item-id' AND "venueId" = 'venue-conference1';`
2. Re-run CSV import: `node import_exact_menu_csv.js`

### Issue: Wrong prices in venue
**Cause**: VenuePrice not updated
**Solution**:
1. Update via admin API: `PATCH /api/menu/items/:id` with `venuePrices`
2. Or run CSV import with latest prices

### Issue: Unit field not populated
**Cause**: Migration not run or old data not updated
**Solution**:
1. Run migration: `npx prisma migrate deploy`
2. Re-run CSV import: `node import_exact_menu_csv.js`
3. Check unit inference logic in `inferUnit()` function

### Issue: All items showing in all venues
**Cause**: Frontend not passing `venueId` parameter
**Solution**:
1. Check API call includes `venueId` query parameter
2. Verify venue selector is working in frontend

## Best Practices

### Adding New Menu Items
1. **Via Admin API**: Always provide `venuePrices` object
2. **Via CSV**: Update CSV and re-import (safest)
3. **Set Unit**: For liquor, manually set unit or ensure name includes ml/ltr

### Updating Prices
1. **Bulk Update**: Use CSV import
2. **Single Item**: Use admin API PATCH endpoint
3. **Never** directly modify VenuePrice table (use API)

### Venue Management
1. **New Venue**: Add `venueId` to `ADMIN_VENUE_IDS` in menu.ts
2. **Update CSV**: Add new column for venue
3. **Re-import**: Run CSV import to populate VenuePrice rows

## Version History

- **v1.0.0** (2024-06-03): Multi-venue pricing system implemented
  - Added `unit` field to MenuItem model
  - Updated POS API to support `venueId` filtering
  - Updated Admin API to include `unit` in responses
  - Enhanced CSV import with unit inference
  - Created cleanup script for zero-price items
  - Updated menu routes to accept `unit` in POST/PATCH

---

**Remember**:
- VenuePrice table already exists ✅
- Unit field added to schema ✅
- POS API filters by venueId ✅
- Admin API returns all venue prices ✅
- CSV import populates unit field ✅
