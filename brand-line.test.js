import assert from 'node:assert/strict';
import test from 'node:test';
import {matchesRequestedBrand} from './partner-plan.js';


test('an abbreviated manufacturer must identify one documented generic brand in the presentation', async()=>{
  const {selectBrandOptions}=await import('./partner-plan.js');
  const prati={name:'Paracetamol 750 mg Genérico Prati-Donaduzzi',brand:'Prati Donaduzzi',type:'Genérico',role:'requested'};
  const other={...prati,brand:'Acme',name:'Paracetamol Genérico Acme',role:'generic'};
  assert.deepEqual(selectBrandOptions([prati,other],'Prati',false).products,[prati]);
  assert.deepEqual(selectBrandOptions([prati,other],'Prati',true).products,[prati,other]);
  for (const p of [{...prati,name:'Paracetamol genérico de outro fabricante'},
      {...prati,type:'Não informado'},{...prati,brand:'Pratissimo Donaduzzi'}]) {
    assert.deepEqual(selectBrandOptions([p],'Prati',false).products,[]);
  }
  assert.deepEqual(selectBrandOptions([prati],'Prat',false).products,[]);
  const namesake={...prati,name:'Paracetamol genérico Prati Dois',brand:'Prati Dois'};
  const ambiguity=selectBrandOptions([prati,namesake],'Prati',false);
  assert.equal(ambiguity.needsBrandChoice,true); assert.deepEqual(ambiguity.products,[]);
});

test('a selection narrows the named catalog result and cannot substitute a different presentation',async()=>{
  const {quoteShoppingList}=await import('./partner-plan.js');
  const product=sku=>({sku,sellerId:'1',brand:'Exemplo',name:'Spray nasal Exemplo',currentPrice:5});
  const quoted=[];
  const source={search:async()=>[product('10'),product('20')],product:async sku=>[product(sku)],
    basket:async lines=>{quoted.push(...lines);return lines.map(({offer,quantity})=>({...offer,requestedQuantity:quantity,
      localStatus:'available',methods:[{channel:'pickup-in-point',pickupPointId:'local'}]}));}};
  const ask=sku=>quoteShoppingList('paguemenos',source,[{query:'Spray nasal Exemplo',sku,brand:'Exemplo',includeGenerics:false}],'01001000');
  const picked=await ask('20');
  assert.equal(picked.status,'fulfillable');
  assert.deepEqual(picked.tables[0].choices.map(p=>p.sku),['20']);
  const stale=await ask('30');
  assert.equal(stale.tables[0].status,'selected_presentation_unverified'); assert.deepEqual(stale.tables[0].choices,[]);
  assert.deepEqual(quoted.map(line=>line.offer.sku),['20']);
});

test('a previously selected pack retains its seller beyond the two initial hits', async () => {
  const {quoteShoppingList} = await import('./partner-plan.js');
  const products = Array.from({length:58}, (_, i) => ({
    sku:String(i+1), sellerId:'loja', name:'Spray nasal Exemplo '+(i+1)+' mL', brand:'Exemplo', currentPrice:4,
  }));
  const pages = [];
  const source = {
    search:async (query, page, limit) => {
      assert.equal(query, 'Spray nasal Exemplo');
      pages.push([page,limit]);
      return products.slice((page-1)*limit, page*limit);
    },
    product:async sku => products.filter(row => row.sku === sku),
    basket:async lines => lines.map(({offer,quantity}) => ({...offer,requestedQuantity:quantity,localStatus:'available',methods:[]})),
  };
  const result = await quoteShoppingList('drogariasaopaulo', source, [
    {query:'Spray nasal Exemplo', sku:'56', includeGenerics:false},
  ], '01001000');
  assert.equal(result.status,'fulfillable');
  assert.deepEqual(result.tables[0].verifiedChoices,[{sku:'56',sellerId:'loja'}]);
  assert.deepEqual(pages,[[1,2],[1,50],[2,50]]);
});

test('a shopper can say the brand and product line together',()=>{
  const p={brand:'Marca',name:'Solução fisiológica Marca Linha Plus 100 ml'};
  for(const name of ['Marca','Marca Linha','MÁRCA LINHA PLUS']) assert.equal(matchesRequestedBrand(p,name),true);
  for(const name of ['Mar','Linha Plus','Marca Linha Forte','Outra Marca']) assert.equal(matchesRequestedBrand(p,name),false);
  assert.equal(matchesRequestedBrand({...p,brand:'Outra'},'Marca Linha'),false);
});
