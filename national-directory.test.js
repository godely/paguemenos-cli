import test from 'node:test';
import assert from 'node:assert/strict';
import {collectDirectory,coverSeats} from './scripts/collect-directory.mjs';
import {nationalDirectory,stores} from './directory.js';

const a = {id:'1',state:'DF',latitude:-15,longitude:-48};
const b = {id:'2',state:'GO',latitude:-17,longitude:-48};
const seatNearby = {id:'3',state:'GO',latitude:-15.01,longitude:-48};
const raw = {cod_loja:12,bandeira:'PAGUE MENOS',status:'ATIVA',nome_loja:'Centro',uf:'GO',cidade:'Exemplo',
  latitude_loja:-16,longitude:-48,distancia_usuario:111.2,seg_a_sex:'08h-22h'};

test('overlapping windows count a published active branch once without inheriting a municipal distance',async()=>{
  assert.equal(coverSeats([a,seatNearby,b]).centers.length,2);
  const seen=[];
  const survey=await collectDirectory([a,seatNearby,b],async url=>{
    seen.push(url);
    return Response.json([raw,{...raw,cod_loja:'13',bandeira:'EXTRAFARMA'},
      {...raw,cod_loja:'14',status:'INATIVA'}]);
  },async()=>{});
  assert.equal(seen.length,2);
  assert.ok(seen.every(url=>url.searchParams.get('range')==='300'));
  assert.equal(survey.coverage.complete,null);
  assert.equal(survey.coverage.observations,2);
  assert.equal(survey.coverage.uniqueStores,1);
  assert.ok(survey.coverage.farthestSeatKm<2);
  assert.equal(survey.stores[0].distanceKm,null);
  assert.equal(survey.stores[0].openingHours.weekdays,raw.seg_a_sex);
});

test('204 is an observed empty window; source errors, bad distances and inconsistent branch identities fail the build',async()=>{
  const collect = read => collectDirectory([a,b],read,async()=>{});
  const empty=await collect(async()=>new Response(null,{status:204}));
  assert.equal(empty.coverage.emptyWindows,2);
  await assert.rejects(collect(async()=>Response.json([],{status:503})),/Invalid store locator/);
  await assert.rejects(collect(async()=>Response.json([{...raw,distancia_usuario:1000}])),/does not corroborate/);
  let count=0;
  await assert.rejects(collect(async()=>Response.json([{...raw,cidade:count++ ? 'Outro':'Centro'}])),/Conflicting branch/);
});

test('packaged national directory covers all UFs and carries observation times without stock claims',async()=>{
  const directory=await nationalDirectory();
  const rows=await stores(undefined,()=>assert.fail('A national page should not start a local lookup'));
  assert.equal(directory.coverage.states,27);
  assert.equal(directory.coverage.complete,null);
  assert.equal(rows.length,new Set(rows.map(s=>s.id)).size);
  assert.equal(rows.length,directory.coverage.uniqueStores);
  assert.ok(rows.every(s=>s.directoryObservedAt===directory.observedAt && s.status==='ATIVA'
    && s.distanceKm===null && !('quantity' in s) && !('email' in s)));
});
