# Bar Inventory API Documentation

## Base URL
All inventory endpoints are prefixed with: `/api/bar/inventory`

Backend base URL: `http://localhost:3000` (development) or `https://softshape-backend.onrender.com` (production)

## Authentication
Currently no authentication required (internal use only).

## Constants
- **BAR_ID**: `"bar-001"`
- **IST Timezone**: UTC+5:30

---

## Endpoints

### 1. List All Inventory Items
Get all inventory items for the bar.

**Endpoint:** `GET /api/bar/inventory/items`

**Response:**
```json
[
  {
    "id": "clxxx...",
    "menuItemId": "clyyy...",
    "restaurantId": "bar-001",
    "unitOfMeasure": "ml",
    "bottleSize": 750,
    "openingStock": "15000",
    "currentStock": "12500",
    "reorderLevel": "5000",
    "costPerBottle": "1500.00",
    "lastRestocked": "2024-05-28T10:30:00.000Z",
    "createdAt": "2024-05-28T10:00:00.000Z",
    "updatedAt": "2024-05-28T10:30:00.000Z",
    "menuItem": {
      "id": "clyyy...",
      "name": "Johnnie Walker Black Label",
      "category": {
        "name": "Whiskey",
        "id": "clzzz..."
      },
      "variants": [
        {
          "id": "claaa...",
          "name": "60ml",
          "price": "350.00",
          "isDefault": true
        }
      ]
    }
  }
]
```

**Test with curl:**
```bash
curl http://localhost:3000/api/bar/inventory/items
```

---

### 2. Get Single Item Details
Get detailed information about a specific inventory item including recent transactions.

**Endpoint:** `GET /api/bar/inventory/items/:id`

**Parameters:**
- `:id` - Inventory item ID

**Response:**
```json
{
  "id": "clxxx...",
  "menuItemId": "clyyy...",
  "currentStock": "12500",
  "reorderLevel": "5000",
  "menuItem": { ... },
  "transactions": [
    {
      "id": "clttt...",
      "type": "PURCHASE",
      "quantityChange": "7500",
      "stockBefore": "5000",
      "stockAfter": "12500",
      "notes": "Weekly restock",
      "createdBy": "Admin",
      "transactionDate": "2024-05-28T10:30:00.000Z"
    }
  ]
}
```

**Test with curl:**
```bash
curl http://localhost:3000/api/bar/inventory/items/ITEM_ID_HERE
```

---

### 3. Create New Inventory Item
Add a new liquor item to inventory tracking.

**Endpoint:** `POST /api/bar/inventory/items`

**Request Body:**
```json
{
  "menuItemId": "clyyy...",
  "unitOfMeasure": "ml",
  "bottleSize": 750,
  "currentStock": 15000,
  "reorderLevel": 5000,
  "costPerBottle": 1500
}
```

**Required Fields:**
- `menuItemId` - Must be an existing bar menu item ID
- `unitOfMeasure` - Unit (e.g., "ml", "bottle", "liter")
- `bottleSize` - Size in ML (750 for spirits, 650 for beer)
- `currentStock` - Initial stock amount
- `reorderLevel` - Minimum stock level before reorder alert

**Optional Fields:**
- `costPerBottle` - Cost per bottle for margin calculations

**Response:** 201 Created
```json
{
  "id": "clxxx...",
  "menuItemId": "clyyy...",
  "currentStock": "15000",
  ...
}
```

**Test with curl:**
```bash
curl -X POST http://localhost:3000/api/bar/inventory/items \
  -H "Content-Type: application/json" \
  -d '{
    "menuItemId": "YOUR_MENU_ITEM_ID",
    "unitOfMeasure": "ml",
    "bottleSize": 750,
    "currentStock": 15000,
    "reorderLevel": 5000,
    "costPerBottle": 1500
  }'
```

---

### 4. Update Inventory Item
Update item configuration (not stock levels - use adjust-stock for that).

**Endpoint:** `PATCH /api/bar/inventory/items/:id`

**Request Body:**
```json
{
  "reorderLevel": 7500,
  "costPerBottle": 1600,
  "unitOfMeasure": "ml",
  "bottleSize": 750
}
```

**All fields optional** - only include what you want to update.

**Response:** 200 OK
```json
{
  "id": "clxxx...",
  "reorderLevel": "7500",
  "costPerBottle": "1600.00",
  ...
}
```

**Test with curl:**
```bash
curl -X PATCH http://localhost:3000/api/bar/inventory/items/ITEM_ID_HERE \
  -H "Content-Type: application/json" \
  -d '{
    "reorderLevel": 7500,
    "costPerBottle": 1600
  }'
```

---

### 5. Delete Inventory Item
Remove an item from inventory tracking (cascades to transactions and snapshots).

**Endpoint:** `DELETE /api/bar/inventory/items/:id`

**Response:** 200 OK
```json
{
  "ok": true,
  "id": "clxxx..."
}
```

**Test with curl:**
```bash
curl -X DELETE http://localhost:3000/api/bar/inventory/items/ITEM_ID_HERE
```

---

### 6. Adjust Stock (Manual)
Record manual stock adjustments (wastage, corrections, etc.).

**Endpoint:** `POST /api/bar/inventory/adjust-stock`

**Request Body:**
```json
{
  "itemId": "clxxx...",
  "quantityChange": -750,
  "type": "WASTAGE",
  "notes": "Broken bottle - dropped by staff",
  "createdBy": "Manager A"
}
```

**Required Fields:**
- `itemId` - Inventory item ID
- `quantityChange` - Amount to add (positive) or deduct (negative)
- `type` - One of: `"WASTAGE"`, `"ADJUSTMENT"`

**Optional Fields:**
- `notes` - Reason for adjustment
- `createdBy` - User who made the adjustment

**Response:** 200 OK
```json
{
  "item": {
    "id": "clxxx...",
    "currentStock": "11750",
    ...
  },
  "transaction": {
    "id": "clttt...",
    "type": "WASTAGE",
    "quantityChange": "-750",
    "stockBefore": "12500",
    "stockAfter": "11750",
    ...
  }
}
```

**Socket Events Emitted:**
- `inventory:updated` - Always emitted
- `inventory:low_stock` - Emitted if stock falls to or below reorder level

**Test with curl:**
```bash
# Record wastage (reduces stock)
curl -X POST http://localhost:3000/api/bar/inventory/adjust-stock \
  -H "Content-Type: application/json" \
  -d '{
    "itemId": "ITEM_ID_HERE",
    "quantityChange": -750,
    "type": "WASTAGE",
    "notes": "Broken bottle",
    "createdBy": "Manager A"
  }'

# Record adjustment (adds stock)
curl -X POST http://localhost:3000/api/bar/inventory/adjust-stock \
  -H "Content-Type: application/json" \
  -d '{
    "itemId": "ITEM_ID_HERE",
    "quantityChange": 1500,
    "type": "ADJUSTMENT",
    "notes": "Found extra stock in storage",
    "createdBy": "Manager B"
  }'
```

---

### 7. Record Purchase
Record new stock purchases (increases stock).

**Endpoint:** `POST /api/bar/inventory/record-purchase`

**Request Body:**
```json
{
  "itemId": "clxxx...",
  "quantity": 15000,
  "costPerBottle": 1550,
  "notes": "Vendor: ABC Liquors, Invoice #12345",
  "createdBy": "Manager A"
}
```

**Required Fields:**
- `itemId` - Inventory item ID
- `quantity` - Amount purchased (must be positive)

**Optional Fields:**
- `costPerBottle` - Updates the item's cost per bottle
- `notes` - Purchase details, vendor info, invoice number
- `createdBy` - User who recorded the purchase

**Response:** 200 OK
```json
{
  "item": {
    "id": "clxxx...",
    "currentStock": "26750",
    "lastRestocked": "2024-05-28T12:00:00.000Z",
    ...
  },
  "transaction": {
    "id": "clttt...",
    "type": "PURCHASE",
    "quantityChange": "15000",
    "stockBefore": "11750",
    "stockAfter": "26750",
    ...
  }
}
```

**Socket Events Emitted:**
- `inventory:updated`

**Test with curl:**
```bash
curl -X POST http://localhost:3000/api/bar/inventory/record-purchase \
  -H "Content-Type: application/json" \
  -d '{
    "itemId": "ITEM_ID_HERE",
    "quantity": 15000,
    "costPerBottle": 1550,
    "notes": "Weekly restock - Invoice #12345",
    "createdBy": "Manager A"
  }'
```

---

### 8. Get Transaction History
Retrieve inventory transaction history with optional filters.

**Endpoint:** `GET /api/bar/inventory/transactions`

**Query Parameters:**
- `itemId` (optional) - Filter by specific item
- `type` (optional) - Filter by type: PURCHASE, SALE, WASTAGE, ADJUSTMENT
- `startDate` (optional) - Filter from date (YYYY-MM-DD)
- `endDate` (optional) - Filter to date (YYYY-MM-DD)
- `limit` (optional) - Max records to return (default: 100, max: 500)

**Response:**
```json
[
  {
    "id": "clttt...",
    "restaurantId": "bar-001",
    "itemId": "clxxx...",
    "type": "PURCHASE",
    "quantityChange": "15000",
    "stockBefore": "11750",
    "stockAfter": "26750",
    "notes": "Weekly restock",
    "createdBy": "Manager A",
    "transactionDate": "2024-05-28T12:00:00.000Z",
    "item": {
      "id": "clxxx...",
      "menuItem": {
        "name": "Johnnie Walker Black Label",
        "id": "clyyy..."
      }
    }
  }
]
```

**Test with curl:**
```bash
# All transactions
curl http://localhost:3000/api/bar/inventory/transactions

# Filter by item
curl "http://localhost:3000/api/bar/inventory/transactions?itemId=ITEM_ID_HERE"

# Filter by type
curl "http://localhost:3000/api/bar/inventory/transactions?type=WASTAGE"

# Filter by date range
curl "http://localhost:3000/api/bar/inventory/transactions?startDate=2024-05-01&endDate=2024-05-28"

# Combine filters
curl "http://localhost:3000/api/bar/inventory/transactions?itemId=ITEM_ID_HERE&type=PURCHASE&limit=50"
```

---

### 9. Daily Inventory Report
Get comprehensive daily report showing opening stock, purchases, sales, wastage, adjustments, and closing stock for all items.

**Endpoint:** `GET /api/bar/inventory/daily-report`

**Query Parameters:**
- `date` (optional) - Report date in YYYY-MM-DD format (defaults to today in IST)

**Response:**
```json
{
  "date": "2024-05-28",
  "restaurantId": "bar-001",
  "items": [
    {
      "itemId": "clxxx...",
      "itemName": "Johnnie Walker Black Label",
      "unitOfMeasure": "ml",
      "bottleSize": 750,
      "openingStock": "12500",
      "purchased": "15000",
      "sold": "0",
      "wastage": "750",
      "adjusted": "0",
      "closingStock": "26750",
      "reorderLevel": "5000",
      "isLowStock": false,
      "transactionCount": 2
    }
  ],
  "summary": {
    "totalItems": 25,
    "lowStockItems": 3,
    "totalTransactions": 47
  }
}
```

**Test with curl:**
```bash
# Today's report (IST)
curl http://localhost:3000/api/bar/inventory/daily-report

# Specific date
curl "http://localhost:3000/api/bar/inventory/daily-report?date=2024-05-27"
```

---

### 10. Low Stock Alert
Get items with stock at or below reorder level, sorted by urgency.

**Endpoint:** `GET /api/bar/inventory/low-stock`

**Response:**
```json
[
  {
    "id": "clxxx...",
    "menuItemId": "clyyy...",
    "currentStock": "2500",
    "reorderLevel": "5000",
    "urgencyPercent": 50,
    "stockDeficit": "2500",
    "menuItem": {
      "name": "Absolut Vodka",
      "category": {
        "name": "Vodka"
      },
      "variants": [...]
    }
  }
]
```

**Additional Fields:**
- `urgencyPercent` - Percentage of reorder level (lower = more urgent)
- `stockDeficit` - Amount below reorder level

**Socket Events Emitted:**
- `inventory:low_stock_alert` - Emitted with count and top 5 most urgent items

**Test with curl:**
```bash
curl http://localhost:3000/api/bar/inventory/low-stock
```

---

## Socket.io Events

All inventory operations emit real-time events to the `"bar-001"` room.

### Events Emitted

**1. `inventory:updated`**
Emitted when any inventory item is created, updated, or stock is changed.
```javascript
{
  restaurantId: "bar-001",
  item: { /* full inventory item object */ }
}
```

**2. `inventory:deleted`**
Emitted when an inventory item is deleted.
```javascript
{
  restaurantId: "bar-001",
  itemId: "clxxx..."
}
```

**3. `inventory:low_stock`**
Emitted when stock falls to or below reorder level during stock adjustment.
```javascript
{
  restaurantId: "bar-001",
  item: { /* full inventory item */ },
  currentStock: "2500",
  reorderLevel: "5000"
}
```

**4. `inventory:low_stock_alert`**
Emitted when low-stock endpoint is called and items are found.
```javascript
{
  restaurantId: "bar-001",
  count: 5,
  items: [ /* top 5 most urgent items */ ]
}
```

### Listening to Events (Frontend)

```javascript
import io from 'socket.io-client';

const socket = io('http://localhost:3000');
socket.emit('join', 'bar-001');

socket.on('inventory:updated', (data) => {
  console.log('Inventory updated:', data.item);
  // Update UI with new stock levels
});

socket.on('inventory:low_stock', (data) => {
  console.log('Low stock alert:', data.item.menuItem.name);
  // Show notification
});
```

---

## Transaction Types

| Type | Description | Stock Change |
|------|-------------|--------------|
| `PURCHASE` | New stock purchased | Increases (+) |
| `SALE` | Sold to customer | Decreases (-) |
| `WASTAGE` | Spoilage, breakage, theft | Decreases (-) |
| `ADJUSTMENT` | Manual correction | Either (+/-) |

---

## Error Responses

All endpoints return standard error responses:

**400 Bad Request**
```json
{
  "error": "menuItemId, unitOfMeasure, bottleSize, currentStock, and reorderLevel are required"
}
```

**404 Not Found**
```json
{
  "error": "Inventory item not found"
}
```

**409 Conflict**
```json
{
  "error": "Inventory item already exists for this menu item"
}
```

**500 Internal Server Error**
```json
{
  "error": "Failed to create inventory item"
}
```

---

## Complete Testing Flow

### Step 1: Get a Bar Menu Item ID
```bash
curl http://localhost:3000/api/bar/menu/items
# Copy a menuItemId from the response
```

### Step 2: Create Inventory Entry
```bash
curl -X POST http://localhost:3000/api/bar/inventory/items \
  -H "Content-Type: application/json" \
  -d '{
    "menuItemId": "YOUR_MENU_ITEM_ID",
    "unitOfMeasure": "ml",
    "bottleSize": 750,
    "currentStock": 15000,
    "reorderLevel": 5000,
    "costPerBottle": 1500
  }'
# Copy the returned inventory item ID
```

### Step 3: Test Stock Operations
```bash
# Record purchase
curl -X POST http://localhost:3000/api/bar/inventory/record-purchase \
  -H "Content-Type: application/json" \
  -d '{
    "itemId": "YOUR_INVENTORY_ITEM_ID",
    "quantity": 7500,
    "notes": "Test purchase"
  }'

# Record wastage
curl -X POST http://localhost:3000/api/bar/inventory/adjust-stock \
  -H "Content-Type: application/json" \
  -d '{
    "itemId": "YOUR_INVENTORY_ITEM_ID",
    "quantityChange": -750,
    "type": "WASTAGE",
    "notes": "Broken bottle"
  }'
```

### Step 4: Check Reports
```bash
# View transactions
curl "http://localhost:3000/api/bar/inventory/transactions?itemId=YOUR_INVENTORY_ITEM_ID"

# Daily report
curl http://localhost:3000/api/bar/inventory/daily-report

# Low stock check
curl http://localhost:3000/api/bar/inventory/low-stock
```

---

## Notes

- All stock quantities are stored as `Decimal` for precision
- All dates use IST timezone (UTC+5:30)
- Transaction history is preserved even after item deletion (via cascade)
- Low stock alerts are checked automatically during stock adjustments
- Socket events enable real-time UI updates across all connected clients
- Daily reports aggregate transactions within IST day boundaries (midnight to midnight IST)
