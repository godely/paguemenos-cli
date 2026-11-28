// Maintenance command. Only the store locator is queried; the inputs are public municipal seats.
import { setTimeout as delay } from 'node:timers/promises';
import { gzipSync } from 'node:zlib';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { directoryBranches } from '../directory.js';

const seatsUrl = 'https://geo.infrasa.gov.br/server/rest/services/Hosted/Sede_Municipal/FeatureServer/0';
const locator = 'https://www.paguemenos.com.br/nossas-lojas';
const rangeKm = 300;
const seatRadiusKm = 200;

function km(a,b) {
  const rad = Math.PI / 180;
  const h = Math.sin((b.latitude-a.latitude)*rad/2)**2 +
    Math.cos(a.latitude*rad)*Math.cos(b.latitude*rad)*Math.sin((b.longitude-a.longitude)*rad/2)**2;
  return 12742*Math.asin(Math.sqrt(Math.min(1,h)));
}

export function coverSeats(seats) {
  const remaining = seats.map(seat => ({seat, nearest:Infinity}));
  const centers = [];
  let next = seats.find(s=>s.id==='5300108') ?? seats[0];
  let farthestKm = 0;
  while (next) {
    centers.push(next);
    const center = next;
    next = undefined;
    farthestKm = 0;
    for (const entry of remaining) {
      entry.nearest = Math.min(entry.nearest, km(entry.seat,center));
      if (entry.nearest > farthestKm) {
        farthestKm = entry.nearest;
        next = entry.seat;
      }
    }
    if (farthestKm <= seatRadiusKm) break;
  }
  return {centers,farthestKm};
}

async function fetchPage(url) {
  for (let attempt=1; ; attempt++) {
    let response;
    try {
      response = await fetch(url,{signal:AbortSignal.timeout(30000)});
    } catch (error) {
      if (attempt >= 3) throw error;
    }
    if (response?.ok) return response;
    if (response && (response.status < 500 && response.status !== 429 || attempt >= 3))
      throw Error('Directory source HTTP '+response.status+' at '+url.hostname);
    const retry = response?.headers.get('retry-after');
    await response?.body?.cancel();
    const seconds = retry && /^\d+$/.test(retry) ? Number(retry) : 2**attempt;
    if (seconds > 60) throw Error('Directory source asked to retry later');
    await delay(seconds*1000);
  }
}

async function municipalSeats() {
  const seats = new Map();
  for (let offset = 0; ; offset += 2000) {
    const url = new URL(seatsUrl+'/query');
    url.search = new URLSearchParams({where:'1=1', outFields:'geocodigo_,uf', outSR:'4326', f:'json',
      orderByFields:'objectid', resultOffset:String(offset), resultRecordCount:'2000'});
    const page = await (await fetchPage(url)).json();
    if (!Array.isArray(page.features)) throw Error('Invalid municipal seat response');
    const countBefore = seats.size;
    for (const {attributes,geometry} of page.features) {
      const id=String(attributes.geocodigo_), state=attributes.uf;
      if (!/^\d{7}$/.test(id) || !/^[A-Z]{2}$/.test(state) ||
          !Number.isFinite(geometry?.y) || !Number.isFinite(geometry?.x)) throw Error('Invalid municipal seat');
      const previous = seats.get(id);
      if (previous && (previous.latitude !== geometry.y || previous.longitude !== geometry.x || previous.state !== state))
        throw Error('Conflicting municipal seat locations for '+id);
      seats.set(id,{id,state,latitude:geometry.y,longitude:geometry.x});
    }
    if (!page.exceededTransferLimit) break;
    if (seats.size === countBefore) throw Error('Truncated municipal seat page yielded no new seats');
  }
  if (new Set([...seats.values()].map(s=>s.state)).size !== 27) throw Error('Missing states in municipal seat source');
  return [...seats.values()].sort((a,b)=>a.id.localeCompare(b.id));
}

export async function collectDirectory(seats, read, wait = () => delay(550)) {
  const {centers,farthestKm} = coverSeats(seats);
  const startedAt = new Date().toISOString();
  const stores = new Map();
  let observations = 0, emptyWindows = 0;
  for (const center of centers) {
    const pair = center.latitude.toFixed(5)+','+center.longitude.toFixed(5);
    const url = new URL('/_v/get-store-base-by-address/'+encodeURIComponent(pair)+'/', locator);
    url.searchParams.set('range',String(rangeKm));
    const response = await read(url);
    const rows = response.status === 204 ? [] : await response.json();
    if (!response.ok || !Array.isArray(rows)) throw Error('Invalid store locator window for '+center.id);
    if (!rows.length) emptyWindows++;
    const activeRows = rows.filter(row => String(row.status ?? '').trim().toUpperCase() === 'ATIVA');
    for (const branch of directoryBranches(activeRows)) {
      const address = branch.address;
      if (!/^[A-Z]{2}$/.test(address.state ?? '') || !branch.storeName)
        throw Error('Missing store identity for '+branch.id);
      if (address.latitude != null && address.longitude != null && branch.distanceKm != null &&
          Math.abs(km(center,address) - branch.distanceKm) > 5)
        throw Error('Locator distance does not corroborate municipal origin '+center.id+' for branch '+branch.id);
      observations++;
      const prior = stores.get(branch.id);
      if (prior && (prior.address.state !== address.state || prior.address.city !== address.city))
        throw Error('Conflicting branch identity for '+branch.id);
      if (!prior) stores.set(branch.id,{...branch,distanceKm:null});
    }
    await wait();
  }
  const branches = [...stores.values()].sort((a,b)=>a.id.localeCompare(b.id,'en',{numeric:true}));
  return {source:locator, observedFrom:startedAt, observedAt:new Date().toISOString(),
    coverage:{scope:'national_observed', complete:null, municipalSource:seatsUrl, seats:seats.length, windows:centers.length,
      rangeKm, farthestSeatKm:Number(farthestKm.toFixed(2)), emptyWindows, states:new Set(branches.map(b=>b.address.state)).size,
      observations, uniqueStores:branches.length}, stores:branches};
}

async function main() {
  const output = process.argv[2];
  if (!output) throw Error('Supply an output .json.gz file');
  const data = await collectDirectory(await municipalSeats(),fetchPage);
  if (data.coverage.states !== 27) throw Error('National collection did not return stores from all states');
  await mkdir(dirname(output),{recursive:true});
  const temporary = join(dirname(output),'.'+basename(output)+'.'+randomUUID());
  try {
    await writeFile(temporary,gzipSync(JSON.stringify(data)+'\n',{level:9}),{flag:'wx'});
    await rename(temporary,output);
  } finally { await rm(temporary,{force:true}); }
  console.log(JSON.stringify(data.coverage));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error=>{console.error(error.message);process.exitCode=1;});
}
