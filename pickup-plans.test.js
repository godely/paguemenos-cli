import test from 'node:test';
import assert from 'node:assert/strict';
import {run} from './runner.js';
import {crossRetailerPlans} from './pickup-plans.js';

const method = id=>({channel:'pickup-in-point',pickupPointId:id,branch:id,distanceKm:1});
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
