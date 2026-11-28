import test from 'node:test';
import assert from 'node:assert/strict';
import {fixedStoreSource, compareOffers} from './compare.js';
import {quoteShoppingList} from './partner-plan.js';
import {stores} from './directory.js';

const origin = {latitude:-12,longitude:-44};
const offer = {sku:'10',sellerId:'1',name:'Produto de teste',currentPrice:16};
const localQuote = methods => ({...offer,currentPrice:12,requestedQuantity:2,methods,localStatus:'available'});
const directory = [{id:'8',distanceKm:3},{id:'4',distanceKm:0.3},{id:'1',distanceKm:null}];
const pickup = id => ({channel:'pickup-in-point',pickupPointId:id});
const delivery = {channel:'delivery'};

for (const [retailer,near,far] of [['paguemenos','paguemenos00004_abcd','paguemenos00008_efab'],
  ['drogariasaopaulo','drogariaspcentro_4','drogariasaopaulocentro2_8']]) {
  test(retailer + ' verifies only the closest directory store, seller and requested number of packs', async () => {
    let row, directoryCalls=0;
    const source=fixedStoreSource(retailer,{stores:async p=>{assert.equal(p,origin); directoryCalls++; return directory},
      local:async()=>row},origin,'nearest');
    row=localQuote([pickup(far),delivery,pickup(near)]);
    const yes=await source.local(offer,origin,2);
    assert.deepEqual(yes.methods,[pickup(near)]);
    assert.equal(yes.pickupAtStore,'offered'); assert.equal(yes.branchQuantity,null);
    assert.equal(yes.currentPrice,12);
    for(const methods of [[pickup(far)], [delivery]]) {
      row=localQuote(methods);
      const no=await source.local(offer,origin,2);
      assert.equal(no.pickupAtStore,'not_offered'); assert.equal(no.currentPrice,16);
      assert.deepEqual(no.methods,[]); assert.equal(no.branchQuantity,null);
      assert.equal((await source.withStoreEvidence({products:[no]})).status,'pickup_not_offered');
    }
    for(const overrides of [{sellerId:'other'},{sku:'20'},{requestedQuantity:1},{methods:[pickup('unknown')]},{methods:[]}]) {
      row={...localQuote([pickup(near)]),...overrides};
      assert.equal((await source.local(offer,origin,2)).pickupAtStore,'unconfirmed');
    }
    const {fixedStore}=await source.withStoreEvidence({});
    assert.equal(fixedStore.branch.id,'4'); assert.equal(fixedStore.storesWithDistance,2);
    assert.equal(directoryCalls,1);
  });
}

test('directory failures and checkout failures differ from a completed lookup without a pickup offer',async()=>{
  for(const [read,status] of [[async()=>[], 'store_unconfirmed'],[async()=>{throw Error()},'source_failed']]) {
    const source={stores:read,local:assert.fail};
    const r=await compareOffers({store:'nearest',coordinates:origin,retailer:'paguemenos'},source,async()=>({products:[offer]}));
    assert.equal(r.status,status); assert.equal(r.products[0].pickupAtStore,'unconfirmed');
  }
  const source=fixedStoreSource('paguemenos',{stores:async()=>directory,basket:async()=>{throw Error()}},origin,'nearest');
  const items=await source.basket([{offer,quantity:1},{offer,quantity:1}],origin);
  assert.equal(items.length,1); assert.equal(items[0].requestedQuantity,2);
  assert.equal(items[0].pickupAtStore,'lookup_failed');
  assert.equal((await source.withStoreEvidence({items})).status,'source_failed');
});

test('explicit store, repeated items and seller-specific checkout must agree on the combined quantity',async()=>{
  let row = localQuote([pickup('paguemenos00008_abcd')]);
  const source=fixedStoreSource('paguemenos',{stores:async()=>directory,basket:async()=>[row]},origin,'8');
  const lines=[{offer,quantity:1},{offer,quantity:1}];
  assert.equal((await source.basket(lines,origin))[0].pickupAtStore,'offered');
  row.requestedQuantity=1;
  assert.equal((await source.basket(lines,origin))[0].pickupAtStore,'unconfirmed');
});

test('generic consent and clarification can precede any directory request',async()=>{
  const source=fixedStoreSource('paguemenos',{stores:assert.fail, local:assert.fail},origin,'nearest');
  const result=await quoteShoppingList('paguemenos',source,[{query:'Marca'}],origin,async()=>({kind:'brand'}));
  assert.equal(result.status,'needs_generic_preference');
  assert.equal((await source.withStoreEvidence(result)).fixedStore,undefined);
});

test('locator orders only active banner stores with measured distances and preserves published opening hours',async()=>{
  const base={bandeira:'PAGUE MENOS',status:'ATIVA'};
  const result=await stores(origin,async()=>Response.json({sortedStores:[
    {...base,cod_loja:3,distancia_usuario:''},{...base,cod_loja:4,bandeira:'EXTRAFARMA',distancia_usuario:0},
    {...base,cod_loja:9,status:'INATIVA',distancia_usuario:0.1},{...base,cod_loja:8,distancia_usuario:1.7},
    {...base,cod_loja:2,distancia_usuario:'0.2',seg_a_sex:'07:00 às 22:00',ddd:'81'},
  ]}));
  assert.deepEqual(result.map(s=>s.id),['2','8','3']); assert.equal(result[0].distanceKm,0.2);
  assert.equal(result[0].openingHours.weekdays,'07:00 às 22:00'); assert.equal(result[0].phone,null);
});

test('a fixed branch can offer pickup while its physical quantity remains unknown', async () => {
  let directoryReads = 0;
  const source = {
    stores: async () => { directoryReads++; return [{id:'4',storeName:'Loja A',distanceKm:0.3}]; },
    local: async () => ({...localQuote([pickup('paguemenos00004_abcd')]), requestedQuantity:1}),
  };
  const result = await compareOffers({query:'10', retailer:'paguemenos', store:'nearest', coordinates:origin},
    source, async () => ({status:'matches',products:[offer]}));
  assert.equal(directoryReads,1);
  assert.equal(result.products[0].pickupAtStore,'offered');
  assert.equal(result.products[0].closestStore.id,'4');
  assert.equal(result.products[0].branchQuantity,null);
  assert.equal(result.purchase.coverage.canExpand,false);
  assert.equal(result.purchase.stockEvidence,'no_branch_inventory_source');
});
