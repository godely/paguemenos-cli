import assert from 'node:assert/strict';
import test from 'node:test';
import { retailerComparison, medicationCard } from 'drogasil-cli/retailer-workflows';
import { compositionEvidence } from './composition.js';
import { createRetailer } from './vtex.js';
import { prepareSearch, searchVerifiedCatalog } from './search.js';
import { selectBrandOptions } from './partner-plan.js';

const name = 'Paracetamol 750mg 10 Comprimidos';
const item = {itemId:'15',name,nameComplete:name,sellers:[{sellerId:'1',commertialOffer:{}}]};
const product = {brand:'Paracetamol', items:[item], link:'https://example.org/paracetamol-20-comprimidos',
  allSpecifications:['Fabricante','Quantidade','Dosagem','Apresentação','Generico'],
  Fabricante:['Medquímica'],Quantidade:['10un'],Dosagem:['750MG'],Apresentação:['Comprimido'],Generico:['Sim'],
  description:'<h2>Composição do Paracetamol:</h2><strong>Princípio ativo:</strong> <a>paracetamol</a> 750mg<br/><strong>Excipientes:</strong> amido<h2>Indicações</h2>outra substância'};

test('composition fallback requires an explicit single active, one variant and a matching strength', () => {
  assert.deepEqual(compositionEvidence(product,item,{}).activeIngredients,['paracetamol']);
  for (const changes of [{items:[item,item]}, {description:product.description.replace('Composição','Indicações')},
    {description:product.description.replace('750mg','750mg + cafeína 65mg')},
    {description:product.description.replace('750mg','750mg<br>e cafeína')},
    {description:product.description.replace('750mg','500mg')}, {description:product.description.replace('paracetamol</a>','inventado</a>')}]) {
    assert.deepEqual(compositionEvidence({...product,...changes},item,{}),{});
  }
  assert.deepEqual(compositionEvidence(product,item,{NomeSubstanciaPrincipioAtivo:['Outro']}),{});
});

test('fact lookup, verified search, comparison and a shopping preference agree on this pack', async () => {
  const other = {...product, Fabricante:['Outro'], items:[{...item,itemId:'16'}]};
  const retailer = createRetailer({name:'Pague Menos',site:'https://example.org',prepareSearch,compositionEvidence},
    async url=>Response.json(url.searchParams.has('fq') ? [product] : [product,other]));
  const [raw] = await retailer.facts('15');
  const card = medicationCard(raw);
  assert.deepEqual([card.activeIngredients,card.ingredientEvidence.source,card.manufacturer],[['paracetamol'],'retailer_composition','Medquímica']);
  for (const suffix of ['Medquímica 750 mg 10 comprimidos','da Medquímica, 750 mg, caixa de 10 comprimidos',
    '750 mg 10 comprimidos da Medquímica','Medquímica 750 mg 20 comprimidos','Medquímica 500 mg 10 comprimidos']) {
    const query = 'paracetamol '+suffix;
    const resolve = async()=>({kind:'ingredient',name:'paracetamol',suffix});
    const expected = suffix.includes('20 comprimidos') || suffix.includes('500 mg') ? [] : ['15'];
    const search = await searchVerifiedCatalog(retailer,query,1,10,resolve);
    assert.deepEqual(search.map(p=>p.sku),expected,query);
    const result = await retailerComparison({retailer:'paguemenos',query,includeGenerics:false},retailer,{resolve});
    assert.deepEqual(result.products.map(p=>p.sku),expected,query);
  }
  const result = await retailerComparison({retailer:'paguemenos',query:'paracetamol 750 mg 10 comprimidos'},
    retailer,{resolve:async()=>({kind:'ingredient',name:'paracetamol',suffix:'750 mg 10 comprimidos'})});
  assert.deepEqual(selectBrandOptions(result.products,'Medquímica',false).products.map(p=>p.sku),['15']);
});

test('a complete active ingredient line can end at the next section without listing excipients', () => {
  const title = 'Cloridrato de Tansulosina 0,4mg Liberação Prolongada 30 Cápsulas Duras';
  const variant = {...item, name:title, nameComplete:title};
  const section = '<h2>Composição:</h2><p><strong>Princípio ativo:</strong> cloridrato de tansulosina 0,4mg</p>';
  const make = description => compositionEvidence({...product,items:[variant],description},variant,{});
  const found = make(section+'<h2>Para que serve?</h2><p>Outro nome</p>');
  assert.deepEqual(found.activeIngredients,['cloridrato de tansulosina']);
  assert.equal(found.ingredientEvidence.source,'retailer_composition');
  for (const rest of [' e outro ativo', ' + outra substância 1mg', '<p>Princípio ativo: Outro</p>'])
    assert.deepEqual(make(section+rest),{});
});
