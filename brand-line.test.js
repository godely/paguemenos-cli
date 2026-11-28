import assert from 'node:assert/strict';
import test from 'node:test';
import {matchesRequestedBrand} from './partner-plan.js';


test('an abbreviated manufacturer must identify one documented generic brand in the presentation', async()=>{
  const {selectBrandOptions}=await import('./partner-plan.js');
  const prati={name:'Paracetamol 750 mg Genérico Prati-Donaduzzi',brand:'Prati Donaduzzi',type:'Genérico',role:'requested'};
  const other={...prati,brand:'Acme',name:'Paracetamol Genérico Acme',role:'generic'};
  assert.deepEqual(selectBrandOptions([prati,other],'Prati',false).products,[prati]);
  assert.deepEqual(selectBrandOptions([prati,other],'Prati',true).products,[prati,other]);
  for (const p of [{...prati,name:'Paracetamol genérico de outro fabricante'},
      {...prati,type:'Não informado'},{...prati,brand:'Pratissimo Donaduzzi'}]) {
    assert.deepEqual(selectBrandOptions([p],'Prati',false).products,[]);
  }
  assert.deepEqual(selectBrandOptions([prati],'Prat',false).products,[]);
  const namesake={...prati,name:'Paracetamol genérico Prati Dois',brand:'Prati Dois'};
  const ambiguity=selectBrandOptions([prati,namesake],'Prati',false);
  assert.equal(ambiguity.needsBrandChoice,true); assert.deepEqual(ambiguity.products,[]);
});

test('a shopper can say the brand and product line together',()=>{
  const p={brand:'Marca',name:'Solução fisiológica Marca Linha Plus 100 ml'};
  for(const name of ['Marca','Marca Linha','MÁRCA LINHA PLUS']) assert.equal(matchesRequestedBrand(p,name),true);
  for(const name of ['Mar','Linha Plus','Marca Linha Forte','Outra Marca']) assert.equal(matchesRequestedBrand(p,name),false);
  assert.equal(matchesRequestedBrand({...p,brand:'Outra'},'Marca Linha'),false);
});
