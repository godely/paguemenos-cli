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

test('fulfillment belongs to the SKU, seller, quantity and a recognized channel', async () => {
  const item = {id:'8', seller:'1', availability:'available', quantity:2, sellingPrice:899, listPrice:1499};
  const sla = {id:'Retirada', deliveryChannel:'pickup-in-point',price:0,pickupPointId:'1_12',pickupStoreInfo:{friendlyName:'Centro'}};
  const quote = {items:[item], logisticsInfo:[{itemIndex:0,itemId:'8',slas:[sla]}]};
  const retailer = createRetailer({name:'Example',site:'https://example.com'}, async()=>Response.json(quote));
  const row = {sku:'8',sellerId:'1',currentPrice:12,listPrice:15};
  let r = await retailer.local(row,'01001000',2);
  assert.equal(r.priceScope,'verified_for_cep'); assert.equal(r.methods[0].pickupPointId,'1_12');
  assert.equal(r.currentPrice,8.99); assert.equal(r.methods[0].feeBRL,0);
  for (const patch of [{...item,seller:'2'}, {...item,id:'9'}, {...item,quantity:1}, {...item,availability:'withoutStock'}]) {
    quote.items=[patch]; r=await retailer.local(row,'01001000',2); assert.equal(r.priceScope,'anonymous_online'); assert.equal(r.methods.length,0);
  }
  quote.items=[item]; quote.logisticsInfo[0].itemId='9';
  assert.equal((await retailer.local(row,'01001000')).priceScope,'anonymous_online');
  quote.logisticsInfo[0]={itemIndex:0,slas:[{}]};
  assert.equal((await retailer.local(row,'01001000')).priceScope,'anonymous_online');
});
test('stockout zero-price placeholders do not become free offers', async () => {
  const retailer=createRetailer({name:'Example',site:'https://example.com'},async()=>Response.json([{
    items:[{itemId:'9', name:'Exemplo', sellers:[{sellerId:'1',commertialOffer:{Price:0,ListPrice:0,IsAvailable:false}}]}]
  }]));
  const [row]=await retailer.product('9');
  assert.equal(row.inStock,false); assert.equal(row.currentPrice,null); assert.equal(row.listPrice,null);
});
