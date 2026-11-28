import { withBrandPacks } from 'drogasil-cli/retailer-workflows';
import { stores } from './directory.js';
import { createRetailer } from './vtex.js';
import { prepareSearch, suggest } from './search.js';

const site = 'https://www.paguemenos.com.br';
export const retailer = withBrandPacks({
  stores, directoryScope: 'near_origin',
  ...createRetailer({ name: 'Pague Menos', site, prepareSearch }),
  suggest: (prefix, limit) => suggest(site, prefix, limit),
});
