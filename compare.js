import { physicalShopping } from './branch-shopping.js';
import { inventoryConfig } from './branch-inventory.js';
import { retailerComparison } from 'drogasil-cli/retailer-workflows';

// Checkout can verify a requested quantity through a pickup point. The exact
// inventory of the branch is a different value and remains unknown.
export async function compareOffers(args, source, compare = retailerComparison) {
  const result = await compare(args, source);
  const origin = args.coordinates ?? args.zipcode;
  if (!origin || !result.products?.length) return result;
  const config=inventoryConfig(args.retailer);
  if (args.store || args.expandSearch || config) {
    const purchase=await physicalShopping(args.retailer,source,[{query:args.query,includeGenerics:args.includeGenerics}],
      [result],origin,args,config);
    const table=purchase.tables[0];
    const bySku=new Map(table.rows.map(row=>[row.sku,row]));
    const products=result.products.map(row=>{
      const store=bySku.get(row.sku)?.store ?? null;
      return {...row, closestStore:store, branchQuantity:store?.quantity ?? null};
    });
    return {...result,products,purchase,stockEvidence:purchase.stockEvidence};
  }
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
