import test from 'node:test';
import assert from 'node:assert/strict';
import {run} from './runner.js';
import {crossRetailerPlans, describePlanDifference, describePickupStop} from './pickup-plans.js';

const method = id=>({channel:'pickup-in-point',pickupPointId:id,branch:id,distanceKm:1});

test('adding a chain preserves a confirmed basket and permits a split when a partner has physical stock', async () => {
  const items = [{query:'Primeiro'},{query:'Segundo'}];
  const quote = {sku:'20',name:'Segundo',localStatus:'available',requestedQuantity:1,currentPrice:5,
    methods:[method('paguemenos00001_xyz')]};
  const offers = {retailerId:'paguemenos',tables:[{status:'no_reference'}, {status:'matches',choices:[quote]}]};
  const store = {id:'1',name:'Filial DSP',quantity:1,distanceKm:0.4};
  const product = {sku:'20',name:'Primeiro',store,referencePriceBRL:7};
  const inventory = {retailerId:'drogariasaopaulo',stockEvidence:'retailer_branch_snapshot',
    tables:[{rows:[product]}, {rows:[]}], checkout:{retailerId:'drogariasaopaulo',tables:[]}};
  const single = {retailerId:'paguemenos',planningScope:'one_pack_alternatives',products:[quote]};
  const subset = async (id,indices) => {
    assert.equal(id,'paguemenos'); assert.deepEqual(indices,[1]); return single;
  };
  const alone = await crossRetailerPlans([single],[items[1]],assert.fail);
  assert.equal(alone.plans[0].totalBRL,5);
  const combined = await crossRetailerPlans([offers,inventory],items,subset);
  const [plan] = combined.plans;
  assert.equal(plan.totalBRL,12);
  assert.equal(plan.stopCount,2);
  const picks = Object.fromEntries(plan.stops.map(s => [s.retailerId,s.pickups[0]]));
  assert.equal(picks.drogariasaopaulo.evidence,'reported_branch_stock');
  assert.equal(picks.drogariasaopaulo.reportedStock,1);
  assert.equal(picks.paguemenos.evidence,'quoted_pickup');
  assert.equal(picks.paguemenos.reportedStock,null);
  const repeated = {...inventory,tables:[{rows:[product]}, {rows:[product]}]};
  const short = await crossRetailerPlans([repeated],items,assert.fail);
  assert.equal(short.plans.length,0);
});
for (const id of ['paguemenos','drogariasaopaulo']) {
  test(id+' CLI shows a jointly quoted stop and a cheaper two-stop option',async t=>{
    const source={
      search:async name=>[{sku:name==='Produto A'?'11':'22'}],
      product:async sku=>[{sku,sellerId:'1',name:sku==='11'?'Produto A':'Produto B'}],
      basket:async rows=>rows.map(({offer,quantity})=>({
        ...offer,requestedQuantity:quantity,localStatus:'available',
        currentPrice:rows.length===2?8:4,methods:[method(rows.length===2?'Centro':offer.name)],
      })),
    };
    const out=t.mock.method(console,'log',()=>{});
    const args=['plan','Produto A','Produto B','--brand-only','A','--brand-only','B','--lat','-12','--lon','-44'];
    await run(source,[...args,'--json'],id);
    const {pickupPlans}=JSON.parse(out.mock.calls[0].arguments[0]);
    assert.deepEqual(pickupPlans.plans.map(p=>[p.stopCount,p.totalBRL]),[[1,16],[2,8]]);
    assert.equal(pickupPlans.comparison.savingsBRL,8);
    assert.ok(pickupPlans.plans.every(p=>p.stops.every(s=>s.retailerId===id && s.pickups.every(i=>i.reportedStock===null))));
    await run(source,args,id);
    assert.match(out.mock.calls.slice(1).map(c=>c.arguments[0]).join('\n'),/Menos lojas[\s\S]+Menor preço estimado[\s\S]+Economia/);
  });
}

test('checks exact combinations of eligible products with their sellers and checkout prices',async()=>{
  const lines=[{query:'A'},{query:'B',quantity:2}];
  const choices=[['11','12'],['21','22']].map(skus=>skus.map(sku=>({sku,sellerId:'shop'})));
  const tables=choices.map(rows=>({status:'matches',choices:rows,verifiedChoices:rows}));
  const result={retailerId:'paguemenos',status:'choose_products',tables};
  const checked=[];
  const quote=(p,idx,branch,price)=>({...p,requestedQuantity:lines[idx].quantity??1,currentPrice:price,
    methods:[method(branch)],localStatus:'available'});
  const plans=await crossRetailerPlans([result],lines,async(id,indices,fixed)=>{
    assert.equal(id,'paguemenos');
    if (!fixed) {
      const [i]=indices;
      return {planningScope:'one_pack_alternatives',products:[quote(choices[i][0],i,'near'+i,2)]};
    }
    checked.push(fixed.map(p=>p.selectedSku).join(','));
    assert.ok(fixed.every(p=>p.sellerId==='shop'));
    if (checked.at(-1)!=='12,22') return {items:[]};
    return {items:fixed.map((p,i)=>quote({sku:p.selectedSku,sellerId:p.sellerId},i,'shared',4)),
      commonPickupPoints:[{id:'shared'}]};
  });
  assert.equal(checked.length,4);
  assert.deepEqual(plans.plans.map(p=>[p.stopCount,p.totalBRL]),[[1,12],[2,6]]);
  assert.deepEqual(plans.plans[0].stops[0].pickups.map(p=>p.sku),['12','22']);
});

test('shopper tradeoff distinguishes longer, shorter, equal and unknown round trips', () => {
  const describe = (extraKm, extraStops=1) => describePlanDifference({savingsBRL:8.4,extraStops,extraKm});
  assert.match(describe(1.2), /8,40.*1 parada a mais.*1,2 km a mais.*linha reta/);
  assert.match(describe(-0.24, 2), /2 paradas a mais.*240 m a menos/);
  assert.match(describe(0, 0), /mesmo número de paradas.*mesma distância/);
  assert.match(describe(null), /diferença de distância a confirmar/);
});

test('pickup stop keeps a branch name and its address without duplicating a street in the name', () => {
  const address={street:'Rua da Pracinha',number:7};
  assert.equal(describePickupStop({name:'Filial Praça -',address}),'Filial Praça — Rua da Pracinha, 7');
  const name='Pague Menos - Rua da Pracinha, 7 (Loja 1)';
  assert.equal(describePickupStop({name,address}),name);
  assert.equal(describePickupStop({name:'Loja da Praça'}),'Loja da Praça');
  assert.equal(describePickupStop({address:{addressLocal:'Avenida Um',addressNumber:'2'}}),'Avenida Um, 2');
  assert.match(describePickupStop({name:'Rua da Pracinha 71',address}), /71 — Rua da Pracinha, 7$/);
});

test('partial routes maximize filled lines and compare only identical subsets', async () => {
  const rows = (id, price, quantity=2) => [{sku:'x',name:'Opção',referencePriceBRL:price,
    store:{id,name:id,quantity,distanceKm:1}}];
  const stock = (...rows) => ({retailerId:'drogasil',tables:rows.map(rows=>({rows}))});
  const lines = ['Ausente','Segundo','Terceiro'].map(query=>({query}));
  const partner = {retailerId:'paguemenos',tables:[{status:'no_match'},{status:'no_match'},{status:'choose_reference'}]};
  const result = await crossRetailerPlans([stock([],rows('one',9),[...rows('one',9),...rows('two',2)]),partner],lines,assert.fail);
  const partial = result.partialBasket;
  assert.equal(result.plans.length,0);
  assert.deepEqual([partial.filledCount,partial.requestedCount],[2,3]);
  assert.deepEqual(partial.plans.map(p=>[p.stopCount,p.totalBRL]),[[1,18],[2,11]]);
  assert.equal(partial.comparison.savingsBRL,7);
  assert.deepEqual(partial.plans[0].unfilled[0],{item:0,name:'Ausente',outcomes:[
    {retailerId:'drogasil',reason:'pickup_unknown'},{retailerId:'paguemenos',reason:'catalog_miss'}]});

  // Observations for the same box disagree. Both orderings must honor the lower count.
  for(const reversed of [false,true]) {
    const tables=[rows('only',8,1),rows('only',3,5)];
    if(reversed) tables.reverse();
    const r=await crossRetailerPlans([stock(...tables)],lines.slice(0,2),assert.fail);
    assert.equal(r.partialBasket.filledCount,1);
    assert.equal(r.partialBasket.plans[0].unfilled[0].outcomes[0].reason,'joint_unconfirmed');
  }
  const unpriced=await crossRetailerPlans([stock([],rows('one',null),rows('two',7))],lines,assert.fail);
  assert.equal(unpriced.partialBasket.filledCount,2);
  assert.deepEqual(unpriced.partialBasket.plans.map(p=>p.totalBRL),[null]);
});

test('same size incompatible partial baskets have no advertised savings',async()=>{
  const quote=(i,price,stop)=>({sku:String(i),name:'Opção '+i,requestedQuantity:1,currentPrice:price,
    localStatus:'available',methods:[method(stop)]});
  const retailer={retailerId:'paguemenos',tables:Array.from({length:3},()=>({status:'matches',choices:[{}]}))};
  const result=await crossRetailerPlans([retailer],['A','B','C'].map(query=>({query})),async(_,indices)=>{
    if(indices.length===1) {
      const [i]=indices;
      return {planningScope:'one_pack_alternatives',products:[quote(i,i===0?12:2,i===1?'Y':'X')]};
    }
    if(indices.join(',')==='0,1') return {items:indices.map(i=>quote(i,10,'X')),commonPickupPoints:[{id:'X'}]};
    return {items:[]};
  });
  assert.equal(result.partialBasket.filledCount,2);
  assert.deepEqual(result.partialBasket.plans.map(p=>[p.unfilled[0].item,p.totalBRL,p.stopCount]),[[2,20,1],[0,4,2]]);
  assert.equal(result.partialBasket.comparison,null);
});

test('a failed source, absent pack and delivery-only quote keep distinct pending reasons',async()=>{
  const result=await crossRetailerPlans([
    {retailerId:'drogasil',status:'source_failed'},
    {retailerId:'paguemenos',tables:[{status:'no_match'},{status:'matches',choices:[{}]}]},
  ],[{query:'123456'},{query:'Segundo'}],async()=>({items:[{localStatus:'available',requestedQuantity:1,
    methods:[{channel:'delivery'}]}]}));
  const partial=result.partialBasket;
  assert.equal(partial.filledCount,0);
  assert.deepEqual(partial.plans,[]);
  assert.equal(partial.unfilled[0].name,'Item 1');
  assert.deepEqual(partial.unfilled.map(l=>l.outcomes.map(o=>o.reason)),[
    ['lookup_failed','catalog_miss'],['lookup_failed','pickup_not_offered']]);
});

for (const retailer of ['paguemenos','drogariasaopaulo']) {
  test(retailer+' CLI prints a partial trip, pending presentation and partial exit code',async t=>{
    const source={
      search:async name=>name==='Produto A'?[{sku:'11'}]:[],
      product:async()=>[{sku:'11',sellerId:'1',name:'Produto A'}],
      local:async product=>({...product,requestedQuantity:1,localStatus:'available',currentPrice:4,methods:[method('Centro')]}),
      basket:async rows=>rows.map(({offer,quantity})=>({...offer,requestedQuantity:quantity,
        localStatus:'available',currentPrice:4,methods:[method('Centro')]})),
    };
    const out=t.mock.method(console,'log',()=>{});
    const old=process.exitCode;
    try {
      await run(source,['plan','Produto A','Produto B','--brand-only','A','--brand-only','B','--lat','-12','--lon','-44'],retailer,
        {choicesFor:async()=>[]});
      assert.equal(process.exitCode,3);
      assert.match(out.mock.calls.map(c=>c.arguments[0]).join('\n'),/1 de 2[\s\S]+Centro[\s\S]+Produto A[\s\S]+Pendente: Produto B/);
    } finally {process.exitCode=old;}
  });
}
