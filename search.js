import { medicationIntent, verifiedRow } from 'drogasil-cli/medication-catalog';
import { documentedSublingual, normalizeSublingual, presentationSearchTerms, requestsSublingual } from 'drogasil-cli/retailer-workflows';

const fold = value => String(value ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const connectors = new Set(['a', 'de', 'da', 'do', 'em', 'com', 'e']);
const isDose = word => /^\d+(?:\.\d+)?(?:mg|mcg|ui|g|%)(?:\/|$)/.test(word);

// Keep a dose/concentration together so "10 mg" cannot match "110 mg" or "10 mg/mL".
function words(value) {
  return (normalizeSublingual(fold(value)).replace(/(\d),(?=\d)/g, '$1.')
    .match(/\d+(?:\.\d+)?\s*(?:mcg|mg|kg|ml|ui|g|l|%)(?:\s*\/\s*(?:\d+(?:\.\d+)?\s*)?(?:ml|mg|g|l|h|dose))?(?![a-z])|[a-z]+|\d+(?:\.\d+)?/g) ?? [])
    .map(word => word.replace(/\s/g, '')).filter(word => !connectors.has(word));
}

export function prepareSearch(query) {
  // Searching VTEX for a detached "mg" also retrieves hundreds of unrelated
  // medicines. Fetch the name, then check the original presentation on each SKU.
  const term = requestsSublingual(query) ? presentationSearchTerms(query) || query : query;
  const text = term.split(/\s+(?=\d)/, 1)[0];
  const requested = words(query);
  const strengths = requested.filter(isDose);
  function matches(row) {
    if (!requested.length) return false;
    const title = words(row.name);
    const brand = words(row.brand);
    const facts = row.facts;
    const active = String(facts.NomeSubstanciaPrincipioAtivo ?? '');
    const ingredients = words(active);
    // Require a whole name token in an identity field. A description or indication
    // can mention a completely different medication.
    const first = requested[0];
    if (title[0] !== first && !brand.includes(first) && !ingredients.includes(first)) return false;
    const titleDoses = title.filter(isDose);
    const doseEvidence = titleDoses.length ? titleDoses : words(facts.Dosagem);
    if (!strengths.every(strength => doseEvidence.includes(strength))) return false;
    // On a combination pack an isolated strength may belong to another ingredient.
    // Require an explicit ingredient-strength pair if the catalog lists several.
    if (ingredients.includes(first) && (titleDoses.length > 1 || /[+,;]/.test(active))) {
      const explicitlyPaired = strength => [title, ingredients].some(tokens =>
        tokens.some((token, index) => token === first && tokens[index + 1] === strength));
      if (!strengths.every(explicitlyPaired)) return false;
    }
    const presentation = [facts.Apresentação, facts['Tipo de Liberação']].flat().join(' ');
    const evidence = new Set([...title, ...brand, ...ingredients, ...doseEvidence, ...words(presentation)]);
    return requested.every(word => word === 'sublingual'
      ? documentedSublingual(row.name, facts['Forma Farmacêutica'] ?? facts.Apresentação, facts['Via de Administração'] ?? facts['Forma de Administração'])
      : evidence.has(word));
  }
  return { text, matches };
}

// Restricted Damerau-Levenshtein distance gives one edit to adjacent swaps.
// Only compare names already proposed by the retailer.
function closeSpelling(typed, candidate) {
  if (!/^[a-z]{4,48}$/.test(typed) || !/^[a-z]{4,48}$/.test(candidate)) return false;
  const limit = typed.length >= 11 ? 3 : typed.length >= 7 ? 2 : 1;
  if (Math.abs(typed.length - candidate.length) > limit) return false;
  let previous = Array.from({ length: candidate.length + 1 }, (_, i) => i);
  let older;
  for (let i = 1; i <= typed.length; i++) {
    const row = [i];
    for (let j = 1; j <= candidate.length; j++) {
      row[j] = Math.min(previous[j] + 1, row[j - 1] + 1,
        previous[j - 1] + Number(typed[i - 1] !== candidate[j - 1]));
      if (i > 1 && j > 1 && typed[i - 1] === candidate[j - 2] && typed[i - 2] === candidate[j - 1]) {
        row[j] = Math.min(row[j], older[j - 2] + 1);
      }
    }
    older = previous;
    previous = row;
  }
  return previous[candidate.length] <= limit;
}

export async function suggest(site, prefix, limit = 7, request = fetch) {
  const text = String(prefix ?? '').trim();
  if (!text || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    throw new TypeError('Supply a prefix and a limit from 1 to 50');
  }
  const [typed, ...qualifiers] = words(text);
  if (!typed) return [];
  async function lookup(endpoint, extra = {}) {
    const url = new URL('/api/intelligent-search/v1/' + endpoint, site);
    url.search = new URLSearchParams({ query: text, locale: 'pt-BR', sc: '1', ...extra });
    const response = await request(url, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error('Pague Menos suggestions HTTP ' + response.status);
    return response.json();
  }
  const [data, catalog] = await Promise.all([lookup('autocomplete-suggestions'),
    lookup('product-search', { count: '12', page: '1' })]);
  if (!Array.isArray(data.searches) || !Array.isArray(catalog.products)) throw new Error('Unexpected suggestions response');

  const supported = new Map();
  const plausible = name => name && (name.startsWith(typed) || closeSpelling(typed, name));
  for (const product of catalog.products) {
    const actives = product.properties?.find(p => p.name === 'NomeSubstanciaPrincipioAtivo')?.values;
    // General storefront searches also return cosmetic kits and accessories.
    // Their titles cannot establish that a lookalike is a medication name.
    const medicine = Array.isArray(actives) && actives.length ||
      product.categories?.some(path => /^\/medicamentos(?: e saude)?\//.test(fold(path)));
    if (!medicine) continue;
    const names = new Set([fold(product.brand), words(product.productName)[0], ...words(actives)]);
    for (const name of names) {
      if (/^[a-z]+$/.test(name) && plausible(name)) supported.set(name, (supported.get(name) ?? 0) + 1);
    }
  }
  const suggestions = new Map();
  function add(term, count = 0) {
    const tokens = words(term);
    const [name, ...tail] = tokens;
    const key = tokens.join(' ');
    if (!plausible(name) || suggestions.has(key)) return;
    // Preserve every explicit presentation constraint when correcting the name.
    if (qualifiers.length && qualifiers.join(' ') !== tail.join(' ')) return;
    suggestions.set(key, {term, name, bare: tail.length === 0, count: Number(count) || 0});
  }
  for (const hit of data.searches) {
    if (typeof hit?.term === 'string') add(hit.term.trim(), hit.count);
  }
  if (!qualifiers.length) for (const name of supported.keys()) add(name);

  // Confirm a catalog identity first. Within comparable candidates prefer an
  // actual prefix and a whole name, then use the storefront's search frequency.
  const ranked = [...suggestions.values()].sort((a, b) =>
    Number(supported.has(b.name)) - Number(supported.has(a.name)) ||
    Number(b.name.startsWith(typed)) - Number(a.name.startsWith(typed)) ||
    Number(b.bare) - Number(a.bare) || b.count - a.count ||
    (supported.get(b.name) ?? 0) - (supported.get(a.name) ?? 0));
  return ranked.slice(0, limit).map(option => option.term);
}

export async function searchVerifiedCatalog(source, query, page, limit, intentFor = medicationIntent) {
  const [rows, intent] = await Promise.all([source.search(query, page, limit), intentFor(query)]);
  if (intent.kind !== 'ingredient') return rows;
  return rows.flatMap(row => {
    const field = 'NomeSubstanciaPrincipioAtivo';
    // The retailer sometimes fills this field with the class “Antimicrobiano”
    // alone or before the actual ingredient. Keep other field values authoritative.
    const ingredients = [row.facts?.[field]].flat().filter(value => typeof value === 'string')
      .flatMap(value => value.split(/[,;]/)).map(value => value.trim())
      .filter(value => value && !/^antimicrobianos?$/iu.test(value));
    const verified = verifiedRow(row, intent, {ingredients, evidence:{source:'retailer_field', field}});
    return verified ? [verified] : [];
  });
}
