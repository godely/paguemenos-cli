const fold = value => String(value ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const connectors = new Set(['a', 'de', 'da', 'do', 'em', 'com', 'e']);
const isDose = word => /^\d+(?:\.\d+)?(?:mg|mcg|ui|g|%)(?:\/|$)/.test(word);

// Keep a dose/concentration together so "10 mg" cannot match "110 mg" or "10 mg/mL".
function words(value) {
  return (fold(value).replace(/(\d),(?=\d)/g, '$1.')
    .match(/\d+(?:\.\d+)?\s*(?:mcg|mg|kg|ml|ui|g|l|%)(?:\s*\/\s*(?:\d+(?:\.\d+)?\s*)?(?:ml|mg|g|l|h|dose))?(?![a-z])|[a-z]+|\d+(?:\.\d+)?/g) ?? [])
    .map(word => word.replace(/\s/g, '')).filter(word => !connectors.has(word));
}

export function prepareSearch(query) {
  // Searching VTEX for a detached "mg" also retrieves hundreds of unrelated
  // medicines. Fetch the name, then check the original presentation on each SKU.
  const text = query.split(/\s+(?=\d)/, 1)[0];
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
    return requested.every(word => evidence.has(word));
  }
  return { text, matches };
}

export async function suggest(site, prefix, limit = 7, request = fetch) {
  const text = String(prefix ?? '').trim();
  if (!text || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    throw new TypeError('Supply a prefix and a limit from 1 to 50');
  }
  const url = new URL('/api/intelligent-search/v1/autocomplete-suggestions', site);
  url.search = new URLSearchParams({ query: text, locale: 'pt-BR', sc: '1' });
  const response = await request(url, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error('Pague Menos suggestions HTTP ' + response.status);
  const data = await response.json();
  if (!Array.isArray(data.searches)) throw new Error('Unexpected suggestions response');
  const suggestions = new Map();
  for (const hit of data.searches) {
    if (typeof hit?.term !== 'string') continue;
    const term = hit.term.trim();
    const key = words(term).join(' ');
    if (!key || !fold(term).startsWith(fold(text)) || suggestions.has(key)) continue;
    suggestions.set(key, term);
    if (suggestions.size === limit) break;
  }
  return [...suggestions.values()];
}
