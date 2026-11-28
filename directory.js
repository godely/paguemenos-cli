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
  return rows.filter(row => row.bandeira?.trim().toUpperCase() === 'PAGUE MENOS' && row.cod_loja != null).map(row => ({
    id: String(row.cod_loja), storeName:row.nome_loja, phone:[row.ddd,row.fixo_loja].filter(Boolean).join(' ') || null,
    address:{street:row.endereco, district:row.bairro, city:row.cidade, state:row.uf, postalCode:row.cep,
      latitude:number(row.latitude_loja), longitude:number(row.longitude)},
  }));
}
