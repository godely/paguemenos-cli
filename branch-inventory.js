import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const runFile = promisify(execFile);
const indexer = fileURLToPath(new URL('./branch_inventory.py', import.meta.url));
const retailers = new Set(['paguemenos', 'drogariasaopaulo']);

export function inventoryConfig(retailer, env = process.env) {
  if (!retailers.has(retailer)) return null;
  const prefix = retailer.toUpperCase() + '_BRANCH_STOCK_';
  const database = env[prefix + 'DB'];
  const maxAge = env[prefix + 'MAX_AGE_MINUTES'];
  if (!database && !maxAge) return null;
  const maxAgeMs = Number(maxAge) * 60000;
  if (!database || !Number.isSafeInteger(maxAgeMs) || maxAgeMs <= 0)
    throw new Error('Configure both ' + prefix + 'DB and a positive ' + prefix + 'MAX_AGE_MINUTES.');
  return { database, maxAgeMs };
}

export async function loadObservations(retailer, database, sku) {
  const {stdout} = await runFile('python3', [indexer, 'lookup', '--database', database, '--retailer', retailer, sku],
    {maxBuffer: 8 * 1024 * 1024, timeout: 30000});
  return JSON.parse(stdout);
}

export function branchStock(retailer, sku, directory, feed, {
  maxAgeMs, now = Date.now(), maxBranches = 30, minimum = 1, includeAll = false, expand = false,
}) {
  if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0 || !Number.isSafeInteger(maxBranches) || maxBranches < 3 || maxBranches > 30 ||
      !Number.isSafeInteger(minimum) || minimum < 1) throw new RangeError('Invalid inventory search limits');
  const observations = new Map(feed.observations.map(r => [r.storeId,r]));
  const ordered = [...directory].sort((a,b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity) || String(a.id).localeCompare(String(b.id)));
  const seen = new Set();
  const located = [];
  let unknownDistanceStores = 0;
  for (const store of ordered) {
    const id = String(store.id);
    if (seen.has(id)) continue;
    seen.add(id);
    if (!Number.isFinite(store.distanceKm) || store.distanceKm < 0) { unknownDistanceStores++; continue; }
    const entry = observations.get(id);
    let status = 'missing', quantity = null;
    if (entry) {
      const age = now - Date.parse(entry.observedAt);
      if (!Number.isFinite(age) || age < 0 || age > maxAgeMs) status = 'stale';
      else if (!Number.isSafeInteger(entry.quantity) || entry.quantity < 0) status = 'unknown';
      else { status = 'reported'; quantity = entry.quantity; }
    }
    located.push({id, name: store.storeName, address: store.address, distanceKm: store.distanceKm, phone: store.phone ?? null,
      whatsapp: store.whatsapp ?? null, status, quantity, observedAt: entry?.observedAt ?? null});
  }
  const initial = located.slice(0,maxBranches);
  const allZero = initial.length > 0 && !unknownDistanceStores && initial.every(s => s.quantity === 0);
  const radiusKm = initial.at(-1)?.distanceKm ?? null;
  const canExpand = allZero && radiusKm < 25 && located.slice(maxBranches).some(s => s.distanceKm <= 25);
  const expanded = Boolean(expand && canExpand);
  const checked = expanded ? located.filter(s => s.distanceKm <= 25) : initial;
  const matches = checked.filter(s => s.quantity != null && s.quantity >= minimum);
  const unknownStores = checked.filter(s => s.quantity == null).length;
  return {
    retailer, sku, evidence: 'retailer_branch_snapshot', snapshotAt: feed.snapshotAt,
    status: matches.length ? 'available' : (!checked.length || unknownStores || unknownDistanceStores ? 'unknown' : 'unavailable'),
    coverage: {scope:'branches_returned_by_retailer_locator', checkedStores: checked.length, unknownStores, unknownDistanceStores,
      radiusKm: expanded ? 25 : radiusKm, nearbyAllZero: allZero, canExpand: canExpand && !expanded},
    expanded, totalStockedStores: matches.length,
    stores: expanded ? matches.slice(0,10) : includeAll ? checked : matches,
    ...(expanded && {advice: 'Ligue para a filial antes de sair para confirmar o estoque.'}),
  };
}

export async function lookupBranchStock(retailer, source, origin, sku, config, options = {}) {
  const [directory, feed] = await Promise.all([source.stores(origin), loadObservations(retailer, config.database, sku)]);
  return branchStock(retailer, sku, directory, feed, {...options, maxAgeMs: config.maxAgeMs});
}

