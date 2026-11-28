import {describePickupStop, describePlanDifference} from './pickup-plans.js';
import {hasPickupOffer} from './branch-shopping.js';
import { confirmCliNames } from 'drogasil-cli/cli-name-confirmation';
import { planShoppingList, shoppingItems } from './partner-plan.js';
import { parseArgs } from 'node:util';
import { renderPurchase, purchaseExitCode, acceptExpansion, retailerComparison, catalogInfo, catalogSnapshot, catalogType, requestsDrops, runSnapshotCommand } from 'drogasil-cli/retailer-workflows';
import { inventoryConfig, lookupBranchStock } from './branch-inventory.js';
import { compareOffers } from './compare.js';
import { checkoutOrigin, point } from './location.js';
import { validGtin } from './vtex.js';

const usage = {
  plan: 'plan <medication or SKU> ... (--cep CEP | --lat LAT --lon LON) [--store nearest | --expand] [--quantity A=N] [--sku A=SKU] [--brand A=name] [--generic A] [--brand-only A | --include-generics A]',
  search: 'search <text> [--page N --limit N]', suggest: 'suggest <prefix> [--limit N]',
  product: 'product <SKU> [<SKU> ...]', gtin: 'gtin <EAN>',
  info: 'info <name or SKU> [<name or SKU> ...] [--brazil]',
  compare: 'compare <name or SKU> [--brand-only] [--cep CEP | --lat LAT --lon LON] [--store nearest|ID | --expand]',
  stock: 'stock <SKU> (--cep CEP | --lat LAT --lon LON) [--min-qty N | --quantity N | --all] [--max-branches N] [--expand]',
  stores: 'stores [--cep CEP | --lat LAT --lon LON]',
  snapshot: 'snapshot collect [query...] [--limit N] | read <run-id> [--offset N --limit N] | export <run-id> --format json|csv|xlsx',
};
const flags = {
  plan:['cep','lat','lon','quantity','sku','brand','generic','brand-only','include-generics','store','expand'],
  search:['page','limit'], suggest:['limit'], product:[], gtin:[], info:['brazil'], compare:['brand-only','cep','lat','lon','store','expand'],
  stock:['cep','lat','lon','min-qty','quantity','all','max-branches','expand'], stores:['cep','lat','lon'], snapshot:['limit','offset','format'],
};
function usageError(msg, json = false) {
  if (json) console.log(JSON.stringify({error:msg}));
  else console.error(msg);
  process.exitCode = 1;
}
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
export async function run(source, argv, bin, {choicesFor} = {}) {
  let [command, ...args] = argv;
  if (!command || ['-h','--help','help'].includes(command)) {
    const help = Object.values(usage).map(s => '  '+bin+' '+s+' [--json]').join('\n');
    if (!command) return usageError(help);
    console.log(help);
    return;
  }
  if (!Object.hasOwn(usage,command)) return usageError('Unknown command: '+command,args.includes('--json'));
  if (args.includes('--help') || args.includes('-h')) { console.log('Usage: '+bin+' '+usage[command]+' [--json]'); return; }
  let v, words, origin, items;
  try {
    const options = {json:{type:'boolean'}};
    for (const f of flags[command]) options[f] = {type:['brazil','brand-only','all','expand'].includes(f)?'boolean':'string'};
    if(command==='plan') for(const f of ['quantity','sku','brand','generic','brand-only','include-generics']) options[f]={type:'string',multiple:true};
    args = args.flatMap((x,i) => ['--lat','--lon'].includes(x) && /^-\d/.test(args[i+1]) ? [x+'='+args[i+1]] :
      /^-\d/.test(x) && ['--lat','--lon'].includes(args[i-1]) ? [] : [x]);
    ({values:v,positionals:words} = parseArgs({args,allowPositionals:true,options}));
    if (command !== 'stores' && !words.length) throw Error(usage[command]);
    if (command === 'stock' || command === 'plan' || (command === 'stores' && (source.directoryScope==='near_origin' || v.cep || v.lat || v.lon))) origin=location(v);
    if (command === 'stores' && words.length) throw Error(usage.stores);
    if (command === 'compare' && [v.cep,v.lat,v.lon].some(x=>x!==undefined)) origin=location(v);
    if (v.store != null && (!origin || (v.store !== 'nearest' && (command !== 'compare' || !/^\d+$/.test(v.store)))))
      throw Error('--store nearest or an explicit comparison branch requires an origin');
    if (v.expand && (!origin || v.store)) throw Error('--expand requires an origin and a search across stores');
    if (command === 'stock' && (words.length!==1 || !/^\d+$/.test(words[0]) || (v.quantity != null && v['min-qty'] != null))) throw Error(usage.stock);
    if (command === 'stock') {
      if (v.all && (v.quantity != null || v['min-qty'] != null)) throw Error('--all cannot be combined with a minimum quantity');
      if (v['max-branches'] != null && (!v.cep || !positive(v['max-branches'],30) || Number(v['max-branches']) < 3))
        throw Error('--max-branches needs a CEP and an integer from 3 to 30');
    }
    if (command === 'product' && !words.every(x=>/^\d+$/.test(x))) throw Error(usage.product);
    if (command === 'gtin' && (words.length!==1 || !validGtin(words[0]))) throw Error(usage.gtin);
    if (!positive(v.page??1) || !positive(v.limit??1, ['search','snapshot'].includes(command)?1000:50) || (command==='stock' && !positive(v.quantity??v['min-qty']??1))) throw Error('Invalid page, limit or quantity');
    if (command==='plan') items=shoppingItems(words,v);
    if (command==='snapshot') {
      const [action, ...terms] = words;
      const offset = Number(v.offset ?? 0);
      if (!['collect','read','export'].includes(action) || (action !== 'collect' && terms.length !== 1) ||
          !Number.isSafeInteger(offset) || offset < 0) throw Error(usage.snapshot);
    }
  } catch(error) { return usageError(error.message, args.includes('--json')); }
  if (['search','compare','info','plan'].includes(command)) {
    const queries = command === 'plan' ? items.map(item => item.sku ?? item.query) :
      command === 'info' ? words : [words.join(' ')];
    const {names, pending} = await confirmCliNames(queries, {json:v.json, choicesFor, suggest:source.suggest?.bind(source), write:text => console.error(text)});
    if (pending) {
      if (v.json) {
        const result = command === 'search' ? [] : command === 'plan' ? {...pending, items, tables:[], plans:[]} :
          command === 'info' ? {...pending, results:[]} : {...pending, products:[]};
        console.log(JSON.stringify(result, null, 2));
      }
      process.exitCode=3;
      return;
    }
    if (command === 'plan') items = items.map((item, i) => item.sku ? item : {...item, query:names[i]});
    else words = names;
  }
  const query=words.join(' '), limit=Number(v.limit??20), columns=['sku','name','type','seller','currentPrice','inStock'];
  if (command==='plan') {
    let result=await planShoppingList(bin,source,items,origin,v.store,v.expand);
    if (result.coverage) {
      if (v.json) console.log(JSON.stringify(result,null,2));
      else {
        printPurchase(result);
        if (await acceptExpansion(result.coverage,true)) {
          result=await planShoppingList(bin,source,items,origin,undefined,true);
          printPurchase(result);
        }
      }
      process.exitCode=purchaseExitCode(result);
      return;
    }
    if(!v.json && result.fixedStore) printFixedStore(result.fixedStore);
    if(v.json) console.log(JSON.stringify(result,null,2));
    else if (result.pickupPlans?.plans.length) {
      const titles={both:'Menos lojas e menor preço estimado',fewest_stores:'Menos lojas',lowest_price:'Menor preço estimado'};
      const money=new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'});
      for (const plan of result.pickupPlans.plans) {
        const total=plan.totalBRL == null ? 'total a confirmar' : money.format(plan.totalBRL);
        const distance=plan.roundTripKm == null ? 'distância a confirmar' : plan.roundTripKm.toFixed(2)+' km de ida e volta em linha reta';
        console.log(titles[plan.objective]+' · '+total+' · '+distance);
        for (const [i,stop] of plan.stops.entries()) {
          console.log((i+1)+'. '+describePickupStop(stop));
          for (const p of stop.pickups) console.log('   '+p.packs+' × '+p.name);
        }
      }
      const difference=result.pickupPlans.comparison;
      if (difference) console.log(describePlanDifference(difference));
      console.log('Retirada confirmada para a quantidade pedida. Frete e taxas à parte.');
      if (result.pickupPlans.searchLimited || result.pickupPlans.lookupFailures.length) console.log('Comparação parcial entre as opções verificadas.');
    }
    else if (result.planningScope === 'one_pack_alternatives') {
      if (result.lowestPricedPickup) console.log('Menor preço com retirada confirmada:', result.lowestPricedPickup.name,
        '—', result.lowestPricedPickup.currentPrice.toLocaleString('pt-BR',{style:'currency',currency:'BRL'}));
      printQuotes(result.products);
    }
    else if(result.pendingBrands) console.log('Quer considerar genéricos para '+result.pendingBrands.join(', ')+'?');
    else {
      console.log(result.status);
      for(const table of result.tables??[]) { console.log(table.query); emit(table.choices,false,['name','type','currentPrice']); }
      if(result.items) printQuotes(result.items);
      if(result.commonPickupPoints?.length) console.table(result.commonPickupPoints);
      if(result.estimatedProductTotalBRL!=null) console.log('Subtotal estimado (BRL)',result.estimatedProductTotalBRL);
    }
    if(result.status!=='fulfillable' && result.pickupPlans?.status!=='complete') process.exitCode=result.status==='source_failed' || result.pending?.some(p=>p.status==='source_failed')?2:3;
    return;
  }
  if (command==='snapshot') {
    process.exitCode=await runSnapshotCommand(words,v,(queries,{maxItems})=>catalogSnapshot({retailer:bin,queries,maxItems},source,{background:false}));
    return;
  }
  if (command==='info') {
    // Preserve the original SKU-only response for existing callers.
    if (v.json && words.length===1 && /^\d+$/.test(words[0]) && !v.brazil) {
      const rows=await source.facts(words[0]);
      console.log(JSON.stringify(rows,null,2));
      if(!rows.length) process.exitCode=3;
      return;
    }
    const data=await catalogInfo({retailer:bin,queries:words,scope:v.brazil?'brazil':'catalog'},source);
    if (v.json) console.log(JSON.stringify(data,null,2));
    else for (const result of data.results) {
      console.log(result.query, result.status);
      console.table(result.products.map(p=>({name:p.name, strengths:p.strengths.join(', '),forms:p.forms.join(', '),prescription:p.prescriptionLabel.join(', ')||'não confirmado',retention:p.prescription.retained === null ? (p.retentionLabel.join(', ')||'não confirmado') : p.prescription.retained ? 'Sim' : 'Não',receituário:p.prescription.form||'não confirmado',norma:p.prescription.rule,source:p.source})));
      if(v.brazil) console.log(JSON.stringify(result.brazil??{status:'não confirmado'},null,2));
    }
    if(data.results.some(r=>['source_failed','partial'].includes(r.status)||r.nationalStatus==='source_failed')) process.exitCode=2;
    else if(data.results.some(r=>r.status!=='matches' && !r.brazil?.presentations?.length)) process.exitCode=3;
    return;
  }
  if (command==='compare') {
    const place=typeof origin==='string' ? {zipcode:origin} : {coordinates:origin};
    const args={retailer:bin,query,includeGenerics:!v['brand-only'],...place,store:v.store,expandSearch:v.expand};
    let result=await compareOffers(args,source);
    const inventory = result.purchase;
    if (inventory && (inventory.stockEvidence === 'retailer_branch_snapshot' || v.expand) &&
        (inventory.status === 'complete' || !hasPickupOffer(result))) {
      if (v.json) console.log(JSON.stringify(result,null,2));
      else {
        printPurchase(result.purchase);
        if (await acceptExpansion(result.purchase.coverage,true)) {
          result=await compareOffers({...args,expandSearch:true},source);
          printPurchase(result.purchase);
        }
      }
      process.exitCode=purchaseExitCode(result.purchase);
      return;
    }
    if(!v.json && result.fixedStore) printFixedStore(result.fixedStore);
    if(v.json) console.log(JSON.stringify(result,null,2));
    else {
      console.log(result.status);
      const rows=result.candidates??result.products??[];
      if(origin && result.stockEvidence) printQuotes(rows);
      else emit(rows,false,['sku','name','type','currentPrice']);
    }
    if(['source_failed','partial'].includes(result.status)) process.exitCode=2;
    else if(result.status!=='matches') process.exitCode=3;
    return;
  }
  if(command==='stores') {
    const stores=await source.stores(origin);
    if(v.json) console.log(JSON.stringify(stores,null,2));
    else console.table(stores.map(s=>({id:s.id,name:s.storeName,address:[s.address.street,s.address.number].filter(Boolean).join(', '),
      city:s.address.city,lat:s.address.latitude,lon:s.address.longitude,km:s.distanceKm,phone:s.phone,
      'Seg–sex':s.openingHours?.weekdays,'Sábado':s.openingHours?.saturday,'Domingo':s.openingHours?.sunday,
      'Feriados':s.openingHours?.holidays ?? (s.opensOnHolidays === true ? 'Abre (horário não informado)' : undefined)})));
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
    else emit(slots.flatMap((slot,i)=>slot?.map(row=>({...row,type:catalogType(row)}))??[{sku:words[i],name:'not found'}]),false,columns);
    if(slots.includes(null)) process.exitCode=3;
    return;
  }
  let rows;
  if(command==='search') {
    const page = Number(v.page ?? 1);
    if (source.byGtin && query.trim().includes(' ') && requestsDrops(query)) {
      const result = await retailerComparison({retailer:bin, query, includeGenerics:false}, source);
      rows = (result.candidates ?? result.products ?? []).slice((page - 1) * limit, page * limit);
    } else {
      rows = await (source.searchCatalog ?? source.search).call(source, query, page, limit);
    }
    if (!rows.length && Number(v.page??1)===1) {
      try { const terms=(await source.suggest?.(query)??[]).filter(s=>s.toLowerCase()!==query.toLowerCase()); if(terms.length) console.error('Você quis dizer '+terms[0]+'?'); }
      catch(error) { console.error('Sugestões indisponíveis. '+error.message); }
    }
  } else if(command==='gtin') rows=await source.byGtin(query);
  else {
    rows=await source.product(query);
    if(command==='stock') {
      const minimum = Number(v.quantity ?? v['min-qty'] ?? 1);
      const physicalOnly = Boolean(v.all || v.expand || v['max-branches'] != null);
      const config = inventoryConfig(bin);
      let inventory;
      if ((config || physicalOnly) && rows.length) {
        inventory = config
          ? await lookupBranchStock(bin, source, origin, query, config, {
              minimum, maxBranches:Number(v['max-branches'] ?? 30), includeAll:v.all, expand:v.expand,
            })
          : {retailer:bin, sku:query, status:'unknown', evidence:'no_branch_inventory_source', stores:[]};
      }
      if (physicalOnly) {
        const result = inventory ?? {retailer:bin, sku:query, status:'product_not_found', stores:[]};
        if (v.json) console.log(JSON.stringify(result,null,2));
        else printInventory(result);
        if (result.status !== 'available') process.exitCode = result.status === 'unknown' ? 2 : 3;
        return;
      }
      const local=[];
      for(const row of rows) {
        const quote = await source.local(row,origin,minimum);
        local.push(inventory ? {...quote, branchInventory:inventory} : quote);
      }
      rows=local;
      if (!v.json && inventory) printInventory(inventory);
    }
  }
  if(command==='stock' && !v.json) printQuotes(rows);
  else emit(v.json?rows:rows.map(row=>({...row,type:catalogType(row)})),v.json,columns);
  if (!rows.length && command!=='search') process.exitCode=3;
  if (command==='stock' && rows.length && rows.every(row=>row.localStatus==='unavailable')) {
    const physicalStatus = rows[0].branchInventory?.status;
    if (physicalStatus==='unknown') process.exitCode=2;
    else if (physicalStatus!=='available') process.exitCode=3;
  }
}

function printFixedStore({branch,status}) {
  if (!branch) return console.log(status === 'directory_failed' ? 'Falha ao consultar o diretório de lojas.' : 'A filial não pôde ser identificada.');
  console.log([branch.storeName,branch.address?.street,branch.address?.number].filter(Boolean).join(' · '));
}

function printQuotes(rows) {
  console.table(rows.map(row=>({
    Medicamento:row.name, Tipo:row.type??catalogType(row), Preço:row.currentPrice,
    'Origem do preço':row.priceScope, Atendimento:row.pickupAtStore ? ({
      offered:'Retirada oferecida nesta loja',not_offered:'Sem oferta de retirada nesta loja',
      unconfirmed:'Retirada não confirmada',lookup_failed:'Falha na consulta'})[row.pickupAtStore] : row.localStatus,
    'Qtd. solicitada':row.requestedQuantity, 'Retirada ofertada':row.methods?.filter(m=>m.channel==='pickup-in-point').map(m=>m.branch||m.pickupPointId).join(', ')||'—',
  })));
}

function printInventory(result) {
  if (result.evidence === 'no_branch_inventory_source') {
    console.log('Quantidade por filial não confirmada. Nenhum arquivo de estoque foi configurado para esta rede.');
    return;
  }
  if (result.status === 'product_not_found') { console.log('Produto não encontrado.'); return; }
  const coverage = result.coverage;
  console.log('Estoque por filial no arquivo de',result.snapshotAt);
  console.log('Lojas do localizador consultadas:',coverage.checkedStores,'| Alcance (km):',coverage.radiusKm ?? 'desconhecido');
  if (coverage.unknownStores || coverage.unknownDistanceStores)
    console.log('Estoque desconhecido:',coverage.unknownStores,'| Lojas sem distância:',coverage.unknownDistanceStores);
  console.table(result.stores.map(s=>({Filial:s.name,'Distância (km)':s.distanceKm,
    Quantidade:s.quantity ?? 'não confirmada',Telefone:s.phone ?? '—',Atualizado:s.observedAt ?? '—'})));
  if (coverage.canExpand) console.log('Quer ampliar a busca para até 25 km?');
  if (result.advice) console.log(result.advice);
}

function printPurchase(result) {
  if (result.snapshotAt) console.log('Inventário por filial atualizado em',result.snapshotAt);
  else if (result.stockEvidence==='no_branch_inventory_source') console.log('Estoque físico desconhecido. A rede não forneceu inventário por filial.');
  if (result.fixedBranchId) console.log('Filial mais próxima do localizador:',result.fixedBranchId);
  process.stdout.write(renderPurchase(result));
}
