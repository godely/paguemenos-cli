import { stores, lookupPickupStores } from './directory.js';
import { createRetailer } from './vtex.js';
import { prepareSearch, suggest } from './search.js';

const site = 'https://www.paguemenos.com.br';
export const retailer = {
  stores, directoryScope: 'near_origin',
  ...createRetailer({ name: 'Pague Menos', site, prepareSearch, pickupStores: lookupPickupStores() }),
  suggest: (prefix, limit) => suggest(site, prefix, limit),
};
