const cents = value => Number.isSafeInteger(value) && value >= 0 ? value / 100 : null;
const price = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

export function validGtin(code) {
  if (!/^(?:\d{8}|\d{12,14})$/.test(code) || /^0+$/.test(code)) return false;
  const digits = [...code].reverse().map(Number);
  return digits.reduce((sum, n, i) => sum + n * (i % 2 ? 3 : 1), 0) % 10 === 0;
}

export function createRetailer({ name, site }, request = fetch) {
  async function json(path, options = {}) {
    const response = await request(new URL(path, site), { ...options, signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(name + ' HTTP ' + response.status);
    return response.json();
  }

  async function catalog(params, page = 1, limit = 20) {
    if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
      throw new TypeError('page must be positive and limit must be 1 to 50');
    }
    const start = (page - 1) * limit;
    const data = await json('/api/catalog_system/pub/products/search?' + new URLSearchParams({
      ...params, _from: String(start), _to: String(start + limit - 1),
    }));
    if (!Array.isArray(data)) throw new Error('Unexpected catalog response');
    return data.flatMap(product => product.items.flatMap(item => item.sellers.map(seller => {
      const offer = seller.commertialOffer ?? {};
      const facts = Object.fromEntries((product.allSpecifications ?? []).map(key => [key, product[key]]));
      return { retailer: name, sku: String(item.itemId), gtin: validGtin(String(item.ean)) ? String(item.ean) : null,
        name: item.nameComplete || item.name, itemName: item.name, brand: product.brand, productUrl: product.link,
        sellerId: String(seller.sellerId), seller: seller.sellerName, currency: 'BRL', currentPrice: price(offer.Price),
        listPrice: price(offer.ListPrice), inStock: typeof offer.IsAvailable === 'boolean' ? offer.IsAvailable : null,
        priceScope: 'anonymous_online', observedAt: new Date().toISOString(), facts };
    })));
  }

  async function byGtin(gtin) {
    if (!validGtin(gtin)) throw new TypeError('Expected a valid GTIN');
    return (await catalog({ fq: 'alternateIds_Ean:' + gtin })).filter(p => p.gtin === gtin);
  }
  async function product(sku) {
    if (!/^\d+$/.test(sku)) throw new TypeError('Expected a numeric retailer SKU');
    return (await catalog({ fq: 'skuId:' + sku })).filter(p => p.sku === String(sku));
  }
  async function local(offer, zipcode, quantity = 1) {
    if (!/^\d{5}-?\d{3}$/.test(zipcode) || !Number.isSafeInteger(quantity) || quantity < 1) throw new TypeError('Invalid CEP or quantity');
    const data = await json('/api/checkout/pub/orderForms/simulation', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        country: 'BRA', postalCode: zipcode.replace('-', ''), items: [{ id: offer.sku, seller: offer.sellerId, quantity }],
      }) });
    if (!Array.isArray(data.items) || !Array.isArray(data.logisticsInfo)) throw new Error('Unexpected simulation response');
    const index = data.items.findIndex(i => String(i.id) === offer.sku && String(i.seller) === offer.sellerId);
    const item = data.items[index];
    const slas = data.logisticsInfo.find(l => l.itemIndex === index)?.slas ?? [];
    const verified = !!item && item.availability === 'available' && item.quantity >= quantity && slas.length > 0;
    const methods = slas.map(s => ({ channel: s.deliveryChannel, service: s.id, feeBRL: cents(s.price),
      branch: s.pickupStoreInfo?.friendlyName || null, address: s.pickupStoreInfo?.address || null }));
    return { ...offer, priceScope: verified ? 'verified_for_cep' : 'anonymous_online',
      localStatus: verified ? 'available' : item?.availability === 'withoutStock' ? 'unavailable' : 'unverified',
      ...(verified ? { currentPrice: cents(item.sellingPrice), listPrice: cents(item.listPrice) } : {}),
      requestedQuantity: quantity, methods: verified ? methods : [], observedAt: new Date().toISOString() };
  }
  return { name, site, search: (query, page, limit) => catalog({ ft: query }, page, limit), product, byGtin, local };
}
