# Mutual Fund Analytics

First increment of a self-hosted AMFI mutual-fund explorer. It stores only source data in a portable SQLite file. Derived metrics will be calculated in the frontend in later increments.

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

Derived returns and comparisons remain browser-calculated; SQLite holds NAV/TRI source observations only.

## Still to be added

- Import the remaining mapped Nifty indices in measured batches
- Scheme-specific benchmark overrides and effective dates from AMC documents
- Frontend fund-versus-benchmark comparison using aligned NAV/TRI dates
