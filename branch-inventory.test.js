import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {branchStock, inventoryConfig, loadObservations} from './branch-inventory.js';
import {stores} from './directory.js';

const dir = fileURLToPath(new URL('.', import.meta.url));
const now = Date.parse('2026-01-15T10:00:00Z');
const timestamp = '2026-01-15T09:55:00Z';
const config = {now, maxAgeMs:600000, maxBranches:3};
const directory = Array.from({length:37}, (_,i) => ({id:String(i+1), storeName:'Filial '+(i+1),
  distanceKm:i, phone:i===3?'11 12345678':null})).reverse();
const feed = {snapshotAt:timestamp, observations:directory.map(s=>({storeId:s.id, quantity:s.distanceKm<3?0:2, observedAt:timestamp}))};
function stock(options={}, data=feed, branches=directory) {
  return branchStock('paguemenos','42',branches,data,{...config,...options});
}

test('nearest window counts unique stores and expands only after explicit fresh zeros',()=>{
  const near=stock({includeAll:true},feed,[...directory,directory.at(-1)]);
  assert.deepEqual(near.stores.map(s=>s.quantity),[0,0,0]);
  assert.deepEqual([near.status,near.coverage.checkedStores,near.coverage.radiusKm,near.coverage.canExpand],['unavailable',3,2,true]);
  const far=stock({expand:true});
  assert.equal(far.totalStockedStores,23);
  assert.deepEqual(far.stores.map(s=>s.distanceKm),Array.from({length:10},(_,i)=>i+3));
  assert.equal(far.stores[0].phone,'11 12345678');
  assert.equal(far.coverage.checkedStores,26);
  assert.equal(far.coverage.radiusKm,25);
  assert.match(far.advice,/Ligue/);
  const insufficient={...feed, observations:feed.observations.map(r=>r.storeId==='1'?{...r,quantity:1}:r)};
  assert.equal(stock({expand:true,minimum:2},insufficient).expanded,false);
  assert.equal(stock({expand:true},insufficient).stores[0].id,'1');
});

test('missing, blank and stale quantities and unknown distances cannot trigger expansion',()=>{
  const observations=feed.observations.filter(r=>r.storeId!=='1').map(r=> r.storeId==='2' ? {...r,quantity:null} :
    r.storeId==='3' ? {...r,observedAt:'2026-01-14T09:55:00Z'} : r);
  const result=stock({includeAll:true,expand:true},{...feed,observations});
  assert.equal(result.status,'unknown');
  assert.deepEqual(result.stores.map(r=>r.status),['missing','unknown','stale']);
  assert.deepEqual(result.stores.map(r=>r.quantity),[null,null,null]);
  assert.equal(result.expanded,false);
  assert.equal(stock({},feed,[...directory,{id:'x',distanceKm:null}]).coverage.canExpand,false);
  assert.equal(stock({},feed,[]).status,'unknown');
});

test('public locator preserves distance, store hours and a dialable fallback for both routes',async()=>{
  const base={bandeira:'PAGUE MENOS',nome_loja:'Centro',ddd:'81',celular_loja:'999998888',seg_a_sex:'07:00 AS 23:00'};
  const data=[{...base,cod_loja:3,distancia_usuario:''},{...base,cod_loja:1,distancia_usuario:'3.6'},
    {...base,cod_loja:1,distancia_usuario:'0.8'},{...base,cod_loja:2,status:'INATIVA'},
    {...base,cod_loja:4,bandeira:'EXTRAFARMA'}];
  for(const origin of ['01001000',{latitude:-20,longitude:-40}]) {
    const result=await stores(origin,async()=>Response.json(typeof origin==='string'?data:{sortedStores:data}));
    assert.deepEqual(result.map(s=>[s.id,s.distanceKm]),[['1',0.8],['3',null]]);
    assert.equal(result[0].phone,'81 999998888'); assert.equal(result[0].hours.weekdays,'07:00 AS 23:00');
  }
});

test('imports are isolated by retailer, indexed by literal SKU and replaced atomically',async t=>{
  const folder=await mkdtemp(join(tmpdir(),'branch-stock-'));
  t.after(()=>rm(folder,{recursive:true,force:true}));
  const path=join(folder,'rows.csv'), database=join(folder,'stock.db');
  const header='retailer,id,store_code,quantity,timestamp\n';
  async function install(retailer,rows,asOf='2026-01-15T10:00:00Z') {
    await writeFile(path,header+rows.replace(/^(.+)$/gm,retailer+',$1'));
    return execFileSync('python3',['branch_inventory.py','import','--database',database,'--retailer',retailer,'--snapshot-at',asOf,path],{cwd:dir,stdio:'pipe'});
  }
  const row=(sku,id,q)=>[sku,id,q,timestamp].join(',')+'\n';
  const pm='paguemenos', dsp='drogariasaopaulo';
  const initial=row('0042','001',0)+row('0042','002',7);
  await install(pm,initial); await install(pm,initial);
  await install(dsp,row('0042','001',3));
  for (const [data,asOf] of [[row('0042','001',4),'2026-01-15T10:00:00Z'],[initial,'2026-01-15T09:58:00Z'],
    [initial+row('0042','001',9),'2026-01-15T10:01:00Z'],[row('0042','001',-1),'2026-01-15T10:01:00Z'],
    [row('0042','001','3.5'),'2026-01-15T10:01:00Z']]) await assert.rejects(install(pm,data,asOf));
  const quantities=async(retailer,sku)=>(await loadObservations(retailer,database,sku)).observations.map(r=>[r.storeId,r.quantity]);
  assert.deepEqual(await quantities(pm,'0042'),[['001',0],['002',7]]);
  assert.deepEqual(await quantities(pm,'42'),[]);
  assert.deepEqual(await quantities(dsp,'0042'),[['001',3]]);
  await install(pm,row('0042','001',''),'2026-01-15T10:01:00Z');
  assert.deepEqual(await quantities(pm,'0042'),[['001',null]]);
  assert.deepEqual(await quantities(dsp,'0042'),[['001',3]]);
  assert.throws(()=>inventoryConfig(pm,{PAGUEMENOS_BRANCH_STOCK_DB:database}));
  assert.equal(inventoryConfig(pm,{}),null);

  const code = `import {run} from './runner.js';
    const source={product:async sku=>[{sku,name:'Example'}], stores:async()=>[{id:'001',distanceKm:1,storeName:'Example'}],
      local:async()=>({localStatus:'available'})};
    await run(source,JSON.parse(process.argv[1]),process.argv[2]);`;
  function cli(retailer,args,configured) {
    const env={...process.env};
    for (const name of [pm,dsp]) for (const suffix of ['DB','MAX_AGE_MINUTES']) delete env[name.toUpperCase()+'_BRANCH_STOCK_'+suffix];
    if (configured) Object.assign(env,{[retailer.toUpperCase()+'_BRANCH_STOCK_DB']:database,
      [retailer.toUpperCase()+'_BRANCH_STOCK_MAX_AGE_MINUTES']:'52560000'});
    return spawnSync(process.execPath,['--input-type=module','-e',code,JSON.stringify(args),retailer],{cwd:dir,env,encoding:'utf8'});
  }
  const args=['stock','0042','--cep','01001000','--all','--json'];
  const found=cli(dsp,args,true);
  assert.equal(found.status,0,found.stderr);
  assert.equal(JSON.parse(found.stdout).stores[0].quantity,3);
  assert.equal(cli(pm,args,true).status,2);
  const missing=cli(pm,args,false);
  assert.equal(missing.status,2); assert.equal(JSON.parse(missing.stdout).evidence,'no_branch_inventory_source');
  assert.equal(cli(dsp,[...args,'--min-qty','1'],true).status,1);
  assert.equal(cli(dsp,['stock','0042','--lat','1','--lon','2','--max-branches','3'],true).status,1);
  const oldShape=cli(pm,['stock','0042','--cep','01001000','--json'],false);
  assert.deepEqual(JSON.parse(oldShape.stdout),[{localStatus:'available'}]);
});
