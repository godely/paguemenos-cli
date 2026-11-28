import { checkoutOrigin } from './location.js';
const cents = value => Number.isSafeInteger(value) && value >= 0 ? value / 100 : null;
const price = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

export function validGtin(code) {
  if (!/^(?:\d{8}|\d{12,14})$/.test(code) || /^0+$/.test(code)) return false;
  const digits = [...code].reverse().map(Number);
  return digits.reduce((sum, n, i) => sum + n * (i % 2 ? 3 : 1), 0) % 10 === 0;
}

export function createRetailer({ name, site, prepareSearch }, request = fetch) {
  async function getResponse(path, options = {}) {
    const response = await request(new URL(path, site), { ...options, signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(name + ' HTTP ' + response.status);
    return response;
  }

  function checkPage(page, limit, maximum=50) {
    if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > maximum) {
      throw new TypeError('page must be positive and limit must be 1 to '+maximum);
    }
  }

  async function catalogPage(params, page, limit) {
    checkPage(page, limit);
    const start = (page - 1) * limit;
    const query = new URLSearchParams({
      ...params, _from: String(start), _to: String(start + limit - 1),
    }).toString().replaceAll('+', '%20');
    const response = await getResponse('/api/catalog_system/pub/products/search?' + query);
    const data = await response.json();
    if (!Array.isArray(data)) throw new Error('Unexpected catalog response');
    const range = /^(\d+)-\d+\/(\d+)$/.exec(response.headers.get('resources') ?? '');
    if (range && Number(range[1]) !== start) throw new Error('Unexpected catalog result range');
    const finished = data.length < limit || (range !== null && start + data.length >= Number(range[2]));
    return { products: data, finished };
  }

  function offers(product) {
    return product.items.flatMap(item => item.sellers.map(seller => {
      const offer = seller.commertialOffer ?? {};
      const facts = Object.fromEntries((product.allSpecifications ?? []).map(key => [key, product[key]]));
      return { retailer: name, sku: String(item.itemId), gtin: validGtin(String(item.ean)) ? String(item.ean) : null,
        name: item.nameComplete || item.name, itemName: item.name, brand: product.brand, productUrl: product.link,
        sellerId: String(seller.sellerId), seller: seller.sellerName, currency: 'BRL', currentPrice: offer.IsAvailable === false && offer.Price === 0 ? null : price(offer.Price),
        listPrice: offer.IsAvailable === false && offer.ListPrice === 0 ? null : price(offer.ListPrice), inStock: typeof offer.IsAvailable === 'boolean' ? offer.IsAvailable : null,
        priceScope: 'anonymous_online', observedAt: new Date().toISOString(), facts };
    }));
  }

  async function catalog(params, page = 1, limit = 20) {
    const { products } = await catalogPage(params, page, limit);
    return products.flatMap(offers);
  }

  async function search(query, page = 1, limit = 20) {
    checkPage(page, limit, 1000);
    if (!prepareSearch && limit<=50) return catalog({ ft: query }, page, limit);
    const { text, matches } = prepareSearch?.(query) ?? {text:query,matches:()=>true};
    const start = (page - 1) * limit;
    const rows = [];
    let matched = 0;
    for (let sourcePage = 1; ; sourcePage++) {
      const { products, finished } = await catalogPage({ ft: text }, sourcePage, 50);
      for (const product of products) {
        const accepted = offers(product).filter(matches);
        if (!accepted.length) continue;
        if (matched >= start) rows.push(...accepted);
        matched++;
        if (matched - start === limit) return rows;
      }
      if (finished) return rows;
    }
  }

  async function byGtin(gtin) {
    if (!validGtin(gtin)) throw new TypeError('Expected a valid GTIN');
    return (await catalog({ fq: 'alternateIds_Ean:' + gtin })).filter(p => p.gtin === gtin);
  }
  async function product(sku) {
    if (!/^\d+$/.test(sku)) throw new TypeError('Expected a numeric retailer SKU');
    return (await catalog({ fq: 'skuId:' + sku })).filter(p => p.sku === String(sku));
  }
  async function basket(lines, origin) {
    const location = checkoutOrigin(origin);
    if (!Array.isArray(lines) || !lines.length || lines.length > 20) {
      throw new TypeError('Invalid CEP or basket');
    }
    const distinct = new Map();
    for (const {offer,quantity} of lines) {
      if (!/^\d+$/.test(offer.sku) || !offer.sellerId || !Number.isSafeInteger(quantity) || quantity < 1) {
        throw new TypeError('Expected SKU, seller and positive quantity');
      }
      const key = JSON.stringify([offer.sku,offer.sellerId]);
      const combined = (distinct.get(key)?.quantity ?? 0) + quantity;
      if (!Number.isSafeInteger(combined)) throw new TypeError('Invalid combined quantity');
      distinct.set(key,{offer,quantity:combined});
    }
    const requested = [...distinct.values()];
    const response = await getResponse('/api/checkout/pub/orderForms/simulation', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        country: 'BRA', ...location,
        items: requested.map(({offer,quantity}) => ({id:offer.sku,seller:offer.sellerId,quantity})),
      }) });
    const data = await response.json();
    if (!Array.isArray(data.items) || !Array.isArray(data.logisticsInfo)) throw new Error('Unexpected simulation response');
    return requested.map(({offer,quantity}) => quoteLine(offer,quantity,data, location.geoCoordinates ? 'verified_for_coordinates' : 'verified_for_cep'));
  }
  async function local(offer, zipcode, quantity = 1) {
    const [result] = await basket([{offer,quantity}],zipcode);
    return result;
  }
  return { name, site, search, product, byGtin, local, basket };
}

function quoteLine(offer, quantity, data, verifiedScope) {
  const index = data.items.findIndex(i => String(i.id) === offer.sku && String(i.seller) === offer.sellerId);
  const item = data.items[index];
  const logistics = data.logisticsInfo.find(l => l.itemIndex === index && (l.itemId == null || String(l.itemId) === offer.sku));
  const slas = (logistics?.slas ?? []).filter(s => s && ['delivery', 'pickup-in-point'].includes(s.deliveryChannel));
  const verified = !!item && item.availability === 'available' && item.quantity >= quantity && slas.length > 0;
  const methods = slas.map(s => ({ channel: s.deliveryChannel, service: s.id, feeBRL: cents(s.price),
    pickupPointId: s.pickupPointId || null, branch: s.pickupStoreInfo?.friendlyName || null,
    distanceKm: Number.isFinite(s.pickupDistance) && s.pickupDistance >= 0 ? s.pickupDistance : null,
    address: s.pickupStoreInfo?.address || null }));
  return { ...offer, priceScope: verified ? verifiedScope : 'anonymous_online',
    localStatus: verified ? 'available' : item?.availability === 'withoutStock' ? 'unavailable' : 'unverified',
    ...(verified ? { currentPrice: cents(item.sellingPrice), listPrice: cents(item.listPrice) } : {}),
    requestedQuantity: quantity, methods: verified ? methods : [], observedAt: new Date().toISOString() };
}
