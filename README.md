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

`suggest` returns search terms from the public VTEX autocomplete endpoint. It uses no storefront API key and merges spelling variants such as `10 mg` and `10mg`. An empty first search page prompts with the first alternative. Run `search` with the chosen term to see products. With `--json`, results go to stdout and the hint goes to stderr. A completed search returns exit code 0, including an empty page. A missing product or a confirmed unavailable stock request returns exit code 3.

`search` checks whole words against the start of the SKU title, the catalog brand, or the active ingredient. It checks additional words and quantities against the title and structured fields. Mentions in descriptions and autocomplete preview cards do not qualify a product. Missing identity evidence can omit a relevant product. Pagination counts matching catalog products. Each can contain several matched SKUs or sellers. The library exposes the same operations as `retailer.suggest(prefix, limit)` and `retailer.search(query, page, limit)`.

Product details include the retailer's original specification fields. Stock performs an anonymous, non-purchasing VTEX simulation for the exact SKU, seller, requested quantity and CEP. A returned method confirms fulfillment for that request. A pickup method does not establish how many packs are on a shelf. Online and locally verified prices use separate scope labels. Missing seller or location evidence remains unknown.

[Public storefront](https://www.paguemenos.com.br/) · [VTEX Checkout API](https://developers.vtex.com/docs/api-reference/checkout-api)

### Standalone catalog and location workflows

Use `info "name" "another name" --json` for retailer facts or add `--brazil` for sourced national presentations. A single numeric SKU keeps an array response. `compare <name or SKU>` checks equivalent packs in this retailer's catalog and accepts `--brand-only`. `product` accepts ordered SKU batches, preserving all sellers and missing slots. `snapshot collect|read|export` shares the durable catalog format and supports JSON, CSV and XLSX. All snapshot commands also require Python 3 (`python3` on PATH) for SQLite storage and exports.

`stores --cep CEP` or `stores --lat LAT --lon LON` reads the Pague Menos store locator for that origin. `stock SKU` accepts either origin and an optional `--min-qty N`. The resulting quantity is the quantity requested from checkout. A successful quote confirms that fulfillment method. Branch inventory and nationwide directory coverage remain open.

`plan "item A" "item B" --cep CEP` checks the whole selected basket together. Use `--sku A=SKU`, `--quantity A=2`, or per-item brand and generic choices. Ambiguous options are returned for selection before checkout simulation. Product totals exclude fees. Common pickup points must cover all items. This workflow reports fulfillment evidence; route optimization is still tracked separately.

### Optional inventory by physical branch

The public locator supplies Pague Menos branch codes, distance from the requested origin, published hours and phone numbers where available. Its coverage is regional. Counts by physical branch need a separate authorized inventory source. No branch feed for either retailer has been verified. The integration can be tested privately with an operator-supplied full snapshot.

The importer accepts UTF-8 CSV with a header. Each record identifies the retailer (`paguemenos` or `drogariasaopaulo`), the retailer's literal SKU in `id`, the matching public locator branch ID in `store_code`, nonnegative individual packs in `quantity`, and an observation `timestamp` with UTC offset. A blank quantity or omitted row means unknown. Preserve leading zeros on identifiers. When a provider uses different identifiers, map those identifiers before importing. A general affiliate catalog, availability word, distribution-center quantity, partial update or checkout response does not meet this input contract.

```sh
python3 branch_inventory.py import --retailer paguemenos --database "$STOCK_DB" --snapshot-at "$FEED_TIME" "$FULL_CSV"
export PAGUEMENOS_BRANCH_STOCK_DB="$STOCK_DB"
export PAGUEMENOS_BRANCH_STOCK_MAX_AGE_MINUTES="$AGREED_MAX_AGE_MINUTES"
node cli.js stock "$SKU" --cep "$CEP" --all --json
node cli.js stock "$SKU" --cep "$CEP" --expand --json
```

Each import replaces one retailer atomically. Records are indexed by retailer, SKU and branch. Reimporting identical data with the same snapshot timestamp is safe. Malformed, duplicate-key or older imports leave the prior snapshot intact. An omitted record in a successfully supplied full snapshot becomes unknown. The application requires an explicit maximum age for using a branch observation. Select it according to the source and the use case. With a source configured, existing stock quote rows gain a separate `branchInventory` field.

Use `--max-branches N` for the initial 3–30 nearest branches by CEP (default 30), or `--all` to include zero and unknown quantities. The CLI can offer a wider search when every branch in the initial window explicitly reports zero and the locator returns more branches within 25 km. With opt-in, it returns up to ten qualifying branches, nearest first, with observation times and contact information. A physical-stock request without a configured source exits with status 2 and reports unknown stock.

`compare` and `plan` both accept `--store nearest` and `--expand`. Fixed-store mode uses the same closest directory branch for every product and displays zero or unknown quantities there. A located branch with unknown stock can be identified even before a feed is connected. Other modes use the nearest stocked branch for each option when an inventory snapshot is configured. Fresh, affirmative zeros across the whole nearby basket enable the 25 km opt-in. Ambiguous catalog matches or unknown quantities keep that offer closed.

For baskets, the shared Drogasil optimizer considers every qualifying branch in scope, including branches omitted from the compact product tables and the ten-branch expansion summary. It checks repeated SKU quantities and compares fewest stores with lowest estimated product total. Prices are the chain's own online catalog references. An outside seller's price cannot set a physical branch total. Results carry their inventory observation time and explain missing quantities.
