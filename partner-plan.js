import { physicalShopping } from './branch-shopping.js';
import { inventoryConfig } from './branch-inventory.js';
import { resolveMedication } from 'drogasil-cli';
import { retailerComparison, retailerBasket, tableLabel } from 'drogasil-cli/retailer-workflows';

export async function quoteShoppingList(retailer, source, items, origin, resolve = resolveMedication, options = {}) {
  const pendingBrands = [];
  for (const item of items) {
    if (item.sku || /^\d+$/.test(item.query) || item.includeGenerics !== undefined || item.genericOnly || item.brand) continue;
    if ((await resolve(item.query)).kind === 'brand') pendingBrands.push(item.query);
  }
  if (pendingBrands.length) return {retailerId:retailer,status:'needs_generic_preference',pendingBrands};
  const config=inventoryConfig(retailer);
  const physical=Boolean(options.store || options.expandSearch || config);
  const lines = [], tables = [], selections = [], pending = [], quotedLabels = [];
  for (const item of items) {
    let selection;
    try {
      selection = await retailerComparison({retailer, query:item.sku ?? item.query,
        includeGenerics:!item.sku && Boolean(item.includeGenerics || item.genericOnly)},source);
    } catch {
      selection = {status:'catalog_lookup_failed',products:[]};
    }
    let rows=selection.products ?? [];
    if (item.genericOnly) rows=rows.filter(p=>p.type==='Genérico');
    if (item.brand) {
      const brand=item.brand.trim().toLocaleLowerCase('pt-BR');
      rows=rows.filter(p=>p.brand?.trim().toLocaleLowerCase('pt-BR')===brand ||
        (p.name.toLocaleLowerCase('pt-BR')+' ').startsWith(brand+' ') || (item.includeGenerics && p.role==='generic'));
    }
    const choices=new Set(rows.map(p=>p.sku));
    const label = tableLabel(tables.length);
    const listed = selection.candidates ?? rows;
    const status = selection.products?.length && !listed.length ? 'preference_unavailable' : selection.status;
    selections.push({...selection,status,products:rows});
    tables.push({label,query:item.query,quantity:item.quantity ?? 1,status,choices:listed});
    if (choices.size===1) {
      lines.push({sku:rows[0].sku,quantity:item.quantity ?? 1});
      quotedLabels.push(label);
    } else {
      pending.push({label,query:item.query,status:listed.length ? 'choose_product' : status});
    }
  }
  if (physical) return physicalShopping(retailer,source,items,selections,origin,options,config);
  if (pending.length) {
    const needsChoice = pending.some(row=>row.status==='choose_product');
    let partialQuote;
    if (lines.length) {
      try { partialQuote = await retailerBasket({retailer,items:lines,zipcode:origin},source); }
      catch { partialQuote = {status:'source_failed'}; }
    }
    const allFailed = pending.every(row=>row.status==='catalog_lookup_failed') && (!partialQuote || partialQuote.status==='source_failed');
    const status = needsChoice ? 'choose_products' : allFailed ? 'source_failed' : partialQuote ? 'partial' : 'unfilled';
    return {retailerId:retailer,status,tables,pending,estimatedProductTotalBRL:null,
      ...(partialQuote && {partialQuote:{...partialQuote,labels:quotedLabels}}),
      planningScope:'whole_basket_fulfillment',routeStatus:'branch_inventory_unverified'};
  }
  return {...await retailerBasket({retailer,items:lines,zipcode:origin},source),tables,
    planningScope:'whole_basket_fulfillment',routeStatus:'branch_inventory_unverified'};
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
