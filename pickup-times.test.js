import assert from 'node:assert/strict';
import test from 'node:test';
import { createRetailer } from './vtex.js';
import { lookupPickupStores, stores } from './directory.js';

const id = 'paguemenos00001_example', other = 'paguemenos00002_another';
const eta = '2026-01-10T08:00:00-03:00';
const hours = [{DayOfWeek:6, OpeningTime:'07:00:00', ClosingTime:'22:00:00'}];
const method = {deliveryChannel:'pickup-in-point', pickupPointId:id, shippingEstimate:'4h', shippingEstimateDate:eta};
const offer = {sku:'5',sellerId:'1'};
const origin = {latitude:0,longitude:0};
const branch = {cod_loja:1,bandeira:'EXTRAFARMA',nome_loja:'Unidade Exemplo',seg_a_sex:'07:00 AS 23:00',sabado:'07:00 AS 23:00',horas_24:'NÃO'};
const directory = async () => Response.json({sortedStores:[branch,{...branch,cod_loja:2,bandeira:'PAGUE MENOS',horas_24:'SIM'}]});

test('only quoted pickup IDs can add an affiliated location; storefront hours differ from pickup hours and ETA', async () => {
  const lookup = lookupPickupStores(directory);
  const catalog = await stores(origin,directory);
  assert.deepEqual(catalog.map(row=>row.id),['2']);
  assert.equal(catalog[0].hours.open24Hours,true);
  const data={items:[{id:'5',seller:'1',quantity:1,availability:'available'}],
    logisticsInfo:[{itemIndex:0,slas:[method,{deliveryChannel:'delivery',shippingEstimate:'1bd'}]}],
    pickupPoints:[{id:other, businessHours:[]},{id,businessHours:hours}]};
  const source=createRetailer({name:'Test',site:'https://example.test', pickupStores:lookup},async()=>Response.json(data));
  const [pickup,delivery]=(await source.local(offer,origin)).methods;
  assert.equal(pickup.shippingEstimateDate,eta);
  assert.equal(pickup.shippingEstimate,'4h');
  assert.deepEqual(pickup.pickupHours,[{dayOfWeek:6,opens:'07:00:00',closes:'22:00:00'}]);
  assert.equal(pickup.directoryStore.banner,'EXTRAFARMA');
  assert.equal(pickup.directoryStore.hours.saturday,'07:00 AS 23:00');
  assert.equal(pickup.directoryStore.hours.open24Hours,false);
  assert.equal(delivery.pickupHours,undefined);
  assert.equal(delivery.shippingEstimateDate,null);
  assert.equal(delivery.shippingEstimate,'1bd');
});

test('unknown hours, unknown timestamps and directory failure preserve a valid pickup offer', async () => {
  const data={items:[{id:'5',seller:'1',quantity:1,availability:'available'}],
    logisticsInfo:[{itemIndex:0,slas:[{...method,shippingEstimateDate:'sem data',shippingEstimate:null}]}],
    pickupPoints:[{id:other,businessHours:hours}]};
  const source=createRetailer({name:'Test',site:'https://example.test',pickupStores:lookupPickupStores(async()=>{throw Error('offline');})},async()=>Response.json(data));
  const quote=await source.local(offer,origin);
  assert.equal(quote.localStatus,'available');
  assert.equal(quote.methods[0].pickupHours,null);
  assert.equal(quote.methods[0].shippingEstimateDate,null);
  assert.equal(quote.methods[0].directoryStore,undefined);
});
