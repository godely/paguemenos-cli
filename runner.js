import { parseArgs } from 'node:util';

export async function run(retailer, argv, bin) {
  const help = 'Usage: ' + bin + ' search <text> [--page N --limit N]' +
    (retailer.suggest ? ' | suggest <prefix> [--limit N]' : '') +
    ' | product <SKU> | info <SKU> | gtin <EAN> | stock <SKU> --cep CEP [--quantity N] [--json]';
  if (!argv.length || argv.includes('--help')) { console.log(help); return; }
  const { values, positionals: [command, ...words] } = parseArgs({ args: argv, allowPositionals: true, options: {
    cep: { type: 'string' }, quantity: { type: 'string', default: '1' }, page: { type: 'string', default: '1' },
    limit: { type: 'string' }, json: { type: 'boolean' },
  } });
  const query = words.join(' ').trim();
  if (!query) throw new Error(help);
  if (command === 'suggest' && retailer.suggest) {
    const terms = await retailer.suggest(query, Number(values.limit ?? 7));
    console.log(values.json ? JSON.stringify(terms, null, 2) : terms.join('\n') || 'Nenhuma sugestão.');
    if (!terms.length) process.exitCode = 3;
    return;
  }
  let rows;
  if (command === 'search') {
    rows = await retailer.search(query, Number(values.page), Number(values.limit ?? 20));
    if (retailer.suggest && !rows.length && Number(values.page) === 1) {
      try {
        const alternatives = (await retailer.suggest(query)).filter(term => term.toLowerCase() !== query.toLowerCase());
        if (alternatives.length) console.error('Você quis dizer ' + alternatives[0] + '?');
      } catch (error) {
        console.error('Sugestões indisponíveis. ' + error.message);
      }
    }
  } else if (command === 'gtin') rows = await retailer.byGtin(query);
  else if (['product', 'info', 'stock'].includes(command)) {
    rows = await retailer.product(query);
    if (command === 'stock') {
      if (!values.cep) throw new Error('Supply --cep for a location check');
      const local = [];
      for (const row of rows) local.push(await retailer.local(row, values.cep, Number(values.quantity)));
      rows = local;
    }
  } else throw new Error(help);
  if (values.json || command === 'info' || command === 'stock') console.log(JSON.stringify(rows, null, 2));
  else if (command === 'search' && retailer.suggest && !rows.length) console.log('Nenhum produto confirmado nesta página.');
  else console.table(rows.map(({ sku, name, seller, currentPrice, inStock }) => ({ sku, name, seller, currentPrice, inStock })));
  if (!rows.length) process.exitCode = 3;
}
