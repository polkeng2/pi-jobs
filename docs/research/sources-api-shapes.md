# Sources API shapes: freehire.me and Himalayas

Research for issue #15. Feeds the "Scouting run" step 4 in [design.md](../design.md). Checked 2026-10-30. Findings only; no decisions.

Source tags: **[fh-docs]** https://freehire.me/docs/api, **[fh-terms]** https://freehire.me/terms, **[fh-live]** a real response from `https://freehire.me/api/v1/...` fetched on the check date, **[fh-repo]** https://github.com/strelov1/freehire, **[hl-docs]** https://himalayas.app/docs/remote-jobs-api, **[hl-spec]** https://himalayas.app/docs/openapi.json, **[hl-terms]** https://himalayas.app/terms (clause 113). **[ref]** marks the owner's ai-job-search workspace, read as reference only (only API facts taken, nothing personal).

## freehire.me

### Endpoint to use

`GET https://freehire.me/api/v1/agent/jobs/search` [fh-docs, ref]. Same query as `/jobs/search`, but returns full descriptions and adds `description_format` (`html` default, `text`, `markdown`; unknown values fall back to `html`, not an error). `/jobs/search` returns truncated description previews. `GET /jobs` ignores all filters, so never use it for a filtered query [fh-docs]. `GET /jobs/{slug}` serves one job, including closed ones (`closed_at` set) [fh-docs].

Note: in a live call with `include_description=false` the API listed `include_description` under `meta.ignored_params` [fh-live]. The ai-job-search notes say `include_description=true` is what triggers full-description hydration, and that hydration is best-effort per hit [ref]. That flag is not in the official docs page; treat as unverified (see Open uncertainty).

### Auth

None for reads, CORS-open [fh-docs]. Keys (`Authorization: Bearer`) exist but are not needed.

### Query parameters

- `q`: full text over title, company, description, location. Supports quoted words (any order), `-word` exclusion, uppercase `OR` (max 5), `title:` prefix [fh-docs].
- `q_fields`: subset of `title,company,description,location`; an unknown name drops the whole parameter [fh-docs].
- `sort`: `created_at`, `posted_at`, `view_count`, `salary_min`, `salary_max`; omit for relevance (with `q`) or newest. `order`: `asc`/`desc` (default `desc`) [fh-docs].
- `limit`: 1-100, default 20. `offset`: default 0 [fh-docs].
- Facets: repeated or comma-separated values are ORed; `<param>_mode=and` requires all; `<param>_exclude=<v>` excludes [fh-docs].
  - enumerated: `work_mode` (`remote|hybrid|onsite`), `regions` (`global, north_america, latam, eu, uk, mena, africa, apac, cis, none`), `category`, `seniority` (`intern, junior, middle, senior, lead, staff, principal, c_level`), `employment_type` (`full_time, part_time, contract, internship, fellowship`), `english_level`, `relocation`, `reality` (`fresh, stale, likely-evergreen`), `salary_currency`, `salary_period`, `company_type`, `source_type`, and more (full list in [fh-docs]).
  - open vocabulary (values from `GET /jobs/facets`): `skills`, `countries`, `cities`, `metros`, `posting_language`, `company_slug`, `source`.
  - numeric/boolean: `visa_sponsorship`, `requires_clearance`, `salary_min`, `salary_max` (pair with `salary_currency`), `experience_years_min/max`, `seniority_include_unspecified`.
  - recency: `posted_within_days` (date stated by the source; some boards restate it on every crawl) and `open_within_days` (days since freehire first saw the job; cannot be forged by the source) [fh-docs]. For "new since last run", `open_within_days` is the more trustworthy per the docs.
- Geography facets (`regions`, `countries`, `metros`, `cities`) form one OR group; `_mode=and` does not apply to them [fh-docs].
- Unknown params are ignored, not rejected, and listed in `meta.ignored_params` (max 10) [fh-docs]. A typo silently widens the query; code should check `ignored_params` is empty.

### Pagination

`limit` + `offset`; `meta.total` is the match count; `offset + limit > 10000` returns 400 `pagination too deep` [fh-docs]. Envelope is `{data, meta:{limit, offset, total}}`; errors are `{error}` [fh-docs, fh-live].

### Rate limits

Public endpoints are limited per IP. The numbers are not on the docs page; every response carries `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`, and a refusal is `429` with `Retry-After`. `GET /plans` reports current limits as `api_limits` [fh-docs] (not called here). Code should read the headers instead of hard-coding a number. Each fetch costs one of the 50 subrequests per invocation on the free plan.

### Returned fields (job object)

Observed in live responses [fh-live], consistent with [fh-docs]:

- identity: `public_slug`, `source`, `external_id`, `url`, `manually_added`
- content: `title`, `company`, `company_slug`, `location` (free text, may be empty), `description`
- tags: `countries` (lowercase alpha-2), `regions`, `cities`, `metros`, `skills`, `collections`, `work_mode` (absent on some jobs), `is_tech`
- timestamps: `posted_at`, `created_at`, `updated_at`, `last_seen_at`, `closed_at` (null when open)
- `enrichment` (fields vary per job; sometimes only a few): `summary`, `category`, `seniority`, `employment_type`, `salary_min/max/currency/period`, `requirements[]` (`text`, `priority`), `posting_language`, `domains`, `company_type`, ...
- `reality`: `class`, `age_days`, `repost_count`, `mass_posting_count`, `fake_freshness`
- counters (not needed): `view_count`, `applied_count`, `upvote_count`, `downvote_count`, `my_vote`

Observations from live data:
- `url` is the posting's own URL as ingested; its host varies by `source`: seen values include a Telegram post, an EURES job page, and an aggregator redirect (`whatjobs-nl`) [fh-live]. It is not always an ATS URL. freehire appends `utm_source=freehire.me` to some URLs [fh-live]; strip the query string before storing or comparing.
- `company` can be empty (EURES and Telegram examples) [fh-live].
- Closed postings are excluded from search, so a seen offer vanishing from results is the only bulk closure signal; use `GET /jobs/{slug}` to confirm `closed_at` [fh-docs].

### Attribution and terms

- No attribution requirement for API data [fh-terms, fh-docs].
- Without a plan, "the API is for personal and non-commercial use": your own job search, research, or a tool you run for yourself. Showing postings in a product offered to others, free or paid, needs a plan [fh-terms]. A personal digest to the owner fits the no-plan tier.
- No scraping beyond the documented API; do not bypass rate limits or authentication [fh-terms].
- Postings belong to the employers; the terms grant no rights beyond what employers gave [fh-terms].
- The project is MIT-licensed and self-hostable [fh-repo].

### Mapping to an offer and dedup key

| Offer field | freehire field |
|---|---|
| source | constant `freehire` (keep `source` as sub-source) |
| title, company | `title`, `company` |
| location | `location`, `countries`, `regions`, `cities` |
| work mode | `work_mode` (may be absent) |
| description | `description` (ask for `description_format=markdown` or `text`) |
| URL to open | `url` minus query string |
| posted | `posted_at` |
| salary | `enrichment.salary_*` |

Dedup key candidate: `freehire:<public_slug>`. The docs call `public_slug` "the only addressable id" and the internal numeric id is never exposed [fh-docs, ref]. Reposts of one role under different slugs exist: `GET /jobs/{slug}/copies` lists other open postings in the same role cluster (per-city duplicates), and `reality.repost_count` is exposed [fh-docs]. The same job can also reach the owner through Himalayas, so cross-source dedup needs a secondary normalised key such as company + title (the ai-job-search workspace keys its own tracker this way, with a length cap and hash suffix [ref]). Which key to use is a design decision, not settled here.

## Himalayas

### Endpoint

`GET https://himalayas.app/jobs/api/search` (operation `searchHimalayasRemoteJobs`) [hl-spec]. Related: browse feed `https://himalayas.app/jobs/api` (cursor-based) and single-job check `https://himalayas.app/jobs/api/companies/:company/jobs/:slug` [hl-docs]. OpenAPI 3.1 spec at https://himalayas.app/docs/openapi.json; an RSS feed (100 most recent, no pagination) and an MCP server (real-time) also exist [hl-docs].

### Auth

Optional. Without a key there is one shared public allowance for all callers. A free key (created at `/signup/developer`) grants `jobs:read`; send `Authorization: Bearer hml_<secret>`. Never put keys in URLs, browser code, source control or logs. Invalid, revoked, suspended or unverified key gives 401; a key-check outage gives 503. Cached responses are returned without a key check [hl-docs, hl-spec]. In the Worker the key is a secret binding, never committed.

### Query parameters (search)

All optional [hl-spec]:

| Param | Notes |
|---|---|
| `q` | free text |
| `country` | ISO alpha-2, common names, slugs; invalid value gives 400 `Invalid country` |
| `worldwide` | boolean, default false |
| `exclude_worldwide` | boolean; excludes worldwide matches when `country` is set |
| `seniority` | comma-separated: `Entry-level, Mid-level, Senior, Manager, Director, Executive` |
| `employment_type` | comma-separated: `Full Time, Part Time, Contractor, Temporary, Intern, Volunteer, Other` |
| `company` | company slug(s), comma-separated |
| `timezone` | numeric UTC offsets, e.g. `UTC-5`, `UTC+05:30`; invalid gives 400 |
| `sort` | `relevant` (default), `recent`, `salaryAsc`, `salaryDesc`, `nameAToZ`, `nameZToA`, `jobs` |
| `page` | 1-based integer, default 1 |

The spec defines no `limit`, `cursor` or `offset` for search. `limit` (default 20, max 20), `cursor` and a deprecated `offset` belong to the browse endpoint [hl-docs, hl-spec].

### Pagination

Search uses `page`. "Pages may hold fewer jobs than the limit", so keep requesting until a page returns no jobs; do not stop on `totalCount` (approximate, up to a day old); de-duplicate on `guid`, since results can shift between pages [hl-spec]. Browse uses an opaque `nextCursor`, absent on the last page [hl-docs]. The search page size is not stated (browse max is 20).

### Rate limits and caching

- With a free key: 60 requests/minute and 10,000 per UTC day, shared across the account's keys [hl-docs, hl-spec].
- Without a key: one public allowance shared by all callers, number not published [hl-docs].
- Cached responses do not count; only requests reaching the servers count, even if they fail [hl-docs].
- A 429 carries `Retry-After` (seconds) and `X-RateLimit-*` headers (day: `Limit/Remaining/Reset`; minute: `Minute-Limit/Remaining/Reset`). Successful responses do not carry these headers [hl-docs, hl-spec].
- Responses are cacheable (`Cache-Control: public, s-maxage=86400, stale-while-revalidate=86400` in the spec example); data refreshes every 24 hours, so repeating a query within a day returns the same data [hl-docs, hl-spec].
- Other errors: 400 invalid filter, 401, 503 [hl-spec].

### Returned fields

Top level: `updatedAt`, `offset`, `limit`, `totalCount`, `jobs`, optional `comments` (release notes); `nextCursor` is browse only [hl-spec].

Job (required unless noted) [hl-spec, hl-docs]: `title`, `excerpt`, `companyName`, `companySlug`, `companyLogo`, `employmentType`, `seniority` (array), `currency` (ISO 4217), `salaryPeriod` (`hourly|weekly|fortnightly|monthly|annual`), `minSalary`/`maxSalary` (optional, number or null, expressed in `salaryPeriod`), `locationRestrictions` (array of `{alpha2, name, slug}`; empty means worldwide), `timezoneRestrictions` (empty means none), `categories`, `parentCategories`, `description` (sanitized HTML), `pubDate`, `expiryDate` (Unix seconds; jobs can close earlier), `applicationLink`, `guid`.

### Attribution and terms (binding, personal use included)

From [hl-docs] and [hl-terms] clause 113:
- (a) Every Apply action must use the API's `applicationLink`, not a direct employer or ATS link.
- (b) Show visible Himalayas source credit with a link to the Himalayas job or himalayas.app.
- (c) Show jobs only on sites and apps you operate. Do not pass them to other job boards, aggregators, job search engines, Google Jobs or LinkedIn Jobs, including via feeds or JobPosting structured data.
- (d) Cache where you can, stay within limits, remove jobs once expired.
- (e) Keep keys private; use them only from your own servers.
- Showing jobs on your own site or app needs no prior approval. Himalayas may change limits and suspend keys.

Implication for Job Scout: the digest link for a Himalayas offer must be `applicationLink`, with a "via Himalayas" credit linking to himalayas.app (or the job page). The design's shortlist export to the owner's ai-job-search workspace is the owner's own tool; whether that fits "sites and apps you operate" is not addressed by the terms (see Open uncertainty). The `.txt` export carries full offer text, so this matters.

### Mapping to an offer and dedup key

| Offer field | Himalayas field |
|---|---|
| source | constant `himalayas` |
| title, company | `title`, `companyName` |
| location | `locationRestrictions[].name` (empty = worldwide), `timezoneRestrictions` |
| work mode | always remote (the board is remote-only; implied, not a field) |
| description | `description` (HTML) or `excerpt` |
| URL to open | `applicationLink` (required by the terms) |
| posted / expiry | `pubDate`, `expiryDate` (Unix seconds) |
| salary | `minSalary`, `maxSalary`, `currency`, `salaryPeriod` |

Dedup key: `himalayas:<guid>`. The spec calls `guid` the "unique identifier for the job listing" and names it the field to de-duplicate on across pages; its example is `stripe-senior-software-engineer-abc123` [hl-spec]. Whether `guid` stays stable when a job is edited is not stated; the docs say updated jobs move to the front of the browse feed [hl-docs].

## Comparison for the scouting run

| | freehire | Himalayas |
|---|---|---|
| Key | none | optional free key |
| Page size | up to 100 | not stated for search (20 for browse) |
| Pagination | `limit`/`offset`, cap 10000 | `page`, stop at an empty page |
| Rate limit | per IP, numbers unpublished, headers on every response | 60/min and 10k/day with key; keyless shared pool |
| Freshness | live | refreshed every 24h |
| Remote filter | `work_mode=remote` | all remote; `worldwide`/`country` |
| Credit | none | required |
| Apply link | `url` (strip utm) | `applicationLink` (mandatory) |
| Dedup key | `public_slug` | `guid` |

## Open uncertainty

1. freehire's per-IP numeric rate limit is unpublished; discoverable only from response headers or `GET /plans`. Not measured here.
2. freehire `include_description`: not in the official docs, and a live call with `false` reported it as ignored. The `agent` endpoint is documented as returning full descriptions; whether the flag is still needed was not tested with `true`.
3. Himalayas search page size and the keyless allowance are unpublished.
4. Whether Himalayas `guid` and freehire `public_slug` stay stable across edits and reposts is undocumented.
5. Whether exporting Himalayas offer text to the owner's separate ai-job-search workspace satisfies clause 113(c) ("sites and apps you operate"). Likely fine for a personal tool; not confirmed by the terms text.
6. If Job Scout were ever offered to others, freehire would require an API plan [fh-terms].
7. No raw Himalayas search response was fetched; field presence rests on [hl-spec]. freehire facts were read from the docs page and two live responses, summarised by the fetch tool rather than read byte for byte.
