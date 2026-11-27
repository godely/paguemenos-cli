import { createRetailer } from './vtex.js';
import { prepareSearch, suggest } from './search.js';

const site = 'https://www.paguemenos.com.br';
export const retailer = {
  ...createRetailer({ name: 'Pague Menos', site, prepareSearch }),
  suggest: (prefix, limit) => suggest(site, prefix, limit),
};
