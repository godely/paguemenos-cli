import { checkoutOrigin } from './location.js';

async function directoryRows(origin, request) {
  const location = checkoutOrigin(origin);
  const route = location.postalCode
    ? 'get-store-base-by-address/' + location.postalCode
    : 'get-store-base-by-coordinates/' + origin.latitude + '/' + origin.longitude;
  const response = await request(new URL('/_v/' + route, 'https://www.paguemenos.com.br'), {signal:AbortSignal.timeout(15000)});
  if (response.status === 204) return [];
  if (!response.ok) throw new Error('Pague Menos locator HTTP ' + response.status);
  const data = await response.json();
  const rows = location.postalCode ? data : data.sortedStores;
  if (!Array.isArray(rows)) throw new Error('Unexpected Pague Menos store directory');
  return rows;
}

function openingHours(row) {
  const flag = String(row.horas_24 ?? '').trim().toUpperCase();
  return {weekdays:row.seg_a_sex || null, saturday:row.sabado || null, sunday:row.domingo || null,
    holidays:row.feriado || null, open24Hours:flag === 'SIM' ? true : ['NÃO','NAO'].includes(flag) ? false : null};
}

export async function stores(origin, request = fetch) {
  const rows = await directoryRows(origin, request);
  const number = v => v == null || String(v).trim() === '' || !Number.isFinite(Number(v)) ? null : Number(v);
  return rows.filter(row => row.bandeira?.trim().toUpperCase() === 'PAGUE MENOS' && row.cod_loja != null).map(row => ({
    id: String(row.cod_loja), storeName:row.nome_loja, hours:openingHours(row), phone:[row.ddd,row.fixo_loja].filter(Boolean).join(' ') || null,
    address:{street:row.endereco, district:row.bairro, city:row.cidade, state:row.uf, postalCode:row.cep,
      latitude:number(row.latitude_loja), longitude:number(row.longitude)},
  }));
}


// A pickup offer can refer to another banner in the same retailer's directory.
// Only enrich IDs actually offered by checkout. Cache public branch data, never the origin.
export function lookupPickupStores(request = fetch) {
  const cache = new Map();
  return async (origin, pickupIds) => {
    const result = new Map(), missing = new Map();
    const now = Date.now();
    for (const point of pickupIds) {
      const id = /^paguemenos(\d+)_/i.exec(point)?.[1].replace(/^0+(?=\d)/, '');
      if (!id) continue;
      const hit = cache.get(id);
      if (hit && hit.expires > now) result.set(point, hit.store);
      else missing.set(point, id);
    }
    if (!missing.size) return result;
    let rows;
    try { rows = await directoryRows(origin, request); }
    catch { return result; } // A locator outage cannot invalidate a checkout offer.
    const byId = new Map();
    for (const row of rows) {
      const banner = row.bandeira?.trim().toUpperCase();
      if (banner !== 'PAGUE MENOS' && banner !== 'EXTRAFARMA') continue;
      const id = String(row.cod_loja ?? '').trim();
      if (!id) continue;
      const store = {id, directoryName:row.nome_loja || null, banner, address:row.endereco || null,
        city:row.cidade || null, state:row.uf || null, hours:openingHours(row)};
      // Duplicate IDs with different branch records cannot establish identity.
      if (byId.has(id)) byId.set(id, null);
      else byId.set(id, store);
    }
    for (const [point, id] of missing) {
      const store = byId.get(id);
      if (!store) continue;
      result.set(point, store);
      if (cache.size >= 512) cache.delete(cache.keys().next().value);
      cache.set(id, {store, expires:now + 5 * 60_000});
    }
    return result;
  };
}
