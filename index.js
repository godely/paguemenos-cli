import { withBrandPacks } from 'drogasil-cli/retailer-workflows';
import { nationalDirectory, stores } from './directory.js';
import { descriptionEvidence } from './composition.js';
import { createRetailer } from './vtex.js';
export { searchVerifiedCatalog } from './search.js';
import { prepareSearch, suggest, searchVerifiedCatalog } from './search.js';

const site = 'https://www.paguemenos.com.br';
export const retailer = withBrandPacks({
  stores, nationalDirectory, directoryScope: 'national_observed',
  ...createRetailer({ name: 'Pague Menos', site, prepareSearch, compositionEvidence:descriptionEvidence }),
  searchCatalog(query, page, limit) { return searchVerifiedCatalog(this, query, page, limit); },
  suggest: (prefix, limit) => suggest(site, prefix, limit),
});
