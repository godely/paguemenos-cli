// Match only the retailer's checkout identifiers observed in its own store directory.
export function directoryId(retailer, method) {
  const id = method.pickupPointId ?? '';
  const pattern = retailer === 'paguemenos' ? /^paguemenos(\d+)_[\w-]+$/i :
    retailer === 'drogariasaopaulo' ? /^(?:drogariasaopaulo|drogariasp)[\w-]*_(\d+)$/i : null;
  const match = pattern?.exec(id);
  return match ? match[1].replace(/^0+(?=\d)/, '') : null;
}

async function locate(source, origin, selector) {
  try {
    const stores = await source.stores(origin);
    const measured = stores.filter(s => Number.isFinite(s.distanceKm) && s.distanceKm >= 0)
      .sort((a,b) => a.distanceKm - b.distanceKm || String(a.id).localeCompare(String(b.id)));
    const branch = selector === 'nearest' ? measured[0] : stores.find(s => String(s.id) === selector);
    return {selector, status:branch ? 'identified' : 'store_unconfirmed', branch:branch ?? null,
      storesWithDistance:measured.length, storesInDirectoryResult:stores.length};
  } catch { return {selector, status:'directory_failed', branch:null}; }
}

function atBranch(retailer, branch, quote, offer, quantity) {
  const exact = quote && quote.sku === offer.sku && quote.sellerId === offer.sellerId && quote.requestedQuantity === quantity;
  const pickup = exact && Array.isArray(quote.methods) ? quote.methods.filter(m => m.channel === 'pickup-in-point') : [];
  const methods = exact && quote.localStatus === 'available' ? pickup.filter(m => directoryId(retailer,m) === String(branch.id)) : [];
  let pickupAtStore = 'unconfirmed';
  if (methods.length) pickupAtStore = 'offered';
  else if (exact && (quote.localStatus === 'unavailable' || (quote.localStatus === 'available' &&
      Array.isArray(quote.methods) && quote.methods.length && pickup.every(m => directoryId(retailer,m) !== null)))) pickupAtStore = 'not_offered';
  const price = methods.length ? quote : offer;
  return {...price, methods, requestedQuantity:quantity, branchQuantity:null, pickupAtStore,
    localStatus:methods.length ? 'available' : 'unverified'};
}

// The directory is read once per shopping request, only once checkout is needed.
// The same filter applies to individual items, joint baskets and alternative plans.
export function fixedStoreSource(retailer, source, origin, selector) {
  if (!origin || (selector !== 'nearest' && !/^\d+$/.test(selector))) throw new TypeError('Informe uma origem e uma filial válida.');
  let location, directory;
  const wrapped = Object.create(source);
  wrapped.stores = () => directory ??= source.stores(origin);
  const selected = () => location ??= locate(wrapped, origin, selector);
  wrapped.fixedStore = true;
  wrapped.local = async (offer, place, quantity = 1) => {
    const {branch} = await selected();
    return atBranch(retailer, branch, branch && await source.local(offer, place, quantity), offer, quantity);
  };
  wrapped.basket = async (lines, place) => {
    const {branch} = await selected();
    let quotes = [];
    let failed = false;
    if (branch) {
      try { quotes = await source.basket(lines, place); }
      catch { failed = true; }
    }
    const expected = new Map();
    for (const {offer,quantity} of lines) {
      const key = JSON.stringify([offer.sku,offer.sellerId]);
      const packs = (expected.get(key)?.quantity ?? 0) + quantity;
      expected.set(key,{offer,quantity:packs});
    }
    return [...expected.values()].map(({offer,quantity}) => {
      const rows = quotes.filter(q => q.sku === offer.sku && q.sellerId === offer.sellerId);
      const result = atBranch(retailer, branch, rows.length === 1 ? rows[0] : null, offer, quantity);
      return failed ? {...result, localStatus:'lookup_failed', pickupAtStore:'lookup_failed'} : result;
    });
  };
  wrapped.withStoreEvidence = async result => {
    if (!location) return result;
    const fixedStore = await location;
    const rows = result.products ?? result.items ?? [];
    let status = result.status;
    if (fixedStore.status === 'directory_failed') status = 'source_failed';
    else if (fixedStore.status !== 'identified') status = 'store_unconfirmed';
    else if (rows.length && rows.every(r => r.pickupAtStore === 'lookup_failed')) status = 'source_failed';
    else if (rows.length && rows.every(r => r.pickupAtStore === 'not_offered')) status = 'pickup_not_offered';
    return {...result, status, fixedStore};
  };
  return wrapped;
}
