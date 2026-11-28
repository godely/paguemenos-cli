import { checkoutOrigin } from './location.js';

function number(value, min, max) {
  if (value == null || String(value).trim() === '') return null;
  const n = Number(String(value).trim().replace(',', '.'));
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

function phone(area, local) {
  if (local == null || !/^\d{8,9}$/.test(String(local).trim())) return null;
  return /^\d{2}$/.test(String(area).trim()) ? area + ' ' + String(local).trim() : String(local).trim();
}

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
  const branches = new Map();
  for (const row of rows) {
    const id = String(row.cod_loja ?? '').trim();
    if (row.bandeira?.trim().toUpperCase() !== 'PAGUE MENOS' || !id) continue;
    const status = String(row.status ?? '').trim().toUpperCase();
    if (['INATIVA', 'INATIVO', 'FECHADA', 'FECHADO'].includes(status)) continue;
    const distanceKm = number(row.distancia_usuario, 0, Infinity);
    const prior = branches.get(id);
    if (prior && (prior.distanceKm ?? Infinity) <= (distanceKm ?? Infinity)) continue;
    const hours = { weekdays: row.seg_a_sex || null, saturday: row.sabado || null,
      sunday: row.domingo || null, holidays: row.feriado || null };
    branches.set(id, {
      id, storeName: row.nome_loja, distanceKm, status: status || null,
      phone: phone(row.ddd, row.fixo_loja) ?? phone(row.ddd, row.celular_loja),
      hours, openingHours: hours,
      address: {street: row.endereco, district: row.bairro, city: row.cidade, state: row.uf, postalCode: row.cep,
        latitude: number(row.latitude_loja,-90,90), longitude: number(row.longitude,-180,180)},
    });
  }
  return [...branches.values()].sort((a,b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity) || a.id.localeCompare(b.id));
}
