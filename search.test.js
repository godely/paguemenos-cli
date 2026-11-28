import test from 'node:test';
import assert from 'node:assert/strict';
import { createRetailer } from './vtex.js';
import { prepareSearch, suggest } from './search.js';
import { run } from './runner.js';

const site = 'https://example.com';
const seller = { sellerId: '1', commertialOffer: {} };
test('sublingual suggestions retrieve the brand and verify the individual pack', () => {
  const {text, matches} = prepareSearch('Rivotril sublingual 0,25 mg');
  assert.equal(text,'Rivotril');
  const row = {name:'Rivotril 0,25 mg 30 comprimidos',facts:{'Via de Administração':['Via oral','Sublingual']}};
  assert.equal(matches(row),false);
  assert.equal(matches({...row,name:row.name+' sublinguais'}),true);
  assert.equal(matches({...row,name:'Rivotril 2 mg 30 comprimidos sublinguais'}),false);
});
function product(id, name, ingredient) {
  return {
    allSpecifications: ['NomeSubstanciaPrincipioAtivo'], NomeSubstanciaPrincipioAtivo: [ingredient],
    description: 'A descrição menciona morfina.',
    items: [{ itemId: String(id), name, sellers: [seller] }],
  };
}

test('suggest uses public query completions, deduplicates doses and ignores product previews', async () => {
  const terms = await suggest(site, 'morfi', 7, async (url, options) => {
    if (url.pathname.endsWith('/product-search')) return Response.json({products:[]});
    assert.equal(url.pathname, '/api/intelligent-search/v1/autocomplete-suggestions');
    assert.equal(url.searchParams.get('query'), 'morfi');
    assert.equal(options.headers, undefined);
    return Response.json({ searches: [{ term: 'morfina' }, { term: 'morfina 10mg' },
      { term: 'Morfina 10 mg' }, { term: 'naltrexona' }, { term: null }],
    products: [{ name: 'Revia', description: 'morfina' }] });
  });
  assert.deepEqual(terms, ['morfina', 'morfina 10mg']);
  await assert.rejects(suggest(site, 'morfi', 7, async () => Response.json({})), /Unexpected/);
});

test('verified search paginates matched products and keeps matching sellers and SKU variants', async () => {
  const first = product(10, 'Dimorf 10mg 50 comprimidos', 'Sulfato de morfina');
  const firstItem = first.items[0];
  firstItem.sellers.push({ ...seller, sellerId: '2' });
  first.items.push({ ...firstItem, itemId: '11', name: 'Dimorf 30mg 50 comprimidos' });
  const last = product(20, 'Genérico 10 mg', 'MORFINA');
  const products = Array.from({ length: 49 }, (_, i) => product(i + 100, 'Revia', 'Naltrexona'));
  products.push(first, product(30, 'Restiva 10mg', 'Buprenorfina'), last);
  const starts = [];
  const retailer = createRetailer({ name: 'Pague Menos', site, prepareSearch }, async url => {
    assert.equal(url.searchParams.get('ft'), 'morfina');
    const start = Number(url.searchParams.get('_from'));
    starts.push(start);
    return Response.json(products.slice(start, start + 50), { headers: { resources: start + '-' + (start + 49) + '/52' } });
  });
  const a = await retailer.search('morfina 10 mg', 1, 1);
  assert.deepEqual(a.map(row => [row.sku, row.sellerId]), [['10', '1'], ['10', '2']]);
  assert.deepEqual(starts, [0]);
  assert.deepEqual((await retailer.search('morfina 10 mg', 2, 1)).map(row => row.sku), ['20']);
  assert.deepEqual(starts, [0, 0, 50]);
  assert.deepEqual(await retailer.search('morfina 10 mg', 3, 1), []);
});

test('accepts retailer-backed typing errors, prefers the bare name and keeps explicit qualifiers', async () => {
  const terms = (...names) => async url => Response.json(url.pathname.endsWith('/product-search')
    ? {products:[]} : {searches: names.map(term => ({term}))});
  assert.deepEqual(await suggest(site, 'rivtoril', 1, terms('Rivotril 2mg', 'Rivotril')), ['Rivotril']);
  assert.deepEqual(await suggest(site, 'morfian 10 mg', 7,
    terms('morfina', 'morfina 10mg/mL', 'morfina 10mg', 'morfina 30mg')), ['morfina 10mg']);
  assert.deepEqual(await suggest(site, 'frnotal xr', 7, terms('Frontal', 'Frontal XR')), ['Frontal XR']);
  assert.deepEqual(await suggest(site, 'zzqvzz', 7, terms('vitamina', 'dipirona')), []);
});

test('matches whole identity tokens and explicit strengths, resisting mention-only and lookalike results', () => {
  function match(query, name, ingredient, dosage, brand) {
    return prepareSearch(query).matches({ name, brand, facts: { NomeSubstanciaPrincipioAtivo: [ingredient],
      Dosagem: [dosage], Indicações: ['morfina'], 'Classe do Medicamento': ['morfina'] } });
  }
  assert.equal(match('morfi', 'Dimorf', 'Morfina'), false);
  assert.equal(match('morfina', 'Elixir Paregórico', 'Benzoico Acido, Canfora, Opio'), false);
  assert.equal(match('morfina', 'Hidromorfina', 'Hidromorfina'), false);
  assert.equal(match('Frontal', 'Termômetro frontal digital', ''), false);
  assert.equal(match('Revía', 'Outra grafia', 'Naltrexona', '', 'Revia'), true);
  assert.equal(match('morfina 10 mg', 'Dimorf 110 mg', 'Morfina'), false);
  assert.equal(match('morfina 10 mg', 'Dimorf 10mg/mL', 'Morfina', '10mg'), false);
  assert.equal(match('morfina 10 mg/mL', 'Dimorf 10mg/mL', 'Morfina'), true);
  assert.equal(match('morfina 10mg', 'Combinação 10mg + 5mg', 'Outro + Morfina'), false);
  assert.equal(match('morfina 10 mg', 'Morfina 10mg + X 5mg', 'Morfina + X'), true);
  assert.equal(match('morfina 10 mg', 'Dimorf', 'Morfina', '10MG'), true);
});

test('CLI asks before any product search and preserves JSON rows on every page', async t => {
  const printed = t.mock.method(console, 'log', () => {});
  const hints = t.mock.method(console, 'error', () => {});
  const originalCode = process.exitCode;
  t.after(() => { process.exitCode = originalCode; });
  const queries = [];
  const retailer = { search: async text => { queries.push(text); return []; },
    suggest: t.mock.fn(async () => ['morfina', 'morfina 10mg']) };
  const names = {choicesFor:async () => ['morfina']};
  await run(retailer, ['search', 'morfi', '--json'], 'paguemenos', names);
  assert.deepEqual(queries, []);
  assert.equal(printed.mock.calls[0].arguments[0], '[]');
  assert.equal(hints.mock.calls[0].arguments[0], 'Você quis dizer morfina?');
  assert.equal(process.exitCode, 3);
  await run(retailer, ['search', 'morfi', '--page', '2', '--json'], 'paguemenos', names);
  assert.equal(retailer.suggest.mock.callCount(), 0);
  await run(retailer, ['suggest', 'morfi', '--json'], 'paguemenos');
  assert.deepEqual(JSON.parse(printed.mock.calls.at(-1).arguments[0]), ['morfina', 'morfina 10mg']);
});

test('prefers catalog-backed names over query fragments or popular unrelated product cards', async () => {
  const fetchFixture = async url => Response.json(url.pathname.endsWith('/product-search') ? {products:[
    {brand:'Outra', productName:'Outro produto', description:'paracetamol'},
    {brand:'Paracetamol', productName:'Paracetamol 750mg', categories:['/Medicamentos e Saúde/']},
  ]} : {searches:[{term:'paraceta',count:80},{term:'paracetamol infantil',count:60}]});
  assert.equal((await suggest(site,'paracet',1,fetchFixture))[0], 'paracetamol');
  assert.equal((await suggest(site,'parassettamol',1,fetchFixture))[0], 'paracetamol');
  assert.deepEqual(await suggest(site,'zzxqvbrt',7,fetchFixture), []);
});

test('a cosmetic kit cannot outrank a medication spelling suggested by the storefront', async () => {
  const request = async url => Response.json(url.pathname.endsWith('/product-search')
    ? {products:[{productName:'Rotina de skincare', categories:['/Dermo e Beleza/']}]}
    : {searches:[{term:'morfina', count:167}]});
  assert.deepEqual(await suggest(site,'mrofina',7,request), ['morfina']);
});

test('standalone catalog checks Pague Menos ingredient evidence before exposing a result', async () => {
  const {searchVerifiedCatalog} = await import('./search.js');
  const row = (name, active) => ({name, facts:{NomeSubstanciaPrincipioAtivo:active}});
  const source = {search:async () => [
    row('Prednisona 20mg',['Antimicrobiano']), row('Prednisona 5mg',['Prednisolona']),
    row('Outro produto',['Antimicrobiano; Prednisona']), row('Prednisolona',[]),
  ]};
  const result = await searchVerifiedCatalog(source, 'prednisona', 1, 8, async () => ({
    kind:'ingredient',name:'prednisona',suffix:'',
  }));
  assert.deepEqual(result.map(hit=>hit.name),['Prednisona 20mg','Outro produto']);
  assert.deepEqual(result.map(hit=>hit.ingredientEvidence.source),['retailer_title','retailer_field']);
});

for (const retailer of ['paguemenos','drogariasaopaulo']) {
  test(retailer+' info prints the full presentation and distinguishes missing and conflicting evidence', async t => {
    const source = {facts:async query => query === 'Ausente' ? [] : [{
      sku:'1', name:'Marca 2 mg 20 comprimidos', type:'Referência', productUrl:'https://example.test/ficha',
      facts:{Fabricante:['Fabricante X'], 'Princípio Ativo':['Substância X'], 'Via de Administração':['Oral','Tópica'],
        'Tipo de Liberação':['Prolongada'], 'Tipo de Receita':['Venda sob prescrição médica','Venda livre']},
    }]};
    const output = t.mock.method(console, 'log', () => {});
    const previous = process.exitCode;
    try {
      await run(source,['info','Marca','Ausente'],retailer,{choicesFor:async () => []});
      const text = output.mock.calls.map(call => call.arguments[0]).join('\n');
      for (const fact of ['Referência','Substância X','2 mg','Via: não confirmada','Oral, Tópica',
        'Liberação: Prolongada','Embalagem: 20 comprimidos','Fabricante X','https://example.test/ficha',
        'Precisa de receita? não confirmado','A farmácia retém? não confirmado','Qual receituário? não confirmado',
        'As fontes divergem','Nenhuma apresentação encontrada']) assert.ok(text.includes(fact),fact);
      assert.equal(process.exitCode,3);
    } finally {process.exitCode = previous;}
  });
}

test('a retail brand following its product line preserves volume and excludes unrelated merchandise',()=>{
  const product={brand:'Dauf',name:'Solução Fisiológica Dauf Pro Soro 0,9% 500ml',facts:{}};
  for(const query of ['Dauf Pro Soro 500 mL','Pro Soro Dauf 500 mL']) assert.ok(prepareSearch(query).matches(product));
  for(const query of ['Pro Soro Dauf 100 mL','Pro Soro Dauf 10mg','Pro Soro Outramarca 500 mL']) {
    assert.equal(prepareSearch(query).matches(product),false);
  }
  const match=prepareSearch('Pro Soro Dauf 500 mL').matches;
  assert.equal(match({...product,name:'Acessório para Dauf Pro Soro 500 ml'}),false);
  assert.equal(match({...product,name:'Dauf Pro Soro 2 x 500 ml'}),false);
  assert.equal(match({...product,name:'Cloreto de Sódio Dauf 500ml',description:product.name}),false);
});
