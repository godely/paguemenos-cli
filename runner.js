import { quoteShoppingList, shoppingItems } from './partner-plan.js';
import { parseArgs } from 'node:util';
import { catalogInfo, catalogSnapshot, retailerComparison, runSnapshotCommand } from 'drogasil-cli/retailer-workflows';
import { checkoutOrigin, point } from './location.js';
import { validGtin } from './vtex.js';

const usage = {
  plan: 'plan <medication or SKU> ... (--cep CEP | --lat LAT --lon LON) [--quantity A=N] [--sku A=SKU] [--brand A=name] [--generic A] [--brand-only A | --include-generics A]',
  search: 'search <text> [--page N --limit N]', suggest: 'suggest <prefix> [--limit N]',
  product: 'product <SKU> [<SKU> ...]', gtin: 'gtin <EAN>',
  info: 'info <name or SKU> [<name or SKU> ...] [--brazil]',
  compare: 'compare <name or SKU> [--brand-only]',
  stock: 'stock <SKU> (--cep CEP | --lat LAT --lon LON) [--min-qty N | --quantity N]',
  stores: 'stores [--cep CEP | --lat LAT --lon LON]',
  snapshot: 'snapshot collect <query...> [--limit N] | read <run-id> [--offset N --limit N] | export <run-id> --format json|csv|xlsx',
};
const flags = {
  plan:['cep','lat','lon','quantity','sku','brand','generic','brand-only','include-generics'],
  search:['page','limit'], suggest:['limit'], product:[], gtin:[], info:['brazil'], compare:['brand-only'],
  stock:['cep','lat','lon','min-qty','quantity'], stores:['cep','lat','lon'], snapshot:['limit','offset','format'],
};
const usageError = msg => { console.error(msg); process.exitCode = 1; };
function emit(rows, json, columns) {
  if (json) console.log(JSON.stringify(rows, null, 2));
  else console.table(rows.map(row => Object.fromEntries(columns.map(k => [k,row?.[k] ?? '—']))));
}
function positive(v, max = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(Number(v)) && Number(v) >= 1 && Number(v) <= max;
}
function location(v) {
  if (v.lat != null || v.lon != null) {
    if (v.cep != null) throw new TypeError('Choose a CEP or coordinates');
    return point(v.lat,v.lon);
  }
  checkoutOrigin(v.cep);
  return v.cep;
}
export async function run(source, argv, bin) {
  let [command, ...args] = argv;
  if (!command || ['-h','--help','help'].includes(command)) {
    const help = Object.values(usage).map(s => '  '+bin+' '+s+' [--json]').join('\n');
    if (!command) return usageError(help);
    console.log(help);
    return;
  }
  if (!Object.hasOwn(usage,command)) return usageError('Unknown command: '+command);
  if (args.includes('--help') || args.includes('-h')) { console.log('Usage: '+bin+' '+usage[command]+' [--json]'); return; }
  let v, words, origin, items;
  try {
    const options = {json:{type:'boolean'}};
    for (const f of flags[command]) options[f] = {type:['brazil','brand-only'].includes(f)?'boolean':'string'};
    if(command==='plan') for(const f of flags.plan.slice(3)) options[f]={type:'string',multiple:true};
    args = args.flatMap((x,i) => ['--lat','--lon'].includes(x) && /^-\d/.test(args[i+1]) ? [x+'='+args[i+1]] :
      /^-\d/.test(x) && ['--lat','--lon'].includes(args[i-1]) ? [] : [x]);
    ({values:v,positionals:words} = parseArgs({args,allowPositionals:true,options}));
    if (command !== 'stores' && !words.length) throw Error(usage[command]);
    if (command === 'stock' || command === 'plan' || (command === 'stores' && (source.directoryScope==='near_origin' || v.cep || v.lat || v.lon))) origin=location(v);
    if (command === 'stores' && words.length) throw Error(usage.stores);
    if (command === 'stock' && (words.length!==1 || !/^\d+$/.test(words[0]) || (v.quantity != null && v['min-qty'] != null))) throw Error(usage.stock);
    if (command === 'product' && !words.every(x=>/^\d+$/.test(x))) throw Error(usage.product);
    if (command === 'gtin' && (words.length!==1 || !validGtin(words[0]))) throw Error(usage.gtin);
    if (!positive(v.page??1) || !positive(v.limit??1, command==='snapshot'?1000:50) || (command==='stock' && !positive(v.quantity??v['min-qty']??1))) throw Error('Invalid page, limit or quantity');
    if (command==='plan') items=shoppingItems(words,v);
    if (command==='snapshot' && (!['collect','read','export'].includes(words[0]) || words.length<2 || !Number.isSafeInteger(Number(v.offset??0)) || Number(v.offset??0)<0)) throw Error(usage.snapshot);
  } catch(error) { return usageError(error.message); }
  const query=words.join(' '), limit=Number(v.limit??20), columns=['sku','name','seller','currentPrice','inStock'];
  if (command==='plan') {
    const result=await quoteShoppingList(bin,source,items,origin);
    if(v.json) console.log(JSON.stringify(result,null,2));
    else if(result.pendingBrands) console.log('Quer considerar genéricos para '+result.pendingBrands.join(', ')+'?');
    else {
      console.log(result.status);
      for(const table of result.tables??[]) { console.log(table.query); emit(table.choices,false,['sku','name','type','currentPrice']); }
      if(result.items) emit(result.items,false,['sku','name','requestedQuantity','localStatus','currentPrice']);
      if(result.commonPickupPoints?.length) console.table(result.commonPickupPoints);
      if(result.estimatedProductTotalBRL!=null) console.log('Subtotal estimado (BRL)',result.estimatedProductTotalBRL);
    }
    if(result.status!=='fulfillable') process.exitCode=result.pending?.some(p=>p.status==='source_failed')?2:3;
    return;
  }
  if (command==='snapshot') {
    process.exitCode=await runSnapshotCommand(words,v,(queries,{maxItems})=>catalogSnapshot({retailer:bin,queries,maxItems},source,{background:false}));
    return;
  }
  if (command==='info') {
    const data=await catalogInfo({retailer:bin,queries:words,scope:v.brazil?'brazil':'catalog'},source);
    // Preserve the original SKU-only response shape for existing callers.
    if (words.length===1 && /^\d+$/.test(words[0]) && !v.brazil) {
      const rows=data.results[0].products;
      if (v.json) console.log(JSON.stringify(rows,null,2)); else console.table(rows);
    } else if (v.json) console.log(JSON.stringify(data,null,2));
    else for (const result of data.results) {
      console.log(result.query, result.status);
      console.table(result.products.map(p=>({name:p.name, strengths:p.strengths.join(', '),forms:p.forms.join(', '),prescription:p.prescriptionLabel.join(', ')||'não confirmado',retention:p.retentionLabel.join(', ')||'não confirmado',source:p.source})));
      if(v.brazil) console.log(JSON.stringify(result.brazil??{status:'não confirmado'},null,2));
    }
    if(data.results.some(r=>r.status==='source_failed'||r.nationalStatus==='source_failed')) process.exitCode=2;
    else if(data.results.some(r=>r.status!=='matches' && !r.brazil?.presentations?.length)) process.exitCode=3;
    return;
  }
  if (command==='compare') {
    const result=await retailerComparison({retailer:bin,query,includeGenerics:!v['brand-only']},source);
    if(v.json) console.log(JSON.stringify(result,null,2));
    else { console.log(result.status);emit(result.candidates??result.products??[],false,['sku','name','type','currentPrice']); }
    if(result.status==='partial') process.exitCode=2;
    else if(result.status!=='matches') process.exitCode=3;
    return;
  }
  if(command==='stores') {
    const stores=await source.stores(origin);
    if(v.json) console.log(JSON.stringify(stores,null,2));
    else console.table(stores.map(s=>({id:s.id,name:s.storeName,address:s.address.street,city:s.address.city,lat:s.address.latitude,lon:s.address.longitude})));
    if(!stores.length) process.exitCode=3;
    return;
  }
  if(command==='suggest') {
    const terms=await source.suggest(query,Number(v.limit??7));
    console.log(v.json?JSON.stringify(terms,null,2):terms.join('\n')||'Nenhuma sugestão.');
    if(!terms.length) process.exitCode=3;
    return;
  }
  if(command==='product' && words.length>1) {
    const batches=new Map();
    for (const sku of new Set(words)) batches.set(sku, await source.product(sku));
    const slots=words.map(sku=>batches.get(sku).length?batches.get(sku):null);
    if(v.json) console.log(JSON.stringify(slots,null,2));
    else emit(slots.flatMap((slot,i)=>slot??[{sku:words[i],name:'not found'}]),false,columns);
    if(slots.includes(null)) process.exitCode=3;
    return;
  }
  let rows;
  if(command==='search') {
    rows=await source.search(query,Number(v.page??1),limit);
    if (!rows.length && Number(v.page??1)===1) {
      try { const terms=(await source.suggest?.(query)??[]).filter(s=>s.toLowerCase()!==query.toLowerCase()); if(terms.length) console.error('Você quis dizer '+terms[0]+'?'); }
      catch(error) { console.error('Sugestões indisponíveis. '+error.message); }
    }
  } else if(command==='gtin') rows=await source.byGtin(query);
  else {
    rows=await source.product(query);
    if(command==='stock') {
      const local=[];
      for(const row of rows) local.push(await source.local(row,origin,Number(v.quantity??v['min-qty']??1)));
      rows=local;
    }
  }
  emit(rows,v.json || command==='stock',columns);
  if(!rows.length) process.exitCode=3;
}
