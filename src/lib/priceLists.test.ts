// ─────────────────────────────────────────────────────────────────────────────
// priceLists.test.ts — saving one venue's price never moves another venue's
// ─────────────────────────────────────────────────────────────────────────────
// Venues that share a price list used to overwrite each other when an item was
// saved (the edit form sends every venue's price). A venue now gets its own copy
// of a shared list when its price really changes.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./prisma', () => ({ default: {} }));

import { giveVenueOwnPriceList, priceListForWrite } from './priceResolver';

type Venue = { id: string; name: string; priceProfileId: string | null; isDeleted: boolean };

let venues: Venue[];
let profiles: Array<{ id: string; name: string }>;
let items: Array<{ priceProfileId: string; menuItemId: string; price: number; restaurantId: string }>;
let seq: number;

function fakeDb() {
  return {
    priceProfile: {
      create: async ({ data }: any) => { const p = { id: `pp-new-${++seq}`, name: data.name }; profiles.push(p); return p; },
    },
    venue: {
      update: async ({ where, data }: any) => { Object.assign(venues.find(v => v.id === where.id)!, data); },
      count: async ({ where }: any) =>
        venues.filter(v => v.priceProfileId === where.priceProfileId && !v.isDeleted && v.id !== where.id.not).length,
    },
    priceProfileItem: {
      findMany: async ({ where }: any) => items.filter(i => i.priceProfileId === where.priceProfileId),
      findUnique: async ({ where }: any) => {
        const k = where.priceProfileId_menuItemId;
        return items.find(i => i.priceProfileId === k.priceProfileId && i.menuItemId === k.menuItemId) ?? null;
      },
      createMany: async ({ data }: any) => { items.push(...data); },
    },
  };
}

const price = (profileId: string | null, item: string) => items.find(i => i.priceProfileId === profileId && i.menuItemId === item)?.price;

beforeEach(() => {
  seq = 0;
  venues = [
    { id: 'v-ac', name: 'AC Hall', priceProfileId: 'pp-shared', isDeleted: false },
    { id: 'v-fam', name: 'Family', priceProfileId: 'pp-shared', isDeleted: false },
    { id: 'v-solo', name: 'Solo', priceProfileId: 'pp-solo', isDeleted: false },
    { id: 'v-new', name: 'New', priceProfileId: null, isDeleted: false },
  ];
  profiles = [{ id: 'pp-shared', name: 'Shared' }, { id: 'pp-solo', name: 'Solo' }];
  items = [
    { priceProfileId: 'pp-shared', menuItemId: 'biryani', price: 250, restaurantId: 'r1' },
    { priceProfileId: 'pp-shared', menuItemId: 'naan', price: 60, restaurantId: 'r1' },
    { priceProfileId: 'pp-solo', menuItemId: 'biryani', price: 100, restaurantId: 'r1' },
  ];
});

describe('priceListForWrite', () => {
  it('changing a price on a shared list gives that venue its own copy; the other venue keeps its price', async () => {
    const id = await priceListForWrite(fakeDb(), venues[0], 'r1', 'biryani', 300);

    expect(id).not.toBe('pp-shared');
    expect(venues[0].priceProfileId).toBe(id);
    expect(venues[1].priceProfileId).toBe('pp-shared');
    expect(price(id, 'naan')).toBe(60); // the rest of the list was copied
    expect(price('pp-shared', 'biryani')).toBe(250); // other venue untouched
  });

  it('the edit form re-sending the other venue\'s unchanged price changes nothing', async () => {
    const db = fakeDb();
    const a = await priceListForWrite(db, { ...venues[0] }, 'r1', 'biryani', 300);
    await db.priceProfileItem.createMany({ data: [] });
    items.find(i => i.priceProfileId === a && i.menuItemId === 'biryani')!.price = 300;

    // Same save, second venue, still its old price: it is alone on the shared list now.
    const b = await priceListForWrite(db, { ...venues[1] }, 'r1', 'biryani', 250);

    expect(b).toBe('pp-shared');
    expect(price('pp-shared', 'biryani')).toBe(250);
    expect(price(a, 'biryani')).toBe(300);
  });

  it('an unchanged price on a shared list does not split it', async () => {
    const id = await priceListForWrite(fakeDb(), venues[0], 'r1', 'biryani', 250);

    expect(id).toBe('pp-shared');
    expect(profiles).toHaveLength(2);
  });

  it('a venue with its own list keeps using it', async () => {
    expect(await priceListForWrite(fakeDb(), venues[2], 'r1', 'biryani', 120)).toBe('pp-solo');
  });

  it('a venue with no list gets one', async () => {
    const id = await priceListForWrite(fakeDb(), venues[3], 'r1', 'biryani', 99);

    expect(venues[3].priceProfileId).toBe(id);
    expect(profiles.find(p => p.id === id)?.name).toBe('New');
  });
});

describe('giveVenueOwnPriceList', () => {
  it('copies a shared list for the venue and leaves the other venue on the original', async () => {
    const id = await giveVenueOwnPriceList(fakeDb(), venues[1], 'r1');

    expect(id).not.toBe('pp-shared');
    expect(price(id, 'biryani')).toBe(250);
    expect(venues[0].priceProfileId).toBe('pp-shared');
  });

  it('a venue alone on its list keeps it', async () => {
    expect(await giveVenueOwnPriceList(fakeDb(), venues[2], 'r1')).toBe('pp-solo');
  });
});
