import { stores } from './directory.js';
import { createRetailer } from './vtex.js';
export { searchVerifiedCatalog } from './search.js';
import { prepareSearch, suggest, searchVerifiedCatalog } from './search.js';

const site = 'https://www.paguemenos.com.br';
export const retailer = {
  stores, directoryScope: 'near_origin',
  ...createRetailer({ name: 'Pague Menos', site, prepareSearch }),
  searchCatalog(query, page, limit) { return searchVerifiedCatalog(this, query, page, limit); },
  suggest: (prefix, limit) => suggest(site, prefix, limit),
};
