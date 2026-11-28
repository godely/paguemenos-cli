import test from 'node:test';
import assert from 'node:assert/strict';
import { createRetailer } from './vtex.js';
import { stores } from './directory.js';

test('coordinate queries send longitude first and retain the origin of the quoted price', async () => {
  const source=createRetailer({name:'Test',site:'https://example.test'},async (_url,req)=>{
    const payload=JSON.parse(req.body);
    assert.deepEqual(payload.geoCoordinates,[-44,-12]);
    assert.equal(payload.postalCode,undefined);
    return Response.json({items:[{id:'1',seller:'1',availability:'available',quantity:2,sellingPrice:300}],logisticsInfo:[{itemIndex:0,slas:[{deliveryChannel:'delivery'}]}]});
  });
  const row=await source.local({sku:'1',sellerId:'1'},{latitude:-12,longitude:-44},2);
  assert.equal(row.priceScope,'verified_for_coordinates'); assert.equal(row.requestedQuantity,2);
});
test('Pague Menos locator excludes other banners and preserves unknown coordinates', async ()=>{
  const rows=await stores('01001000',async()=>Response.json([
    {cod_loja:1,bandeira:'PAGUE MENOS',nome_loja:'Centro',latitude_loja:'',longitude:null},
    {cod_loja:2,bandeira:'EXTRAFARMA',nome_loja:'Centro'},
  ]));
  assert.deepEqual(rows.map(s=>s.id),['1']); assert.equal(rows[0].address.latitude,null);
  await assert.rejects(stores(''),/valid CEP/);
});
test('one partner basket checks every selected line together after brand consent', async ()=>{
  const {quoteShoppingList,shoppingItems}=await import('./partner-plan.js');
  const asks=await quoteShoppingList('partner',{},[{query:'Example'}],'01001000',async()=>({kind:'brand'}));
  assert.deepEqual(asks.pendingBrands,['Example']);
  let count=0;
  const source={product:async sku=>[{sku,sellerId:'1',name:'Example '+sku}],
    basket:async lines=>{count++;return lines.map(({offer,quantity})=>({...offer,requestedQuantity:quantity,localStatus:'available',currentPrice:2,methods:[]}));}};
  const result=await quoteShoppingList('partner',source,shoppingItems(['1','2'],{quantity:['A=3']}),'01001000');
  assert.equal(count,1);assert.equal(result.estimatedProductTotalBRL,8);assert.equal(result.status,'fulfillable');
  assert.throws(()=>shoppingItems(['abc'],{generic:['A'],'brand-only':['A']}));
});
