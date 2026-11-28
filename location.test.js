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
  await assert.rejects(stores(undefined),/valid CEP/);
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

test('a missing exact item leaves a dated partial quote for the other lines and no whole-basket subtotal',async()=>{
  const {quoteShoppingList}=await import('./partner-plan.js');
  const quoted=[];
  const source={product:async sku=>{
    if(sku==='3') throw Error('catalog outage');
    return sku==='1'?[{sku,sellerId:'s',name:'Pack',currentPrice:3}]:[];
  },basket:async lines=>{
    quoted.push(lines.map(l=>[l.offer.sku,l.quantity]));
    return lines.map(({offer,quantity})=>({...offer,requestedQuantity:quantity,localStatus:'available',methods:[],observedAt:'2026-01-01T00:00:00Z'}));
  }};
  const d=await quoteShoppingList('paguemenos',source,[{query:'1',quantity:2},{query:'2'},{query:'3'}],'01001000');
  assert.deepEqual(quoted,[[['1',2]]]);assert.equal(d.status,'partial');
  assert.equal(d.estimatedProductTotalBRL,null);assert.equal(d.partialQuote.estimatedProductTotalBRL,6);
  assert.deepEqual(d.partialQuote.labels,['A']);
  assert.deepEqual(d.pending.map(r=>[r.label,r.status]),[['B','unknown_sku'],['C','catalog_lookup_failed']]);
  const missing=await quoteShoppingList('paguemenos',source,[{query:'2'}],'01001000');
  assert.equal(missing.status,'unfilled'); assert.equal(missing.partialQuote,undefined);
  const failure=await quoteShoppingList('paguemenos',source,[{query:'3'}],'01001000');
  assert.equal(failure.status,'source_failed');assert.equal(quoted.length,1);
});

test('only actual alternatives request selection; rejected preferences never trigger a substitute quote',async()=>{
  const {quoteShoppingList}=await import('./partner-plan.js');
  const source={search:async()=>[{sku:'2',name:'Pack B'},{sku:'3',name:'Pack C'}],
    product:async sku=>[{sku,name:'Marca A 10 mg',brand:'Marca A',type:'Referência'}],
    basket:assert.fail};
  const choice=await quoteShoppingList('paguemenos',source,[{query:'Marca',includeGenerics:false}],'01001000');
  assert.equal(choice.status,'choose_products'); assert.equal(choice.pending[0].status,'choose_product');
  const excluded=await quoteShoppingList('paguemenos',source,[{query:'1',brand:'Outra'}],'01001000');
  assert.equal(excluded.status,'unfilled');assert.equal(excluded.pending[0].status,'preference_unavailable');
});
