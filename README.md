# Pague Menos CLI
Independent read-only CLI for the Brazilian Pague Menos catalog. Requires Node 20 or newer.

```sh
node cli.js search paracetamol --limit 10
node cli.js product 1633706 --json
node cli.js gtin 7899547543766 --json
node cli.js info 1633706
node cli.js stock 1633706 --cep "$CEP"
```

Search pagination counts catalog products. Each product can contain several SKUs and sellers. Product details include the retailer's original specification fields. Stock performs an anonymous, non-purchasing VTEX simulation for the exact SKU, seller, requested quantity and CEP. A returned method confirms fulfillment for that request. A pickup method does not establish how many packs are on a shelf. Online and locally verified prices use separate scope labels. Missing seller or location evidence remains unknown.

[Public storefront](https://www.paguemenos.com.br/) · [VTEX Checkout API](https://developers.vtex.com/docs/api-reference/checkout-api)
