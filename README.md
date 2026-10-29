# Semrush SEO API Pro: Keywords, Domains, Competitors & Backlinks

Semrush-style SEO data without a Semrush subscription. One actor, four modes:

- **Keyword research:** search volume, keyword difficulty (KD), CPC, competition, intent, SERP features and 12-month trend.
- **Domain overview:** authority score, backlinks, traffic trend, top keywords, competitors, traffic by country and AI-assistant traffic.
- **Organic competitors:** shared keywords, traffic and traffic value.
- **Backlink checker:** authority-scored backlinks with anchors and first/last seen dates.

Pick a mode, type a keyword or domain (or paste a batch), choose one of 47+ country databases and click **Run**. Export to JSON, CSV or Excel, or connect it to n8n, Make, Zapier or the Apify API.

## Modes

| Mode | Input | What you get |
|---|---|---|
| 🔍 `keyword` | a seed keyword | Keyword ideas with volume, KD, CPC, competition, intent, SERP features and trend. Up to 10,000 per seed. |
| 🌐 `domain` | a domain | Authority score, backlinks, referring domains, organic and paid traffic with 6–12 months of history, top keywords and competitors. For popular sites it also adds visits, global and country rank, engagement, traffic by country and device, traffic sources and AI traffic (ChatGPT, Gemini…). |
| 🥊 `competitors` | a domain | Organic competitors: competition level, common keywords, organic keywords, traffic, traffic cost and paid keywords. |
| 🔗 `backlinks` | a domain or URL | Backlinks: page authority score, source URL and title, anchor, target URL, nofollow, link type, first and last seen. |

## What's new compared with the basic scraper

- **5 match types:** phrase, exact, broad, related, and **questions** (how / what / why keywords for FAQ and AI-search content).
- **Filters:** volume, keyword difficulty, CPC, intent, plus must-contain and exclude words. Filtered keywords are not charged.
- **Seed keyword row:** get the metrics of the seed itself (`includeSeed`).
- **Readable output:** intent names next to the codes, trend on a 0–100 scale, word count, ISO dates for backlinks, `source_domain`.
- **Backlink options:** follow-only, new or lost links, and one link per referring domain (link prospecting).
- **Richer domain reports:** traffic by country, device split, engagement, traffic sources and AI traffic.
- **Batches of up to 1,000 queries**, with duplicates removed and a `query` field on every row.
- **Never charged:** empty results, failed queries and filtered rows.
- **`RUN_SUMMARY`** in the key-value store: rows per source, fill rates, skipped rows and stop reason.

## Input examples

Keyword research:
```json
{ "mode": "keyword", "q": "running shoes", "db": "us", "type": "phrase", "pages": 2, "maxDifficulty": 40, "minVolume": 100 }
```

Question keywords for an FAQ page:
```json
{ "mode": "keyword", "q": "protein powder", "db": "uk", "type": "questions" }
```

Batch competitor analysis:
```json
{ "mode": "competitors", "queries": ["nike.com", "adidas.com", "newbalance.com"], "db": "uk", "sort_by": "common_keywords" }
```

Backlink prospecting:
```json
{ "mode": "backlinks", "q": "competitor.com", "followOnly": true, "onePerDomain": true, "pages": 3 }
```

## Output

Keyword row:
```json
{
  "mode": "keyword", "query": "running shoes", "phrase": "running shoes", "database": "us",
  "volume": 246000, "cpc": 0.88, "competition_level": 1, "difficulty": 71,
  "intents": [2], "intent_labels": ["navigational"], "results": 238,
  "serp_features": [3, 6, 9], "trend": [81, 44, 66, 66, 54, 66, 44, 54, 44, 81, 100, 81],
  "snapshot_date": null, "word_count": 2, "match_type": "phrase", "source": "semrush_api"
}
```

| Field | Meaning |
|---|---|
| `volume` | Average monthly searches |
| `difficulty` | Keyword difficulty, 0–100 |
| `cpc` | Cost per click in USD |
| `competition_level` | Paid competition, 0–1 |
| `intents` / `intent_labels` | 0 commercial, 1 informational, 2 navigational, 3 transactional |
| `serp_features` | SERP feature codes (Semrush). Rows from DataForSEO carry `serp_feature_names` instead. |
| `trend` | Last 12 months, 100 = peak month |
| `source` | Where the row came from: `semrush_api`, `semrush_public_page` or `dataforseo` |

Competitor rows carry `domain`, `competition_level`, `common_keywords`, `se_keywords`, `traffic`, `traffic_cost` and `paid_keywords`.

Backlink rows carry `page_ascore`, `source_title`, `source_url`, `target_anchor`, `target_url`, `external_link_num`, `internal_link_num`, `nofollow`, `first_seen` and `last_seen` (unix time), plus ISO dates.

Domain reports carry `authority_score`, `number_of_backlinks`, `referring_domains_count`, `organic_traffic`, `paid_traffic`, `search_traffic` (date → traffic), `top_keywords`, `competitors` and the extras listed above.

Errors and empty results appear as rows with an `error` field. They are free.

## Pricing

Pay per result, by mode:

- one keyword row;
- one competitor;
- one backlink;
- one domain report.

Empty results, failed queries and filtered keywords are never charged. Set **Maximum cost per run** to cap spending; the run stops cleanly at the limit.

## FAQ

**Do I need a Semrush account or API key?** No. You only need an Apify account.

**Which countries are supported?** 47 databases: us, uk, ca, au, br, fr, de, it, es, nl, se, dk, be, no, ie, ar, mx, co, cl, pe, in, sg, id, ph, my, th, vn, jp, hk, cn, tr, za, il, sa, ae, pl, cz, ro, hu, at, ch, pt, fi, gr, nz, ru and ua. Backlinks are global.

**Why does a domain report show another country?** Free domain reports describe the site's main market (for example `us` for nike.com). Choose **Domain report source = API only** to get the exact database you selected.

**How many results per run?** Up to 100 pages of 100 rows per query, and 200 pages in total per run. Split very large batches across runs.

**What happens if one query fails?** The run continues. The failed query gets a free error row.
