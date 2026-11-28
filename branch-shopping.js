import { planFromInventory, tableLabel } from 'drogasil-cli/retailer-workflows';
import { branchRows, loadBasketObservations } from './branch-inventory.js';

const sellers = {
  paguemenos: new Set(['farmacias pague menos','pague menos']),
  drogariasaopaulo: new Set(['drogaria sao paulo']),
};
const fold = s => String(s ?? '').normalize('NFD').replace(/\p{M}/gu,'').toLowerCase().trim();

function physicalProducts(retailer, offers) {
  const products = new Map();
  for (const row of offers) {
    const ownPrice = sellers[retailer].has(fold(row.seller)) && Number.isFinite(row.currentPrice) && row.currentPrice >= 0
      ? row.currentPrice : null;
    const prior = products.get(row.sku);
    if (prior) {
      if (ownPrice != null && (prior.referencePriceBRL == null || ownPrice < prior.referencePriceBRL)) prior.referencePriceBRL=ownPrice;
    } else {
      products.set(row.sku, {...row, referencePriceBRL:ownPrice});
    }
  }
  return [...products.values()].sort((a,b) => Number(a.role==='generic') - Number(b.role==='generic') ||
    (a.referencePriceBRL ?? Infinity) - (b.referencePriceBRL ?? Infinity) || String(a.sku).localeCompare(String(b.sku)));
}

function prepare(retailer, items, selections) {
  return selections.map((selection,i) => {
    const item=items[i];
    const products=physicalProducts(retailer,selection.products ?? []);
    const status=selection.status==='choose_reference' ? 'ambiguous' : selection.status;
    return {products, table:{...item, label:tableLabel(i), status, quantity:item.quantity ?? 1,
      selectedSku:item.sku, requestedBrandSkus:products.filter(p=>p.role==='requested').map(p=>p.sku),
      candidates:selection.candidates, missingFields:selection.missingFields}};
  });
}

function expandSummary(stocks, minimums, checked, partial) {
  const grouped=new Map();
  for (const [sku,{stores}] of stocks) {
    for (const branch of stores) {
      if (branch.quantity == null || branch.quantity < minimums.get(sku)) continue;
      if (!grouped.has(branch.id)) grouped.set(branch.id,{...branch,stocks:[]});
      grouped.get(branch.id).stocks.push({sku,quantity:branch.quantity,observedAt:branch.observedAt});
    }
  }
  const stores=[...grouped.values()].sort((a,b)=>a.distanceKm-b.distanceKm || a.id.localeCompare(b.id));
  return {radiusKm:25, checkedStores:checked, partial, totalStockedStores:stores.length, stores:stores.slice(0,10),
    advice:'Ligue para a filial antes de sair para confirmar o estoque.'};
}

export function hasPickupOffer(quote) {
  const rows = quote.products ?? quote.items ?? [];
  return rows.some(row => row.localStatus === 'available' &&
    row.methods?.some(method => method.channel === 'pickup-in-point' && method.pickupPointId));
}

export function permitsStockExpansion(quote) {
  const rows = quote.products ?? quote.items ?? [];
  return !['source_failed','partial','lookup_failed','unverified','unconfirmed'].includes(quote.status) &&
    !rows.some(row => row.localStatus === 'lookup_failed') && !hasPickupOffer(quote);
}

export async function physicalShopping(retailer, source, items, selections, origin, {store, expandSearch=false, includeBranchChoices=false, allowExpansion=true}={}, config) {
  if ((store != null && store !== 'nearest' && !/^\d+$/.test(store)) || (store && expandSearch) || !origin) throw new TypeError('Invalid physical shopping scope');
  const prepared=prepare(retailer,items,selections);
  const minimums=new Map();
  for (const {table,products} of prepared) for (const {sku} of products) {
    minimums.set(sku,Math.min(minimums.get(sku) ?? Infinity,table.quantity));
  }
  let directory=[], directoryFailed=false;
  if (minimums.size) {
    try { directory=await source.stores(origin); } catch { directoryFailed=true; }
  }
  const located=directory.filter(s=>Number.isFinite(s.distanceKm) && s.distanceKm>=0)
    .sort((a,b)=>a.distanceKm-b.distanceKm || a.id.localeCompare(b.id));
  const distanceUnknown=located.length!==directory.length;
  const unique=[];
  const seen=new Set();
  for (const branch of located) {
    if (seen.has(branch.id)) continue;
    seen.add(branch.id);
    unique.push(branch);
  }
  const initial = store === 'nearest' ? (distanceUnknown ? [] : unique.slice(0,1))
    : store ? unique.filter(branch => String(branch.id) === store) : unique.slice(0,30);
  const wider=expandSearch ? unique.filter(s=>s.distanceKm<=25) : [];
  const branchIds=[...new Set([...initial,...wider].map(s=>s.id))];
  let feed, feedFailed=false;
  if (config && minimums.size && branchIds.length) {
    try { feed=await loadBasketObservations(retailer,config.database,[...minimums.keys()],branchIds); }
    catch { feedFailed=true; }
  }
  const stocks=new Map();
  const now=Date.now();
  function gather(branches) {
    for (const sku of minimums.keys()) {
      const {located:stores}=branchRows(branches,feed?.bySku[sku] ?? [],now,config?.maxAgeMs ?? 1);
      stocks.set(sku,{stores,failed:feedFailed || directoryFailed,partial:distanceUnknown});
    }
  }
  gather(initial);
  const allZero=initial.length>0 && !distanceUnknown && prepared.every(p=>p.products.length && !['partial','ambiguous','catalog_lookup_failed'].includes(p.table.status)) &&
    [...stocks.values()].every(s=>s.stores.every(b=>b.quantity===0));
  const canExpand=allowExpansion && !store && allZero && initial.at(-1).distanceKm<25 && unique.slice(30).some(s=>s.distanceKm<=25);
  const expanded=Boolean(expandSearch && canExpand);
  if (expanded) gather(wider);
  const incomplete=directoryFailed || feedFailed || distanceUnknown || !feed ||
    [...stocks.values()].some(s=>!s.stores.length || s.stores.some(b=>b.quantity==null));
  const coverage={scope:'branches_returned_by_retailer_locator',checkedStores:initial.length,radiusKm:initial.at(-1)?.distanceKm ?? null,
    allZero,canExpand:canExpand && !expanded,stockUnknown:incomplete};
  const coordinatesFor=async()=>new Map(unique.filter(s=>Number.isFinite(s.address?.latitude) && Number.isFinite(s.address?.longitude))
    .map(s=>[s.id,s.address]));
  const plan=await planFromInventory(prepared,stocks,{store:store ? 'nearest' : undefined,nearestStore:initial[0],coverage,coordinatesFor,includeBranchChoices,
    expandedSearch:expanded ? expandSummary(stocks,minimums,wider.length,incomplete) : undefined});
  return {...plan,retailerId:retailer,stockEvidence:feed?'retailer_branch_snapshot':feedFailed?'branch_inventory_lookup_failed':'no_branch_inventory_source',
    snapshotAt:feed?.snapshotAt ?? null,priceEvidence:'retailer_online_reference',
    inventoryStatus:directoryFailed || feedFailed ? 'source_failed' : plan.status==='complete' ? 'available' :
      plan.status==='partial' ? 'partial' : incomplete ? 'unknown' : 'insufficient_stock',
    stockIncomplete:plan.stockIncomplete || incomplete,directoryFailed:plan.directoryFailed || directoryFailed};
}
