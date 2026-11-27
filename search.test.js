import test from 'node:test';
import assert from 'node:assert/strict';
import { createRetailer } from './vtex.js';
import { prepareSearch, suggest } from './search.js';
import { run } from './runner.js';

const site = 'https://example.com';
const seller = { sellerId: '1', commertialOffer: {} };
function product(id, name, ingredient) {
  return {
    allSpecifications: ['NomeSubstanciaPrincipioAtivo'], NomeSubstanciaPrincipioAtivo: [ingredient],
    description: 'A descrição menciona morfina.',
    items: [{ itemId: String(id), name, sellers: [seller] }],
  };
}

test('suggest uses public query completions, deduplicates doses and ignores product previews', async () => {
  const terms = await suggest(site, 'morfi', 7, async (url, options) => {
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

test('CLI offers completions on an empty first page without searching the suggestion or changing JSON rows', async t => {
  const printed = t.mock.method(console, 'log', () => {});
  const hints = t.mock.method(console, 'error', () => {});
  const originalCode = process.exitCode;
  t.after(() => { process.exitCode = originalCode; });
  const queries = [];
  const retailer = { search: async text => { queries.push(text); return []; },
    suggest: t.mock.fn(async () => ['morfina', 'morfina 10mg']) };
  await run(retailer, ['search', 'morfi', '--json'], 'paguemenos');
  assert.deepEqual(queries, ['morfi']);
  assert.equal(printed.mock.calls[0].arguments[0], '[]');
  assert.equal(hints.mock.calls[0].arguments[0], 'Você quis dizer morfina?');
  assert.equal(process.exitCode, 3);
  await run(retailer, ['search', 'morfi', '--page', '2', '--json'], 'paguemenos');
  assert.equal(retailer.suggest.mock.callCount(), 1);
  await run(retailer, ['suggest', 'morfi', '--json'], 'paguemenos');
  assert.deepEqual(JSON.parse(printed.mock.calls.at(-1).arguments[0]), ['morfina', 'morfina 10mg']);
});
