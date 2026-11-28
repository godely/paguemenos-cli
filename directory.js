import { checkoutOrigin } from './location.js';

export async function stores(origin, request = fetch) {
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
  const number = v => v == null || String(v).trim() === '' || !Number.isFinite(Number(v)) ? null : Number(v);
  const distance = row => {
    const value = number(row.distancia_usuario);
    return value !== null && value >= 0 ? value : null;
  };
  return rows.filter(row => row.bandeira?.trim().toUpperCase() === 'PAGUE MENOS' && row.cod_loja != null && (!row.status || row.status.trim().toUpperCase() === 'ATIVA')).map(row => ({
    id: String(row.cod_loja), storeName:row.nome_loja, phone:String(row.fixo_loja ?? '').trim() ? [row.ddd,row.fixo_loja].filter(Boolean).join(' ') : null,
    distanceKm:distance(row),
    openingHours:{weekdays:row.seg_a_sex || null,saturday:row.sabado || null,sunday:row.domingo || null,holidays:row.feriado || null},
    address:{street:row.endereco, district:row.bairro, city:row.cidade, state:row.uf, postalCode:row.cep,
      latitude:number(row.latitude_loja), longitude:number(row.longitude)},
  })).sort((a,b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity));
}
