import {routeFinder} from 'drogasil-cli';

// Each block is an independently verified visit or a retailer's joint plan.
// Two separately quoted orders at the same branch cannot prove joint fulfillment.
const cents = value => Number.isFinite(value) && value >= 0 ? Math.round(value * 100) : null;
const finiteDistance = stop => Number.isFinite(stop.distanceKm) ? stop.distanceKm : Infinity;

function stockBlocks(result, items) {
  const blocks = [];
  for (const plan of result.plans ?? []) {
    const stops = (plan.stops ?? []).map(stop => ({
      ...stop, retailerId:'drogasil', pickups:stop.pickups.map(pick => ({
        ...pick, item:result.tables.findIndex(t => t.label === pick.table), evidence:'reported_branch_stock',
      })),
    }));
    if (stops.length) blocks.push(stops);
  }
  if (result.branchChoices) {
    for (const [item,choices] of result.branchChoices.entries()) {
      for (const {store,...pick} of choices) blocks.push([{...store,retailerId:'drogasil',
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
        retailerId:'drogasil', pickups:[{item:i, name:product.name, sku:product.sku, type:product.type,
          packs, unitPriceBRL:product.referencePriceBRL, reportedStock:store.quantity, evidence:'reported_branch_stock'}]}]);
    }
  }
  return blocks;
}

function pickupMethods(product) {
  return (product.methods ?? []).filter(m => m.channel === 'pickup-in-point' && m.pickupPointId);
}

function pickupBlock(id, method, products, indices, items) {
  return [{retailerId:id, id:method.pickupPointId, name:method.branch, address:method.address,
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

async function collectPartnerBlocks(result, items, quoteSubset) {
  const id = result.retailerId;
  const indices = items.map((_,i) => i);
  const blocks = partnerBlocks(result,id,indices,items);
  const failures = [];
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
      if (['source_failed','unconfirmed','unresolved_items'].includes(quote.status)) failures.push(subset);
      const quoted = quote.items ?? [];
      if (quoted.length !== chosen.length || !quoted.every((p,j)=>
        p.sku === chosen[j].selectedSku && p.sellerId === chosen[j].sellerId)) return;
      for (const [stop] of partnerBlocks(quote,id,chosen.map((_,j)=>j),chosen)) {
        blocks.push([{...stop,pickups:stop.pickups.flatMap(pick => grouped[pick.item].indices.map(i =>
          ({...pick,item:i,packs:items[i].quantity ?? 1})))}]);
      }
    } catch { failures.push(subset); }
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
      if (['source_failed','unconfirmed','unverified','unresolved_items'].includes(quote.status)) failures.push(subset);
      blocks.push(...partnerBlocks(quote,id,subset,items));
      await checkCombinations(subset,quote);
    } catch { failures.push(subset); }
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
  return {blocks, failures, limited};
}

function bestPlans(blocks, count) {
  const keyOf = s => s.retailerId + ':' + s.id;
  const stores = new Map(), coordinates = new Map();
  const tour = routeFinder(stores,coordinates);
  const byItem = Array.from({length:count},() => []);
  for (const stops of blocks) {
    const picks = stops.flatMap(s => s.pickups);
    const indices = picks.map(p => p.item);
    if (!indices.length || new Set(indices).size !== indices.length || indices.some(i => i < 0 || i >= count)) continue;
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
  let fewest, cheapest, nodes = 0, limited = false;
  const ordered = (a,b) => {
    for (let i=0; i<a.length; i++) if (a[i] !== b[i]) return a[i] < b[i];
    return false;
  };
  const deadline = performance.now() + 2000;
  const usedItems = new Set(), usedStops = new Set(), selected = [];
  function visit(i,cost) {
    if (++nodes > 50000 || (nodes % 64 === 0 && performance.now() > deadline)) { limited = true; return; }
    while (usedItems.has(i)) i++;
    if (i === count) {
      const visits = new Map(), stockUsed = new Map();
      for (const block of selected) for (const stop of block.stops) {
        const key = keyOf(stop);
        if (!visits.has(key)) visits.set(key,{...stop,pickups:[]});
        for (const p of stop.pickups) {
          if (stop.retailerId === 'drogasil') {
            const inventoryKey = key + ':' + p.sku;
            const needed = (stockUsed.get(inventoryKey) ?? 0) + p.packs;
            if (needed > p.reportedStock) return;
            stockUsed.set(inventoryKey,needed);
          }
          visits.get(key).pickups.push(p);
        }
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
      return;
    }
    for (const block of byItem[i]) {
      if (limited) break;
      if (block.indices.some(j => usedItems.has(j)) || block.keys.some(k => !k.startsWith('drogasil:') && usedStops.has(k))) continue;
      block.indices.forEach(j => usedItems.add(j));
      const added = block.keys.filter(k => !usedStops.has(k));
      added.forEach(k => usedStops.add(k));
      selected.push(block);
      visit(i+1,cost+block.cost);
      selected.pop();
      block.indices.forEach(j => usedItems.delete(j));
      added.forEach(k => usedStops.delete(k));
    }
  }
  visit(0,0);
  return {fewest:fewest?.plan, cheapest:cheapest?.plan, limited};
}

export async function crossRetailerPlans(results, items, quoteSubset) {
  const reports = await Promise.all(results.map(async result => result.retailerId === 'drogasil'
    ? {blocks:stockBlocks(result,items), failures:[], limited:false}
    : collectPartnerBlocks(result,items,quoteSubset)));
  const overall = summarizePlans(reports,results,items.length);
  if (results.length > 1) overall.byRetailer = Object.fromEntries(results.flatMap((r,j) =>
    r.retailerId === 'drogasil' ? [] : [[r.retailerId,summarizePlans([reports[j]],[r],items.length)]]));
  return overall;
}

function summarizePlans(reports,results,count) {
  const {fewest,cheapest,limited} = bestPlans(reports.flatMap(r => r.blocks),count);
  const plans = [];
  if (fewest) plans.push({...fewest,objective:fewest === cheapest ? 'both' : 'fewest_stores'});
  if (cheapest && cheapest !== fewest) plans.push({...cheapest,objective:'lowest_price'});
  const comparison = cheapest && fewest?.totalBRL != null && fewest !== cheapest ? {
    savingsBRL:(cents(fewest.totalBRL)-cents(cheapest.totalBRL))/100,
    extraStops:cheapest.stopCount-fewest.stopCount,
    extraKm:cheapest.roundTripKm == null || fewest.roundTripKm == null ? null : cheapest.roundTripKm-fewest.roundTripKm,
  } : null;
  return {status:plans.length ? 'complete' : 'no_complete_plan_verified',
    scope:'verified_pickup_and_branch_plans',distanceBasis:'straight_line_round_trip',feesIncluded:false, plans, comparison,
    lookupFailures:reports.flatMap((r,j) => r.failures.map(itemIndices => ({retailerId:results[j].retailerId,itemIndices}))),
    searchLimited:limited || reports.some(r => r.limited)};
}
