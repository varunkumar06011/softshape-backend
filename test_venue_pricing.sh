#!/bin/bash

# Multi-Venue Pricing System - API Testing Script
# Usage: ./test_venue_pricing.sh [BACKEND_URL]
# Example: ./test_venue_pricing.sh https://softshape-backend.railway.app

BACKEND_URL="${1:-http://localhost:3000}"
RESTAURANT_ID="restaurant-001"

echo "=================================================="
echo "Multi-Venue Pricing System - API Tests"
echo "=================================================="
echo "Backend URL: $BACKEND_URL"
echo "Restaurant ID: $RESTAURANT_ID"
echo ""

# Test 1: Admin API - Get menu with venue prices and unit field
echo "Test 1: Admin API - Get menu with venue prices"
echo "GET $BACKEND_URL/api/menu/items/admin?restaurantId=$RESTAURANT_ID"
curl -s "$BACKEND_URL/api/menu/items/admin?restaurantId=$RESTAURANT_ID" | jq '.[0] | {name, price, unit, venuePrices}' || echo "❌ Failed"
echo ""

# Test 2: POS API - Get all items (no venue filter)
echo "Test 2: POS API - All items (no venue filter)"
echo "GET $BACKEND_URL/api/menu/items?restaurantId=$RESTAURANT_ID"
TOTAL_ITEMS=$(curl -s "$BACKEND_URL/api/menu/items?restaurantId=$RESTAURANT_ID" | jq 'length')
echo "✅ Total items: $TOTAL_ITEMS (expected: ~514)"
echo ""

# Test 3: POS API - Conference Hall filtered menu
echo "Test 3: POS API - Conference Hall filtered menu"
echo "GET $BACKEND_URL/api/menu/items?restaurantId=$RESTAURANT_ID&venueId=venue-conference1"
CONFERENCE_ITEMS=$(curl -s "$BACKEND_URL/api/menu/items?restaurantId=$RESTAURANT_ID&venueId=venue-conference1" | jq 'length')
echo "✅ Conference items: $CONFERENCE_ITEMS (expected: less than total)"
echo ""

# Test 4: POS API - PDR filtered menu
echo "Test 4: POS API - PDR filtered menu"
echo "GET $BACKEND_URL/api/menu/items?restaurantId=$RESTAURANT_ID&venueId=venue-pdr"
PDR_ITEMS=$(curl -s "$BACKEND_URL/api/menu/items?restaurantId=$RESTAURANT_ID&venueId=venue-pdr" | jq 'length')
echo "✅ PDR items: $PDR_ITEMS"
echo ""

# Test 5: POS API - Rooms filtered menu
echo "Test 5: POS API - Rooms filtered menu"
echo "GET $BACKEND_URL/api/menu/items?restaurantId=$RESTAURANT_ID&venueId=venue-rooms"
ROOMS_ITEMS=$(curl -s "$BACKEND_URL/api/menu/items?restaurantId=$RESTAURANT_ID&venueId=venue-rooms" | jq 'length')
echo "✅ Rooms items: $ROOMS_ITEMS"
echo ""

# Test 6: POS API - Parcel filtered menu
echo "Test 6: POS API - Parcel filtered menu"
echo "GET $BACKEND_URL/api/menu/items?restaurantId=$RESTAURANT_ID&venueId=venue-parcel"
PARCEL_ITEMS=$(curl -s "$BACKEND_URL/api/menu/items?restaurantId=$RESTAURANT_ID&venueId=venue-parcel" | jq 'length')
echo "✅ Parcel items: $PARCEL_ITEMS"
echo ""

# Test 7: Mansion House - Should NOT appear in Conference Hall
echo "Test 7: Mansion House in Conference Hall (should be empty)"
echo "GET $BACKEND_URL/api/menu/items?restaurantId=$RESTAURANT_ID&venueId=venue-conference1 | filter Mansion"
MANSION_CONFERENCE=$(curl -s "$BACKEND_URL/api/menu/items?restaurantId=$RESTAURANT_ID&venueId=venue-conference1" | jq '.[] | select(.name | contains("Mansion"))')
if [ -z "$MANSION_CONFERENCE" ]; then
  echo "✅ Mansion House correctly hidden in Conference Hall"
else
  echo "❌ Mansion House should NOT appear in Conference Hall"
  echo "$MANSION_CONFERENCE"
fi
echo ""

# Test 8: Mansion House - SHOULD appear in Parcel
echo "Test 8: Mansion House in Parcel (should show with price 790)"
echo "GET $BACKEND_URL/api/menu/items?restaurantId=$RESTAURANT_ID&venueId=venue-parcel | filter Mansion"
curl -s "$BACKEND_URL/api/menu/items?restaurantId=$RESTAURANT_ID&venueId=venue-parcel" | jq '.[] | select(.name | contains("Mansion")) | {name, price, unit}' || echo "⚠️ Mansion House not found (may not exist in database yet)"
echo ""

# Test 9: Check liquor items have unit field
echo "Test 9: Liquor items with unit field (sample)"
echo "GET $BACKEND_URL/api/menu/items/admin?restaurantId=$RESTAURANT_ID | filter LIQUOR items"
curl -s "$BACKEND_URL/api/menu/items/admin?restaurantId=$RESTAURANT_ID" | jq '[.[] | select(.menuType == "LIQUOR" and .unit != null) | {name, unit}] | .[0:5]' || echo "❌ Failed"
echo ""

# Test 10: Check food items have unit = null
echo "Test 10: Food items with unit = null (sample)"
echo "GET $BACKEND_URL/api/menu/items/admin?restaurantId=$RESTAURANT_ID | filter FOOD items"
curl -s "$BACKEND_URL/api/menu/items/admin?restaurantId=$RESTAURANT_ID" | jq '[.[] | select(.menuType == "FOOD") | {name, unit}] | .[0:3]' || echo "❌ Failed"
echo ""

# Test 11: Verify venue-specific prices differ
echo "Test 11: Same item, different venue prices (Chicken Biryani example)"
echo "Conference Hall:"
curl -s "$BACKEND_URL/api/menu/items?restaurantId=$RESTAURANT_ID&venueId=venue-conference1" | jq '.[] | select(.name | contains("CHICKEN BIRYANI")) | {name, price}' | head -1 || echo "⚠️ Not found"
echo "PDR:"
curl -s "$BACKEND_URL/api/menu/items?restaurantId=$RESTAURANT_ID&venueId=venue-pdr" | jq '.[] | select(.name | contains("CHICKEN BIRYANI")) | {name, price}' | head -1 || echo "⚠️ Not found"
echo ""

# Summary
echo "=================================================="
echo "Test Summary"
echo "=================================================="
echo "Total items (no filter): $TOTAL_ITEMS"
echo "Conference Hall items: $CONFERENCE_ITEMS"
echo "PDR items: $PDR_ITEMS"
echo "Rooms items: $ROOMS_ITEMS"
echo "Parcel items: $PARCEL_ITEMS"
echo ""
echo "✅ All tests completed!"
echo ""
echo "Next steps:"
echo "1. Verify total items ≈ 514"
echo "2. Verify filtered items < total items"
echo "3. Verify Mansion House hidden in Conference, visible in Parcel"
echo "4. Verify liquor items have unit field populated"
echo "5. Verify food items have unit = null"
echo "=================================================="
