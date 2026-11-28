import { crossRetailerPlans } from './pickup-plans.js';
import { quoteLocalOptions } from './compare.js';
import { resolveMedication } from 'drogasil-cli';
import { retailerComparison, retailerBasket } from 'drogasil-cli/retailer-workflows';

const words = value => String(value ?? '').normalize('NFD').replace(/\p{M}/gu,'')
  .toLowerCase().replace(/[^\p{L}0-9]+/gu,' ').trim();

export function matchesRequestedBrand(product,requested) {
  const brand = words(product.brand), family = words(requested);
  if (family && product.role === 'requested' && words(product.requestedTradeName) === family) return true;
  if (!brand || !family) return false;
  if (brand === family) return true;
  // The family must name this retailer-declared brand and appear verbatim
  // in the title. A competitor mentioning the same line cannot qualify.
  return (' '+family+' ').includes(' '+brand+' ') && (' '+words(product.name)+' ').includes(' '+family+' ');
}

export async function quoteShoppingList(retailer, source, items, origin, resolve = resolveMedication) {
  const pendingBrands = [];
  for (const item of items) {
    if (item.sku || /^\d+$/.test(item.query) || item.includeGenerics !== undefined || item.genericOnly || item.brand) continue;
    if ((await resolve(item.query)).kind === 'brand') pendingBrands.push(item.query);
  }
  if (pendingBrands.length) return {retailerId:retailer,status:'needs_generic_preference',pendingBrands};
  const lines = [], tables = [];
  for (const item of items) {
    const selection = await retailerComparison({retailer,query:item.sku ?? item.query,
      includeGenerics:!item.sku && Boolean(item.includeGenerics || item.genericOnly)},source);
    let rows=selection.products ?? [];
    if (item.genericOnly) rows=rows.filter(p=>p.type==='Genérico');
    if (item.brand) rows=rows.filter(p=>matchesRequestedBrand(p,item.brand) || (item.includeGenerics && p.role==='generic' && p.type==='Genérico'));
    if (items.length === 1 && (selection.scope === 'direct_requested_pack' || selection.scope === 'equivalents_in_reference_catalog' || selection.scope === 'verified_drop_presentation') && rows.length) {
      const result = await quoteLocalOptions({...selection, products:rows}, source, origin, item.quantity ?? 1);
      const available = result.products.some(p => p.localStatus === 'available');
      const status = result.status === 'source_failed' ? 'source_failed' : available ? 'fulfillable' :
        (result.status === 'partial' || result.unverified?.length || result.products.some(p => p.localStatus !== 'unavailable')) ? 'unverified' : 'unavailable';
      return { ...result, status, quoteStatus:result.status, planningScope:'one_pack_alternatives',
        tables:[{query:item.query, status, choices:result.products}], routeStatus:'branch_inventory_unverified' };
    }
    const choices=new Set(rows.map(p=>p.sku));
    const verifiedChoices = rows.filter(row=>row.sku && row.sellerId).map(({sku,sellerId})=>({sku,sellerId}));
    tables.push({query:item.query,status:selection.status,choices:selection.candidates??rows,verifiedChoices});
    if (choices.size===1) lines.push({sku:rows[0].sku,quantity:item.quantity ?? 1});
  }
  if(lines.length!==items.length) return {retailerId:retailer,status:'choose_products',tables};
  return {...await retailerBasket({retailer,items:lines,zipcode:origin},source),tables,
    planningScope:'whole_basket_fulfillment',routeStatus:'branch_inventory_unverified'};
}

// Catalog reads can recur for several candidate baskets in one shopping request.
// Checkout quotes still use the retailer and origin for that request.
export function shoppingSource(source) {
  const cached = Object.create(source);
  for (const name of ['product','search','byGtin']) {
    if (typeof source[name] !== 'function') continue;
    const reads = new Map();
    cached[name] = (...args) => {
      const key = JSON.stringify(args);
      if (!reads.has(key)) reads.set(key,source[name](...args));
      return reads.get(key);
    };
  }
  return cached;
}

export function quoteChosenOffers(retailer,source,lines,origin) {
  return retailerBasket({retailer,zipcode:origin,items:lines.map(line=>({
    sku:line.selectedSku,sellerId:line.sellerId,quantity:line.quantity ?? 1,
  }))},source);
}

export async function planShoppingList(retailer,provider,items,origin) {
  const source = shoppingSource(provider);
  const result = await quoteShoppingList(retailer,source,items,origin);
  if (items.length < 2 || result.pendingBrands) return result;
  const pickupPlans = await crossRetailerPlans([{...result,retailerId:retailer}],items,(_,indices,chosen) =>
    chosen ? quoteChosenOffers(retailer,source,chosen,origin) :
      quoteShoppingList(retailer,source,indices.map(i=>items[i]),origin));
  return {...result,pickupPlans};
}

export function shoppingItems(words, flags) {
  const items=words.map(query=>({query,quantity:1}));
  for(const key of ['quantity','sku','brand','generic','brand-only','include-generics']) {
    for(const selection of flags[key]??[]) {
      const toggle=['generic','brand-only','include-generics'].includes(key);
      const match=(toggle ? /^([A-Z]+)$/i : /^([A-Z]+)=(.+)$/i).exec(selection);
      if(!match) throw new TypeError('Invalid item selection: '+selection);
      const position=[...match[1].toUpperCase()].reduce((n,char)=>n*26+char.charCodeAt(0)-64,0)-1;
      const item=items[position];
      if(!item) throw new TypeError('Unknown item: '+match[1]);
      if(key==='quantity') {
        item.quantity=Number(match[2]);
        if(!Number.isSafeInteger(item.quantity)||item.quantity<1) throw new TypeError('Invalid requested quantity');
      } else if(key==='sku') {
        if(!/^\d+$/.test(match[2])) throw new TypeError('Expected a retailer SKU');
        item.sku=match[2];
      } else if(key==='brand') item.brand=match[2];
      else if(key==='generic') item.genericOnly=true;
      else {
        if(item.includeGenerics!==undefined) throw new TypeError('Conflicting generic preferences');
        item.includeGenerics=key==='include-generics';
      }
      if(item.genericOnly && (item.brand || item.includeGenerics===false)) throw new TypeError('Conflicting brand and generic choices');
    }
  }
  return items;
}
