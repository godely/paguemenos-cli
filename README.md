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

Nos comandos `search`, `info`, `compare` e `plan`, uma grafia como “predniso” abre a pergunta “Você quis dizer prednisona ou prednisolona?”. No terminal, responda com o nome ou o número da opção. Com uma única sugestão, responda “sim” ou “não”. Em scripts e com `--json`, a pergunta vai para stderr e o processo encerra com código 3. Repita o comando com o nome escolhido.

`suggest` returns search terms from the public VTEX autocomplete endpoint. It uses no storefront API key and merges spelling variants such as `10 mg` and `10mg`. An empty first search page prompts with the first alternative. Run `search` with the chosen term to see products. With `--json`, results go to stdout and the hint goes to stderr. A completed search returns exit code 0, including an empty page. A missing product or a confirmed unavailable stock request returns exit code 3.

`search` checks whole words against the start of the SKU title, the catalog brand, or the active ingredient. It checks additional words and quantities against the title and structured fields. Mentions in descriptions and autocomplete preview cards do not qualify a product. Missing identity evidence can omit a relevant product. Pagination counts matching catalog products. Each can contain several matched SKUs or sellers. The library exposes the same operations as `retailer.suggest(prefix, limit)` and `retailer.search(query, page, limit)`.

Product details include the retailer's original specification fields. Stock performs an anonymous, non-purchasing VTEX simulation for the exact SKU, seller, requested quantity and CEP. A returned method confirms fulfillment for that request. A pickup method does not establish how many packs are on a shelf. Online and locally verified prices use separate scope labels. Missing seller or location evidence remains unknown.

[Public storefront](https://www.paguemenos.com.br/) · [VTEX Checkout API](https://developers.vtex.com/docs/api-reference/checkout-api)

### Standalone catalog and location workflows

Use `info "name" "another name" --json` for retailer facts or add `--brazil` for sourced national presentations. A single numeric SKU keeps an array response. `compare <name or SKU>` checks equivalent packs in this retailer's catalog and accepts `--brand-only`. `product` accepts ordered SKU batches, preserving all sellers and missing slots. `snapshot collect|read|export` shares the durable catalog format and supports JSON, CSV and XLSX. All snapshot commands also require Python 3 (`python3` on PATH) for SQLite storage and exports.

`stores --cep CEP` or `stores --lat LAT --lon LON` reads the Pague Menos store locator for that origin. `stock SKU` accepts either origin and an optional `--min-qty N`. The resulting quantity is the quantity requested from checkout. A successful quote confirms that fulfillment method. Branch inventory and nationwide directory coverage remain open.

`plan "item A" "item B" --cep CEP` checks the whole selected basket together. Use `--sku A=SKU`, `--quantity A=2`, or per-item brand and generic choices. Ambiguous options are returned for selection before checkout simulation. Product totals exclude fees. Common pickup points must cover all items. This workflow reports fulfillment evidence; route optimization is still tracked separately.

The multi-item `plan` command shows the fewest pickup stops and the lowest estimated product total among verified itineraries. Each named stop has a checkout quote for the requested packs. A shared stop requires a joint quote for all its items. The output marks a limited comparison, an unknown price or distance, and keeps the branch inventory count unknown. Both standalone partner CLIs use this planner.
