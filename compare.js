import { retailerComparison } from 'drogasil-cli/retailer-workflows';

// Checkout can verify a requested quantity through a pickup point. The exact
// inventory of the branch is a different value and remains unknown.
export async function compareOffers(args, source, compare = retailerComparison) {
  const result = await compare(args, source);
  const origin = args.coordinates ?? args.zipcode;
  if (!origin || !result.products?.length) return result;
  const products = [];
  let failures = 0;
  for (const row of result.products) {
    try {
      const quote = await source.local(row, origin, 1);
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
  const status = failures===products.length ? 'source_failed' : failures ? 'partial' : result.status;
  return {...result,status,products,stockEvidence:'fulfillment_quote'};
}
