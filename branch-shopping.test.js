import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { physicalShopping } from './branch-shopping.js';
import { compareOffers } from './compare.js';

const retailer='paguemenos', origin={latitude:-10,longitude:-40};
const store=i=>({id:String(i),storeName:'Loja '+i,distanceKm:i/2,phone:'11 999998888',
  address:{latitude:-10,longitude:-40+i*0.004,street:'Rua '+i}});
const drug=(sku,name,price,role='requested')=>({sku,name,role,currentPrice:price,seller:'Farmácias Pague Menos',type:role==='generic'?'Genérico':'Referência'});
const one=drug('101','Brand A',10), alt=drug('102','Generic A',3,'generic'), two=drug('201','Brand B',8);
const items=[{query:'Brand A',includeGenerics:true,quantity:1},{query:'201',quantity:1}];
const match=products=>({status:'matches',products});
async function snapshot(t,rows) {
  const dir=await mkdtemp(join(tmpdir(),'branch-plan-')); t.after(()=>rm(dir,{recursive:true,force:true}));
  const database=join(dir,'stock.db'),time=new Date(Date.now()-120000).toISOString(),csv=join(dir,'data.csv');
  await writeFile(csv,['retailer,id,store_code,quantity,timestamp',...rows.map(r=>[retailer,...r,time].join(','))].join('\n'));
  execFileSync('python3',['branch_inventory.py','import','--database',database,'--retailer',retailer,'--snapshot-at',time,csv]);
  return {database,maxAgeMs:3600000};
}

test('compact rows, fixed-store zero, hidden joint stop and cheaper two-stop plan',async t=>{
  const config=await snapshot(t,[['101',1,0],['101',2,0],['101',3,2],['102',1,1],['102',2,0],['102',3,0],
    ['201',1,0],['201',2,3],['201',3,2]]);
  let calls=0;
  const source={stores:async()=>{calls++;return [store(3),store(2),store(1)];}};
  const matches=[match([alt,one]),match([two])];
  const plan=await physicalShopping(retailer,source,items,matches,origin,{},config);
  assert.equal(calls,1);
  assert.deepEqual(plan.tables[0].rows.map(r=>[r.option,r.sku,r.store.id]),[['A1','101','3'],['A2','102','1']]);
  assert.equal(plan.tables[1].rows[0].store.id,'2');
  assert.deepEqual(plan.plans.map(p=>[p.objective,p.stopCount,p.totalBRL]),[['fewest_stores',1,18],['lowest_price',2,11]]);
  assert.equal(plan.plans[0].stops[0].id,'3');assert.equal(plan.tradeoff.savingsBRL,7);
  assert.equal(plan.tradeoff.extraStops,1);assert.ok(plan.plans.every(p=>Number.isFinite(p.roundTripKm)));
  const fixed=await physicalShopping(retailer,source,items,matches,origin,{store:'nearest'},config);
  assert.equal(fixed.fixedBranchId,'1');
  assert.deepEqual(fixed.tables[0].rows.map(r=>r.store.quantity),[0,1]);
  assert.equal(fixed.tables[1].rows[0].store.quantity,0);
  assert.ok(fixed.plans.every(p=>p.stops.every(b=>b.id==='1')));
  const repeat=await physicalShopping(retailer,source,[{query:'102'},{query:'102'}],[match([alt]),match([alt])],origin,{},config);
  assert.equal(repeat.status,'partial');assert.equal(repeat.plans[0].unfilled.length,1);
});

test('no configured feed still identifies the fixed branch, preserves a catalog price and never invents counts',async()=>{
  const source={stores:async()=>[store(2),store(1)]};
  const result=await compareOffers({retailer,query:'101',store:'nearest',coordinates:origin},source,async()=>match([one]));
  assert.equal(result.purchase.fixedBranchId,'1');assert.equal(result.products[0].closestStore.id,'1');
  assert.equal(result.products[0].branchQuantity,null);
  assert.equal(result.purchase.tables[0].rows[0].referencePriceBRL,10);
  assert.equal(result.purchase.stockIncomplete,true);
  assert.equal(result.purchase.coverage.canExpand,false);
  assert.equal(result.purchase.tables[0].unknown[0].sku,'101');
  const missingDistance=await physicalShopping(retailer,{stores:async()=>[store(1),{...store(2),distanceKm:null}]},
    [items[0]],[match([one])],origin,{store:'nearest'},null);
  assert.equal(missingDistance.fixedBranchId,undefined);
  assert.equal(missingDistance.tables[0].rows[0].store,null);
});

test('expansion requires affirmative opt-in and fresh zeros for every option; all expanded stores can fill a basket',async t=>{
  const directory=Array.from({length:52},(_,i)=>store(i+1));
  const rows=directory.flatMap(({id})=>[['101',id,Number(id)>30?1:0],['201',id,id==='45'?1:0],['102',id,id==='3'?1:0]]);
  const config=await snapshot(t,rows);
  const source={stores:async()=>directory};
  const lines=[match([one]),match([two])];
  const nearby=await physicalShopping(retailer,source,items,lines,origin,{},config);
  assert.equal(nearby.coverage.checkedStores,30);assert.equal(nearby.coverage.canExpand,true);assert.equal(nearby.expandedSearch,undefined);
  const wider=await physicalShopping(retailer,source,items,lines,origin,{expandSearch:true},config);
  assert.equal(wider.expandedSearch.checkedStores,50);assert.equal(wider.expandedSearch.stores.length,10);
  assert.equal(wider.expandedSearch.stores[0].id,'31');assert.equal(wider.plans[0].stops[0].id,'45');
  assert.equal(wider.plans[0].stopCount,1);assert.equal(wider.plans[0].totalBRL,18);
  const nearMatch=await physicalShopping(retailer,source,items,[match([one,alt]),match([two])],origin,{expandSearch:true},config);
  assert.equal(nearMatch.expandedSearch,undefined);
  const missing=await physicalShopping(retailer,source,items,[match([one]),match([{...two,sku:'222'}])],origin,{expandSearch:true},config);
  assert.equal(missing.expandedSearch,undefined);assert.equal(missing.coverage.stockUnknown,true);
});

test('third-party prices cannot set a branch total, and an inaccessible stock file is an error',async t=>{
  const config=await snapshot(t,[['101',1,1],['201',1,1]]);
  const source={stores:async()=>[store(1)]};
  const selections=[match([{...one,seller:'Marketplace'}]),match([two])];
  const plan=await physicalShopping(retailer,source,items,selections,origin,{},config);
  assert.equal(plan.priceIncomplete,true);assert.equal(plan.plans[0].totalBRL,null);
  const broken=await physicalShopping(retailer,source,items,selections,origin,{store:'nearest'},{...config,database:config.database+'-missing'});
  assert.equal(broken.stockEvidence,'branch_inventory_lookup_failed');
  assert.equal(broken.tables[0].failed[0].sku,'101');
});
