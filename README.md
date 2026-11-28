# Pague Menos CLI
Independent read-only CLI for the Brazilian Pague Menos catalog. Requires Node 20 or newer.

```sh
node cli.js search paracetamol --limit 10
node cli.js suggest morfi --json
node cli.js search "morfina 10 mg"
node cli.js product 1633706 --json
node cli.js gtin 7899547543766 --json
node cli.js info 1633706
node cli.js stock 1633706 --cep "$CEP"
```

`suggest` returns search terms from the public VTEX autocomplete endpoint. It uses no storefront API key and merges spelling variants such as `10 mg` and `10mg`. An empty first search page prompts with the first alternative. Run `search` with the chosen term to see products. With `--json`, results go to stdout and the hint goes to stderr. Exit code 3 means an empty result.

`search` checks whole words against the start of the SKU title, the catalog brand, or the active ingredient. It checks additional words and quantities against the title and structured fields. Mentions in descriptions and autocomplete preview cards do not qualify a product. Missing identity evidence can omit a relevant product. Pagination counts matching catalog products. Each can contain several matched SKUs or sellers. The library exposes the same operations as `retailer.suggest(prefix, limit)` and `retailer.search(query, page, limit)`.

Product details include the retailer's original specification fields. Stock performs an anonymous, non-purchasing VTEX simulation for the exact SKU, seller, requested quantity and CEP. A returned method confirms fulfillment for that request. A pickup method does not establish how many packs are on a shelf. Online and locally verified prices use separate scope labels. Missing seller or location evidence remains unknown.

[Public storefront](https://www.paguemenos.com.br/) · [VTEX Checkout API](https://developers.vtex.com/docs/api-reference/checkout-api)

### Standalone catalog and location workflows

Use `info "name" "another name" --json` for retailer facts or add `--brazil` for sourced national presentations. A single numeric SKU keeps an array response. `compare <name or SKU>` checks equivalent packs in this retailer's catalog and accepts `--brand-only`. `product` accepts ordered SKU batches, preserving all sellers and missing slots. `snapshot collect|read|export` shares the durable catalog format and supports JSON, CSV and XLSX.

`stores --cep CEP` or `stores --lat LAT --lon LON` reads the Pague Menos store locator for that origin. `stock SKU` accepts either origin and an optional `--min-qty N`. The resulting quantity is the quantity requested from checkout. A successful quote confirms that fulfillment method. Branch inventory and nationwide directory coverage remain open.
