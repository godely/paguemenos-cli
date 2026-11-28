import { physicalShopping, permitsStockExpansion } from './branch-shopping.js';
import { inventoryConfig } from './branch-inventory.js';
import { fixedStoreSource } from './fixed-store.js';
export { fixedStoreSource } from './fixed-store.js';
import { retailerComparison } from 'drogasil-cli/retailer-workflows';

// Checkout can verify a requested quantity through a pickup point. The exact
// inventory of the branch is a different value and remains unknown.
export async function compareOffers(args, source, compare = retailerComparison) {
  const origin = args.coordinates ?? args.zipcode;
  const hasCheckout = typeof source.local === 'function';
  if (args.store) source = fixedStoreSource(args.retailer, source, origin, args.store);
  const result = await compare(args, source);
  if (!origin || !result.products?.length) return result;
  const config = inventoryConfig(args.retailer);
  const physical = args.store || args.expandSearch || config;
  const quoted = hasCheckout
    ? await quoteLocalOptions(result, source, origin, 1) : result;
  const checkout = args.store ? await source.withStoreEvidence(quoted) : quoted;
  if (!physical) return checkout;

  const purchase = await physicalShopping(args.retailer, source,
    [{query:args.query, includeGenerics:args.includeGenerics}], [result], origin, {...args, allowExpansion:permitsStockExpansion(checkout)}, config);
  const branches = new Map(purchase.tables[0].rows.map(row => [row.sku, row.store]));
  const products = checkout.products.map(row => {
    const closestStore = branches.get(row.sku) ?? null;
    return {...row, closestStore, branchQuantity:closestStore?.quantity ?? null};
  });
  return {...checkout, products, purchase, stockEvidence:purchase.stockEvidence,
    ...(hasCheckout && {checkoutEvidence:'fulfillment_quote'})};
}

export async function quoteLocalOptions(result, source, origin, quantity) {
  const products = [];
  let failures = 0, partial = false;
  for (const row of result.products) {
    try {
      const quote = await source.local(row, origin, quantity);
      if (quote.localStatus === 'lookup_failed') failures++;
      if (quote.pickupVerification && quote.pickupVerification.status !== 'verified') partial = true;
      const pickup = quote.methods.filter(m => m.channel === 'pickup-in-point' && m.pickupPointId);
      const measured = pickup.length && pickup.every(m => Number.isFinite(m.distanceKm));
      const closest = measured ? pickup.reduce((a,b) => a.distanceKm <= b.distanceKm ? a : b) : null;
      products.push({...quote, closestQuotedPickup:closest, branchQuantity:null});
    } catch {
      failures++;
      products.push({...row, localStatus:'lookup_failed', ...(source.fixedStore && {pickupAtStore:'lookup_failed'}), methods:[], closestQuotedPickup:null, branchQuantity:null});
    }
  }
  // Keep the requested brand first and sort within each group by its updated price.
  products.sort((a,b) => Number(a.role==='generic') - Number(b.role==='generic') ||
    (a.currentPrice ?? Infinity) - (b.currentPrice ?? Infinity) || String(a.sku).localeCompare(String(b.sku)));
  const status = products.length && failures === products.length ? 'source_failed' : failures || partial ? 'partial' : result.status;
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
