# Mutual Fund Analytics

Self-hosted mutual-fund analytics workspace built from AMFI source data. SQLite retains source observations; performance, peer rankings and portfolio summaries are calculated in the browser so derived metrics are not stored in the database.

## What the app includes

- Scheme search and filters, scheme detail views, NAV history and point-to-point returns
- Fund-versus-benchmark comparison when a verified Nifty TRI mapping is available
- Peer analysis and category quartiles for Direct/Regular Growth plans
- AMFI AAUM, daily TER and current scheme-level AUM source observations
- Monthly portfolio disclosures, including top holdings, sector allocation and debt holding summaries where an AMC disclosure has been ingested

## Net return and Gross before TER

Quartiles can be viewed on either basis:

- **Net return** is calculated directly from published NAV. It is the investor return after the plan's TER.
- **Gross before TER** is an estimate of the return before the plan's operating expenses. For every day in the selected holding period, the app reverses that day's applicable official AMFI TER drag and compounds the resulting factors with NAV performance.

The gross estimate is shown only when the plan has complete, unambiguous TER coverage for the entire selected period. Historical scheme renames are linked only when AMFI's source identity, adjacent disclosure dates and TER boundary values support a continuous identity. Plans without that coverage are excluded from the gross ranking rather than being estimated with missing data.

Gross-before-TER is designed for like-for-like cost analysis; it is an analytical reconstruction, not a published fund return.

## Run locally

```powershell
npm install
npm run import:daily-nav
npm run dev
```

Open `http://localhost:5173`. The API runs at `http://localhost:3000`.

The importer downloads AMFI's `NAVAll.txt`, saves its raw response under `raw/`, filters malformed NAV/ISIN values, and upserts records into `data/mutual-funds.db`. It is safe to rerun:

```powershell
npm run import:daily-nav
```

To replay an already saved AMFI response without making a network request:

```powershell
npm run import:daily-nav -- raw/navall_YYYY-MM-DD.txt
```

## One-time historical seed

After downloading and decompressing the `funds.db.zst` release from the historical archive, import it with:

```powershell
npm run import:history
```

The importer is resumable: if interrupted, rerun the same command and it continues from its last committed archive row. It adds raw historical NAVs only; return and risk metrics are never materialized in SQLite.

## Benchmark TRI source data

AMFI tier-1 category defaults are seeded as **provisional** mappings. They are useful for an initial comparison, but they are not substitutes for a scheme's own factsheet/SID benchmark and need later verification.

Nifty's public historical-data page supplies up to one year of Total Return Index observations per request. The importer automatically splits a requested period into compliant yearly windows, keeps each raw response under `raw/benchmarks/nifty/`, and upserts only the source index values:

```powershell
node scripts/import-nifty-tri.js nifty-500 --from 2013-01-01 --to 2026-07-21
```

For commands with options, use `node` directly as above. The NPM shortcut is convenient when using its defaults:

```powershell
npm run import:nifty-tri -- nifty-500
```

To import a screened subset of the provisional Nifty defaults, pass a comma-separated list:

```powershell
node scripts/import-nifty-defaults.js --only=nifty-dividend-opportunities-50,nifty-large-midcap-250
```

Derived returns and comparisons remain browser-calculated; SQLite holds NAV/TRI and other source observations only.

## Still to be added

- Import the remaining mapped Nifty indices in measured batches
- Scheme-specific benchmark overrides and effective dates from AMC documents
- Frontend fund-versus-benchmark comparison using aligned NAV/TRI dates
