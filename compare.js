import { retailerComparison } from 'drogasil-cli/retailer-workflows';

// Checkout can verify a requested quantity through a pickup point. The exact
// inventory of the branch is a different value and remains unknown.
export async function compareOffers(args, source, compare = retailerComparison) {
  const result = await compare(args, source);
  const origin = args.coordinates ?? args.zipcode;
  if (!origin || !result.products?.length) return result;
  return quoteLocalOptions(result, source, origin, 1);
}

export async function quoteLocalOptions(result, source, origin, quantity) {
  const products = [];
  let failures = 0;
  for (const row of result.products) {
    try {
      const quote = await source.local(row, origin, quantity);
      const pickup = quote.methods.filter(m => m.channel === 'pickup-in-point' && m.pickupPointId);
      const measured = pickup.length && pickup.every(m => Number.isFinite(m.distanceKm));
      const closest = measured ? pickup.reduce((a,b) => a.distanceKm <= b.distanceKm ? a : b) : null;
      products.push({...quote, closestQuotedPickup:closest, branchQuantity:null});
    } catch {
      failures++;
      products.push({...row, localStatus:'lookup_failed', methods:[], closestQuotedPickup:null, branchQuantity:null});
    }
  }
  // Keep the requested brand first and sort within each group by its updated price.
  products.sort((a,b) => Number(a.role==='generic') - Number(b.role==='generic') ||
    (a.currentPrice ?? Infinity) - (b.currentPrice ?? Infinity) || String(a.sku).localeCompare(String(b.sku)));
  const status = products.length && failures === products.length ? 'source_failed' : failures ? 'partial' : result.status;
  if (result.scope === 'direct_requested_pack') {
    const pickup = products.filter(p => p.localStatus === 'available' && p.methods.some(m =>
      m.channel === 'pickup-in-point' && m.pickupPointId));
    const best = pickup.find(p => Number.isFinite(p.currentPrice));
    return { ...result, status, products, stockEvidence:'fulfillment_quote',
      lowestPricedPickup:best ? {sku:best.sku,sellerId:best.sellerId,name:best.name,currentPrice:best.currentPrice,
        requestedQuantity:quantity,branchQuantity:null} : null };
  }
  return {...result,status,products,stockEvidence:'fulfillment_quote'};
}
