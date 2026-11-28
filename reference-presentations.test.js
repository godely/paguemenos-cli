import test from 'node:test';
import assert from 'node:assert/strict';
import { quoteShoppingList } from './partner-plan.js';
import { run } from './runner.js';

const origin = {latitude:0,longitude:0};
const names = ['Exemplo 1 mg 30 comprimidos','Exemplo 2 mg 30 comprimidos'];
const genericName = 'Substância Exemplo 2 mg 30 comprimidos Genérico';
const genericCode = '7896004703398';

function referenceCatalog(t) {
  const pack = (name,sku,strength,brand,eanCode) => ({
    name,sku,brand,eanCode,price:75, filters:{'Forma farmacêutica':'Comprimido'},
    details:{quantidade:'30 comprimidos', dosageList:[strength+'MG'],
      activeIngredients:[{description:'Substância Exemplo',dosageValue:strength,unitOfMeasurement:{name:'mg'}}]},
  });
  const brands = names.map((name,i) => pack(name,String(i+1),i+1,'Exemplo'));
  const generic = pack(genericName,'3',2,'Laboratório',genericCode);
  t.mock.method(globalThis,'fetch',async (_url,init) => {
    const {requests} = JSON.parse(init.body);
    assert.ok(requests,'Clarification must not consult Drogasil fulfillment');
    const req = requests[0];
    if (req.facets) return Response.json({results:[{facets:{'filters.Marca':{Exemplo:2},
      'details.activeIngredients.description':{'Substância Exemplo':3}}}]});
    const hits = req.filters?.includes('filters.Marca') ? brands : [...brands,generic];
    return Response.json({results:[{hits,nbHits:hits.length,nbPages:1}]});
  });
}

test('both retailers clarify a missing brand, then quote only the locally verified chosen pack', async t => {
  referenceCatalog(t);
  const local = {name:genericName,gtin:genericCode,sku:'42',sellerId:'1',currentPrice:9};
  const item = {query:'Exemplo',quantity:2,includeGenerics:true};
  for (const retailer of ['paguemenos','drogariasaopaulo']) {
    const lookups = [], quotes = [];
    const source = {
      search:async () => [],
      byGtin:async code => { lookups.push(code); return [local,{...local,sku:'99',name:'Substância Exemplo XR 2 mg 30 comprimidos'}]; },
      local:async (row,point,n) => {
        quotes.push([row.sku,point,n]);
        return {...row,localStatus:'available',requestedQuantity:n,methods:[{channel:'pickup-in-point',pickupPointId:'loja'}]};
      },
    };
    const broad = await quoteShoppingList(retailer,source,[item],origin);
    const fixed = await quoteShoppingList(retailer,source,[item],origin,undefined,{store:'nearest'});
    for (const table of [broad.tables[0],fixed.tables[0],fixed.checkout.tables[0]]) {
      assert.equal(table.referenceCatalog,'drogasil');
      assert.deepEqual(table.presentationChoices,names);
      assert.deepEqual(table.choices ?? table.rows,[]);
    }
    assert.deepEqual(broad.tables[0].verifiedChoices,[]);
    assert.deepEqual(lookups,[]);
    assert.deepEqual(quotes,[]);
    const selected = await quoteShoppingList(retailer,source,[{...item,query:names[1]}],origin);
    assert.equal(selected.status,'fulfillable');
    assert.deepEqual(lookups,[genericCode]);
    assert.deepEqual(quotes,[['42',origin,2]]);
    assert.deepEqual(selected.products.map(p=>[p.name,p.currentPrice,p.branchQuantity]),[[genericName,9,null]]);
  }
});

test('partner CLI compare and plan show reference names and return the clarification exit code', async t => {
  referenceCatalog(t);
  const log = t.mock.method(console,'log',()=>{});
  const previousCode = process.exitCode;
  t.after(()=>{process.exitCode=previousCode;});
  for (const retailer of ['paguemenos','drogariasaopaulo']) {
    for (const args of [['compare','Exemplo'],['plan','Exemplo','--include-generics','A','--lat','0','--lon','0']]) {
      log.mock.resetCalls();
      await run({search:async()=>[]},args,retailer,{choicesFor:async()=>[]});
      const text = log.mock.calls.flatMap(c=>c.arguments).join('\n');
      assert.equal(process.exitCode,3);
      for (const name of names) assert.ok(text.includes(name),text);
      assert.match(text,/catálogo de referência da Drogasil/);
      assert.doesNotMatch(text,/R\$|75,00|choose_reference/);
    }
  }
});
