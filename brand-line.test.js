import assert from 'node:assert/strict';
import test from 'node:test';
import {matchesRequestedBrand} from './partner-plan.js';

test('a shopper can say the brand and product line together',()=>{
  const p={brand:'Marca',name:'Solução fisiológica Marca Linha Plus 100 ml'};
  for(const name of ['Marca','Marca Linha','MÁRCA LINHA PLUS']) assert.equal(matchesRequestedBrand(p,name),true);
  for(const name of ['Mar','Linha Plus','Marca Linha Forte','Outra Marca']) assert.equal(matchesRequestedBrand(p,name),false);
  assert.equal(matchesRequestedBrand({...p,brand:'Outra'},'Marca Linha'),false);
});
