import test from 'node:test';
import assert from 'node:assert/strict';
import { createRetailer, validGtin } from './vtex.js';
test('exact GTIN filters other variants, missing SLAs keep the price online-only', async () => {
  const offer = { sellerId: '1', sellerName: 'Example', commertialOffer: { Price: 12.5, ListPrice: 15, IsAvailable: true } };
  const item = { itemId: '12', ean: '7899547543766', name: 'Example pack', sellers: [offer] };
  const retailer = createRetailer({ name: 'Example', site: 'https://example.com' }, async (url) =>
    Response.json(url.pathname.endsWith('simulation') ?
      { items: [{ id: '12', seller: '1', availability: 'available', quantity: 1, sellingPrice: 100 }], logisticsInfo: [{ itemIndex: 0, slas: [] }] } :
      [{ items: [item, { ...item, itemId: '13', ean: '7891142137135' }] }]));
  const rows = await retailer.byGtin(item.ean);
  assert.equal(rows.length,1);
  assert.equal(validGtin('7899547543767'), false);
  const localized = await retailer.local(rows[0], '01001000');
  assert.deepEqual([localized.priceScope, localized.currentPrice, localized.localStatus], ['anonymous_online',12.5,'unverified']);
});
