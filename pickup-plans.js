import {directoryId} from './fixed-store.js';
import {routeFinder} from 'drogasil-cli';

// Each block is an independently verified visit or a retailer's joint plan.
// Two separately quoted orders at the same branch cannot prove joint fulfillment.
const cents = value => Number.isFinite(value) && value >= 0 ? Math.round(value * 100) : null;
const finiteDistance = stop => Number.isFinite(stop.distanceKm) ? stop.distanceKm : Infinity;

const money = new Intl.NumberFormat('pt-BR', {style:'currency', currency:'BRL'});
const kilometers = new Intl.NumberFormat('pt-BR', {maximumFractionDigits:2});

export function describePlanDifference({savingsBRL, extraStops, extraKm}) {
  const stops = extraStops === 0 ? 'o mesmo número de paradas' :
    extraStops + (extraStops === 1 ? ' parada a mais' : ' paradas a mais');
  let distance = 'diferença de distância a confirmar';
  if (Number.isFinite(extraKm)) {
    const meters = Math.round(Math.abs(extraKm) * 1000);
    if (meters === 0) distance = 'a mesma distância estimada de ida e volta';
    else {
      const magnitude = meters < 1000 ? meters + ' m' : kilometers.format(meters / 1000) + ' km';
      distance = magnitude + (extraKm > 0 ? ' a mais' : ' a menos') + ' de ida e volta em linha reta';
    }
  }
  return 'Economia de ' + money.format(savingsBRL) + ' no total estimado, com ' + stops + ' e ' + distance + '.';
}

export function describePickupStop(stop) {
  const a = stop.address ?? {};
  const street = a.street ?? a.addressLocal;
  const number = a.number ?? a.addressNumber;
  const address = [street, number].filter(part => part != null && part !== '').join(', ');
  const name = stop.name?.trim().replace(/\s+[-–—]$/, '') || '';
  if (!name || !address) return name || address;
  const normalize = text => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  if ((' ' + normalize(name) + ' ').includes(' ' + normalize(address) + ' ')) return name;
  return name + ' — ' + address;
}

function stockBlocks(result, items) {
  const blocks = [];
  for (const plan of result.plans ?? []) {
    const stops = (plan.stops ?? []).map(stop => ({
      ...stop, retailerId:result.retailerId, pickups:stop.pickups.map(pick => ({
        ...pick, item:result.tables.findIndex(t => t.label === pick.table), evidence:'reported_branch_stock',
      })),
    }));
    if (stops.length) blocks.push(stops);
  }
  if (result.branchChoices) {
    for (const [item,choices] of result.branchChoices.entries()) {
      for (const {store,...pick} of choices) blocks.push([{...store,retailerId:result.retailerId,
        pickups:[{...pick,item,reportedStock:store.quantity,evidence:'reported_branch_stock'}]}]);
    }
    return blocks;
  }
  for (const [i, table] of (result.tables ?? []).entries()) {
    if (table.needsSelection || !items[i]) continue;
    for (const product of table.rows ?? []) {
      const {store} = product;
      const packs = items[i].quantity ?? 1;
      if (!store?.id || !Number.isFinite(store.quantity) || store.quantity < packs) continue;
      blocks.push([{id:store.id, name:store.name, address:store.address, distanceKm:store.distanceKm,
        retailerId:result.retailerId, pickups:[{item:i, name:product.name, sku:product.sku, type:product.type,
          packs, unitPriceBRL:product.referencePriceBRL, reportedStock:store.quantity, evidence:'reported_branch_stock'}]}]);
    }
  }
  return blocks;
}

function pickupMethods(product) {
  return (product.methods ?? []).filter(m => m.channel === 'pickup-in-point' && m.pickupPointId);
}

function pickupBlock(id, method, products, indices, items) {
  return [{retailerId:id, id:method.pickupPointId, branchId:directoryId(id,method), name:method.branch, address:method.address,
    distanceKm:method.distanceKm, pickups:products.map((p,j) => ({
      item:indices[j], sku:p.sku, name:p.name, type:p.type, packs:items[indices[j]].quantity ?? 1,
      unitPriceBRL:p.currentPrice, reportedStock:null, evidence:'quoted_pickup',
    }))}];
}

function partnerBlocks(result, id, indices, items) {
  if (!indices.length) return [];
  const alternatives = result.planningScope === 'one_pack_alternatives' && indices.length === 1;
  const products = alternatives ? result.products : result.items;
  if (!Array.isArray(products) || !products.length) return [];
  const verified = (p,i) => p.localStatus === 'available' && p.requestedQuantity === (items[i].quantity ?? 1);
  if (alternatives) return products.filter(p => verified(p,indices[0]))
    .flatMap(p => pickupMethods(p).map(m => pickupBlock(id,m,[p],indices,items)));
  if (products.length !== indices.length || !products.every((p,j) => verified(p,indices[j]))) return [];
  // A repeated offer requires a combined quantity check. Two lines in one
  // checkout response can each repeat the same availability.
  if (new Set(products.map(p => p.sku)).size !== products.length) return [];
  const common = new Set((result.commonPickupPoints ?? []).map(p => p.id));
  return pickupMethods(products[0]).filter(m => indices.length === 1 || common.has(m.pickupPointId))
    .map(m => pickupBlock(id,m,products,indices,items));
}

// A completed quote can contain a failed line alongside a usable pickup.
function quoteProblem(quote) {
  const rows = quote.items ?? quote.products ?? [];
  if (quote.status === 'source_failed' || quote.quoteStatus === 'source_failed' ||
      quote.pending?.some(p => p.status === 'source_failed') ||
      rows.some(p => p.localStatus === 'lookup_failed' || p.pickupVerification?.status === 'directory_failed')) {
    return 'lookup_failed';
  }
  if (['unconfirmed','unverified','unresolved_items'].includes(quote.status) ||
      rows.some(p => p.localStatus === 'unverified' || p.pickupVerification?.status === 'incomplete')) {
    return 'pickup_unknown';
  }
  return null;
}

async function collectPartnerBlocks(result, items, quoteSubset) {
  const id = result.retailerId;
  const indices = items.map((_,i) => i);
  const blocks = partnerBlocks(result,id,indices,items);
  // A chain-level exception before checkout has no evidence of a quote.
  const initialProblem = result.planningScope || Array.isArray(result.items) || result.pending
    ? quoteProblem(result) : null;
  const failures = initialProblem ? [{itemIndices:indices,reason:initialProblem}] : [];
  const singleOutcomes = new Map();
  let jointChecks = 0, combinations = 0, limited = false;
  const fixedCache = new Map();

  // The checkout must quote the actual seller and the combined pack count.
  // Expand a combined line back to its original positions only after verification.
  async function checkSelection(subset, products) {
    const groups = new Map();
    for (const [j,p] of products.entries()) {
      const key = JSON.stringify([p.sku,p.sellerId]);
      if (!groups.has(key)) groups.set(key,{product:p,indices:[]});
      groups.get(key).indices.push(subset[j]);
    }
    const grouped = [...groups.values()];
    // The checkout may consolidate the same SKU from different sellers.
    if (new Set(grouped.map(g=>g.product.sku)).size !== grouped.length) return;
    const chosen = grouped.map(({product,indices}) => ({
      query:String(product.sku), selectedSku:String(product.sku), sellerId:product.sellerId,
      quantity:indices.reduce((sum,i)=>sum+(items[i].quantity ?? 1),0),
    }));
    const key = JSON.stringify(chosen);
    if (!fixedCache.has(key)) {
      if (jointChecks >= 24) { limited = true; return; }
      jointChecks++;
      fixedCache.set(key,quoteSubset(id,grouped.map(g=>g.indices[0]),chosen));
    }
    try {
      const quote = await fixedCache.get(key);
      const reason = quoteProblem(quote);
      if (reason) failures.push({itemIndices:subset,reason});
      const quoted = quote.items ?? [];
      if (quoted.length !== chosen.length || !quoted.every((p,j)=>
        p.sku === chosen[j].selectedSku && p.sellerId === chosen[j].sellerId)) return;
      for (const [stop] of partnerBlocks(quote,id,chosen.map((_,j)=>j),chosen)) {
        blocks.push([{...stop,pickups:stop.pickups.flatMap(pick => grouped[pick.item].indices.map(i =>
          ({...pick,item:i,packs:items[i].quantity ?? 1})))}]);
      }
    } catch { failures.push({itemIndices:subset,reason:'lookup_failed'}); }
  }

  async function checkCombinations(subset, quote) {
    if (subset.length < 2) return;
    if (quote.items?.length === subset.length) {
      const products=quote.items;
      if (products.every(p=>p.sku && p.sellerId) && new Set(products.map(p=>p.sku)).size < products.length) {
        await checkSelection(subset,products);
      }
      return;
    }
    if (quote.status !== 'choose_products') return;
    const choices = quote.tables?.map(t => t.verifiedChoices ?? []);
    if (choices?.length !== subset.length || choices.some(rows=>!rows.length)) return;
    async function visit(products) {
      if (products.length === subset.length) {
        combinations++;
        return checkSelection(subset,products);
      }
      for (const choice of choices[products.length]) {
        if (combinations >= 24) { limited=true; break; }
        await visit([...products,choice]);
      }
    }
    await visit([]);
  }
  await checkCombinations(indices,result);
  const available = indices.filter(i => {
    const t = result.tables?.[i];
    return t && (t.status === 'matches' || t.status === 'partial' || t.status === 'incomplete_presentation') &&
      t.choices?.length > 0;
  });
  const quoteCache = new Map();
  const check = async subset => {
    const key = JSON.stringify(subset.map(i => items[i]));
    if (!quoteCache.has(key)) quoteCache.set(key,quoteSubset(id,subset));
    try {
      const quote = await quoteCache.get(key);
      const reason = quoteProblem(quote);
      if (subset.length === 1 && !reason) {
        const rows = quote.products ?? quote.items ?? [];
        if (rows.length && rows.every(p => ['available','unavailable'].includes(p.localStatus) &&
            p.requestedQuantity === (items[subset[0]].quantity ?? 1)) &&
            !quote.unverified?.length && !['partial','source_failed'].includes(quote.quoteStatus) &&
            rows.every(p => p.localStatus === 'unavailable' || !pickupMethods(p).length)) {
          singleOutcomes.set(subset[0],'pickup_not_offered');
        }
      }
      if (reason) failures.push({itemIndices:subset,reason});
      blocks.push(...partnerBlocks(quote,id,subset,items));
      await checkCombinations(subset,quote);
    } catch { failures.push({itemIndices:subset,reason:'lookup_failed'}); }
  };
  // For each chain check its locally resolvable part together as well as
  // separate visits. Bound additional outbound calls on long shopping lists.
  if (available.length > 12 || (available.length > 2 && items.length > 4)) limited = true;
  if (available.length > 1 && available.length < items.length) await check(available);
  if (available.length >= 3 && items.length <= 4) {
    for (let j=0; j<available.length; j++) {
      for (let k=j+1; k<available.length; k++) await check([available[j],available[k]]);
    }
  }
  for (const i of available.slice(0,12)) await check([i]);
  return {blocks, failures, limited, singleOutcomes};
}

function bestPlans(blocks, count) {
  const keyOf = s => s.retailerId + ':' + (s.branchId ?? s.id);
  const stores = new Map(), coordinates = new Map();
  const tour = routeFinder(stores,coordinates);
  const byItem = Array.from({length:count},() => []);
  const reachable = new Set();
  for (const stops of blocks) {
    const picks = stops.flatMap(s => s.pickups);
    const indices = picks.map(p => p.item);
    if (!indices.length || new Set(indices).size !== indices.length || indices.some(i => i < 0 || i >= count)) continue;
    indices.forEach(i => reachable.add(i));
    const prices = picks.map(p => cents(p.unitPriceBRL));
    const cost = prices.includes(null) ? Infinity : prices.reduce((sum,price,i) => sum + price * picks[i].packs,0);
    for (const stop of stops) {
      const key = keyOf(stop);
      stores.set(key,stop);
      const [longitude,latitude] = stop.address?.geoCoordinates ?? [];
      const point = stop.coordinates ?? {longitude,latitude};
      if (Number.isFinite(point.longitude) && Math.abs(point.longitude) <= 180 &&
          Number.isFinite(point.latitude) && Math.abs(point.latitude) <= 90) coordinates.set(key,point);
    }
    const entry = {stops, indices, keys:stops.map(keyOf), cost};
    byItem[Math.min(...indices)].push(entry);
  }
  let fewest, cheapest, covered = 0, nodes = 0, limited = false;
  const ordered = (a,b) => {
    for (let i=0; i<a.length; i++) if (a[i] !== b[i]) return a[i] < b[i];
    return false;
  };
  let allowPartial = false;
  const deadline = performance.now() + 2000;
  const usedItems = new Set(), usedStops = new Set(), quotedStops = new Set(), selected = [];
  function consider(selected,cost,filled) {
    if (filled < covered) return;
    if (!filled) return;
    const visits = new Map(), stockUsed = new Map();
    for (const block of selected) for (const stop of block.stops) {
      const key = keyOf(stop);
      if (!visits.has(key)) visits.set(key,{...stop,pickups:[]});
      for (const p of stop.pickups) {
        if (p.evidence === 'reported_branch_stock') {
          const inventoryKey = key + ':' + p.sku;
          const previous = stockUsed.get(inventoryKey);
          const needed = (previous?.needed ?? 0) + p.packs;
          const available = Math.min(previous?.available ?? Infinity,p.reportedStock);
          if (!Number.isFinite(p.reportedStock) || needed > available) return;
          stockUsed.set(inventoryKey,{needed,available});
        }
        visits.get(key).pickups.push(p);
      }
    }
    if (filled > covered) {
      covered = filled;
      fewest = undefined;
      cheapest = undefined;
    }
    if (fewest && cheapest && visits.size > fewest.plan.stopCount && cost > cheapest.rank[0]) return;
    const route = tour(visits.keys());
    const stops = route.ids.map(id => visits.get(id));
    const distance = route.km ?? Infinity;
    const proximity = stops.reduce((sum,s) => sum + finiteDistance(s),0);
    const fewRank = [stops.length,distance,cost,proximity], priceRank = [cost,stops.length,distance,proximity];
    const plan = {stopCount:stops.length,roundTripKm:route.km,routeExactAmongChosenStops:route.exact,
      totalBRL:Number.isFinite(cost) ? cost/100 : null,stops};
    if (!fewest || ordered(fewRank,fewest.rank)) fewest = {rank:fewRank,plan};
    if (Number.isFinite(cost) && (!cheapest || ordered(priceRank,cheapest.rank))) cheapest = {rank:priceRank,plan};
  }
  function visit(i,cost,skipped) {
    if (reachable.size - skipped < covered) return;
    if (++nodes > 50000 || (nodes % 64 === 0 && performance.now() > deadline)) { limited = true; return; }
    while (i < count && (usedItems.has(i) || !reachable.has(i))) i++;
    if (i === count) return consider(selected,cost,usedItems.size);
    for (const block of byItem[i]) {
      if (limited) break;
      if (block.indices.some(j => usedItems.has(j))) continue;
      const quoted = block.stops.filter(stop => stop.pickups.some(p => p.evidence === 'quoted_pickup')).map(keyOf);
      if (quoted.some(key => usedStops.has(key)) || block.keys.some(key => quotedStops.has(key))) continue;
      quoted.forEach(key => quotedStops.add(key));
      block.indices.forEach(j => usedItems.add(j));
      const added = block.keys.filter(k => !usedStops.has(k));
      added.forEach(k => usedStops.add(k));
      selected.push(block);
      visit(i+1,cost+block.cost,skipped);
      selected.pop();
      block.indices.forEach(j => usedItems.delete(j));
      added.forEach(k => usedStops.delete(k));
      quoted.forEach(k => quotedStops.delete(k));
    }
    // A branch may fulfill later items even when this line is missing or
    // incompatible with a joint quote. A complete result prunes every skip.
    if (allowPartial && !limited && reachable.size - skipped > covered) visit(i+1,cost,skipped+1);
  }
  // Prioritize complete itineraries within the search budget.
  if (reachable.size === count) visit(0,0,0);
  if (!fewest && !limited && reachable.size) {
    allowPartial = true;
    visit(0,0,0);
  }
  // If the exhaustive search timed out before finding a complete cover, each
  // existing block still provides a candidate that can be checked on its own.
  if (limited && !fewest) {
    for (const entries of byItem) for (const block of entries) consider([block],block.cost,block.indices.length);
  }
  return {covered, fewest:fewest?.plan, cheapest:cheapest?.plan, limited};
}

export async function crossRetailerPlans(results, items, quoteSubset) {
  const reports = await Promise.all(results.map(async result => {
    if (result.retailerId === 'drogasil') return {blocks:stockBlocks(result,items), failures:[], limited:false};
    const inventory = result.checkout ? result : result.purchase;
    const checkout = result.checkout ?? result;
    const report = await collectPartnerBlocks(checkout, items, async (...args) => {
      const subset = await quoteSubset(...args);
      return subset.checkout ?? subset;
    });
    if (inventory?.stockEvidence === 'retailer_branch_snapshot') {
      report.blocks.push(...stockBlocks({...inventory,retailerId:result.retailerId},items));
    }
    return report;
  }));
  const overall = summarizePlans(reports,results,items);
  if (results.length > 1) overall.byRetailer = Object.fromEntries(results.flatMap((r,j) =>
    r.retailerId === 'drogasil' ? [] : [[r.retailerId,summarizePlans([reports[j]],[r],items)]]));
  return overall;
}

const reasonText = {
  catalog_miss:'apresentação não encontrada no catálogo consultado',
  reference_missing:'sem referência para identificar essa apresentação',
  presentation_choice:'é preciso escolher a apresentação ou o fabricante',
  catalog_failed:'falha na consulta ao catálogo',
  lookup_failed:'falha na consulta à rede',
  stock_failed:'falha na consulta ao estoque',
  stock_unknown:'quantidade na filial a confirmar',
  insufficient_stock:'as filiais consultadas não informaram estoque suficiente',
  pickup_not_offered:'o site não ofereceu retirada da quantidade pedida',
  joint_unconfirmed:'há uma opção individual, mas a combinação com as demais retiradas ficou sem confirmação',
  pickup_unknown:'retirada a confirmar',
};

export function describeUnfilled(line) {
  const retailers = {drogasil:'Drogasil',paguemenos:'Pague Menos',drogariasaopaulo:'Drogaria São Paulo'};
  return line.name + ' — ' + line.outcomes.map(({retailerId,reason}) =>
    retailers[retailerId] + ' (' + reasonText[reason] + ')').join(', ') + '.';
}

function lineOutcome(result,report,i) {
  const checkout = result.checkout ?? result;
  const physical = result.checkout ? result : result.purchase ?? result;
  const catalog = checkout.tables?.[i];
  const stock = physical.tables?.[i];
  const status = catalog?.status ?? stock?.status;
  if (report.blocks.some(stops => stops.some(s => s.pickups.some(p => p.item === i)))) return 'joint_unconfirmed';
  if (catalog?.needsSelection || stock?.needsSelection || ['ambiguous','choose_manufacturer','choose_reference','presentation_options','conflicting_release'].includes(status)) return 'presentation_choice';
  if (status === 'catalog_lookup_failed' || status === 'source_failed') return 'catalog_failed';
  if (['no_match','requested_brand_not_found','preference_unavailable','selected_presentation_unverified'].includes(status)) return 'catalog_miss';
  if (status === 'no_reference') return 'reference_missing';
  if (status === 'partial' && !catalog?.choices?.length) return 'catalog_failed';
  if (stock?.failed?.length) return 'stock_failed';
  if (checkout.status === 'source_failed' || report.failures.some(f => f.reason === 'lookup_failed' && f.itemIndices.length === 1 && f.itemIndices[0] === i)) return 'lookup_failed';
  if (stock?.unknown?.length) return 'stock_unknown';
  if (stock?.unavailable?.length && !stock.rows?.length) return 'insufficient_stock';
  if (report.failures.some(f => f.itemIndices.length === 1 && f.itemIndices[0] === i)) return 'pickup_unknown';
  return report.singleOutcomes?.get(i) ?? 'pickup_unknown';
}

function summarizePlans(reports,results,items) {
  const {fewest,cheapest,covered,limited} = bestPlans(reports.flatMap(r => r.blocks),items.length);
  const partial = covered < items.length;
  const pending = partial ? items.map((item,i) => ({
    item:i, name:/^\d+$/.test(item.query) ? 'Item '+(i+1) : item.query,
    outcomes:results.map((result,j) => ({retailerId:result.retailerId,reason:lineOutcome(result,reports[j],i)})),
  })) : [];
  const plans = [];
  function add(plan,objective) {
    const entry = {...plan,objective};
    if (partial) {
      const filled = new Set(plan.stops.flatMap(stop => stop.pickups.map(p => p.item)));
      entry.unfilled = pending.filter(line => !filled.has(line.item));
    }
    plans.push(entry);
  }
  if (fewest) add(fewest,fewest === cheapest ? 'both' : 'fewest_stores');
  if (cheapest && cheapest !== fewest) add(cheapest,'lowest_price');
  const sameLines = !partial || (plans.length === 2 && plans[0].unfilled.every((line,i) => line.item === plans[1].unfilled[i].item));
  const comparison = sameLines && cheapest && fewest?.totalBRL != null && fewest !== cheapest ? {
    savingsBRL:(cents(fewest.totalBRL)-cents(cheapest.totalBRL))/100,
    extraStops:cheapest.stopCount-fewest.stopCount,
    extraKm:cheapest.roundTripKm == null || fewest.roundTripKm == null ? null : cheapest.roundTripKm-fewest.roundTripKm,
  } : null;
  return {status:fewest && !partial ? 'complete' : 'no_complete_plan_verified',
    scope:'verified_pickup_and_branch_plans',distanceBasis:'straight_line_round_trip',feesIncluded:false,
    plans:partial ? [] : plans, comparison:partial ? null : comparison,
    ...(partial && {partialBasket:{filledCount:covered,requestedCount:items.length,plans,comparison,
      ...(covered === 0 && {unfilled:pending})}}),
    lookupFailures:reports.flatMap((r,j) => r.failures.map(failure => ({retailerId:results[j].retailerId,...failure}))),
    searchLimited:limited || reports.some(r => r.limited)};
}
