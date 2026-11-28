import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareOffers, quoteLocalOptions } from './compare.js';

test('location is optional, ambiguity stops checkout, and fulfillment failure is distinct from stock', async () => {
  const products=['a','b','c'].map((sku,i)=>({sku,role:i?'generic':'requested',currentPrice:10-i}));
  const compare=async()=>({status:'matches',products});
  const calls=[];
  const source={local:async (row,origin,quantity)=>{
    calls.push([row.sku,origin,quantity]);
    if(row.sku==='b') throw Error('unreachable');
    const pickup=km=>({channel:'pickup-in-point',pickupPointId:String(km),distanceKm:km});
    return {...row,localStatus:'available',methods:[pickup(4),pickup(row.sku==='a'?1:null)]};
  }};
  assert.deepEqual((await compareOffers({},source,compare)).products,products);
  assert.equal((await compareOffers({zipcode:'01001000'},source,async()=>({status:'choose_reference'}))).status,'choose_reference');
  assert.equal(calls.length,0);
  const here={latitude:-12,longitude:-44};
  const result=await compareOffers({coordinates:here},source,compare);
  assert.equal(result.status,'partial');
  assert.deepEqual(calls,products.map(p=>[p.sku,here,1]));
  assert.deepEqual(result.products.map(p=>p.sku),['a','c','b']);
  assert.equal(result.products[0].closestQuotedPickup.distanceKm,1);
  assert.equal(result.products[1].closestQuotedPickup,null);
  assert.equal(result.products[2].localStatus,'lookup_failed');
  assert.ok(result.products.every(p=>p.branchQuantity===null));
});

test('pickup price ignores delivery-only and failed listings and honors requested units', async () => {
  const offers=['delivery','pickup','failed'].map((sku,i)=>({sku, sellerId:'loja', name:sku,
    currentPrice:i+1, role:'requested'}));
  const selection={scope:'direct_requested_pack',status:'matches',products:offers};
  const source={local:async (p,_,n)=>{
    assert.equal(n,2);
    if(p.sku==='failed') throw Error('offline');
    return {...p,localStatus:'available',methods:[p.sku==='pickup'?{channel:'pickup-in-point',pickupPointId:'L'}:{channel:'delivery'}]};
  }};
  const r=await quoteLocalOptions(selection,source,'origem',2);
  assert.equal(r.status,'partial');
  assert.equal(r.lowestPricedPickup.sku,'pickup');
  assert.equal(r.lowestPricedPickup.branchQuantity,null);
  assert.equal(r.lowestPricedPickup.requestedQuantity,2);
  assert.equal(r.products.filter(p=>p.localStatus==='lookup_failed').length,1);
});
