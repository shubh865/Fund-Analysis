# Mutual Fund Analytics

A local-first analytics workspace for Indian mutual funds. It brings together AMFI scheme/NAV data, AMFI AUM and TER disclosures, supported monthly portfolio disclosures, and selected Nifty Total Return Indices (TRIs).

The product is designed for analysis rather than a static return screener: source data is retained in SQLite, while returns, quartiles, peer measures, cost reconstruction and portfolio summaries are calculated in the browser.

## What it does

- Search and filter schemes by broad category, subcategory, plan and fund structure.
- View an individual scheme's NAV history, point-to-point returns and investment growth.
- Compare a fund with its mapped benchmark only when aligned TRI data and a verified mapping are available.
- Compare up to five schemes, including NAV, total AUM, 1/3/5-year returns and benchmark alpha.
- Analyse category peers using rolling-return averages, alpha and benchmark-beating consistency.
- Compare two disclosed portfolios using ISIN-matched holding overlap, sector overlap and top-10 concentration.
- Track additions, exits, weight changes, sector shifts and concentration changes once two monthly disclosures are available.
- Rank category peers in quartiles, with Direct and Regular Growth shown side-by-side.
- Review AMFI AAUM, daily TER, current scheme-level AUM and available monthly portfolio disclosures.
- Provide top holdings, sector allocation and debt holding/rating summaries where the corresponding AMC disclosure has been ingested and mapped.
- Show official exit-load terms, fund-manager details and available debt quants from dated AMC factsheets (currently ABSL, HDFC, SBI, Kotak, Axis, PPFAS, Nippon India, UTI, Invesco, Mirae Asset, Canara Robeco, Baroda BNP Paribas, Edelweiss, Tata, Motilal Oswal, HSBC, Franklin Templeton and DSP coverage).

## Data model and calculation principle

`data/mutual-funds.db` is a local SQLite database and is deliberately not committed to Git. It stores source observations and mappings, including:

- scheme master and daily NAV history
- benchmark TRI observations and benchmark mappings
- daily AMFI TER observations, periodic AMFI AAUM and scheme-level AUM
- raw portfolio disclosures, normalised positions and scheme-to-portfolio mappings
- dated AMC factsheet observations for exit load, fund managers and debt quants

The frontend calculates derived measures from these source observations. This means returns, rolling averages, alpha, quartile membership, volatility measures and portfolio aggregates are not stored as permanent database metrics.

## Return conventions

### Net return

Net return is calculated directly from published NAV. It is the return an investor experiences, after the TER charged by the fund plan.

### Gross before TER

The Quartiles view also offers **Gross before TER**. It is an analytical estimate of the return before plan expenses:

1. Start with the published NAV performance for the selected holding period.
2. Take the applicable official AMFI TER for each day.
3. Reverse that day's expense drag and compound the daily factors across the period.

This reconstructs a like-for-like pre-expense outcome for comparing fund management performance separately from the cost of the plan. It is not a published fund return.

The app displays a plan in Gross before TER only when its TER history is complete and unambiguous for the selected period. Historic AMFI scheme identities are linked across renames only where the official source identity, adjacent disclosure dates and TER boundary values support continuity. Where coverage is incomplete, the plan is excluded instead of filling gaps with an assumed TER.

### Periods, CAGR and rolling returns

- 1-year return is the return between the selected date and the closest available NAV at the equivalent date one calendar year earlier.
- 3-year and 5-year returns are annualised (CAGR).
- Rolling returns repeat that same calendar-year holding-period calculation for every eligible end date; their average is the average of those individual outcomes.
- Alpha is fund return minus the mapped benchmark return over the same aligned dates. A benchmark is never substituted with another index when the intended mapping/data is unavailable.

## Data sources and scope

| Source | Used for |
| --- | --- |
| AMFI NAV feed and historical archive | Scheme master and daily NAV history |
| AMFI TER disclosures | Daily Direct/Regular TER history |
| AMFI AUM disclosures | Monthly AAUM and current scheme-level AUM |
| Nifty index data | Supported benchmark TRI histories |
| AMC monthly portfolio disclosures | Holdings, sectors and debt portfolio measures for supported AMCs |
| AMC factsheets | Exit load, fund-manager details and reported debt quants where an AMC importer is available |

Coverage varies by source. Benchmark comparisons require a usable scheme-to-index mapping and TRI history. Portfolio sections appear only when a suitable disclosure has been imported and mapped. BSE and CRISIL benchmark data is not inferred from another index.

## Run locally

Requirements: Node.js 22 or later and npm. The project uses Node's built-in
SQLite support, so no native SQLite package or C++ build tools are required.

```powershell
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173). The local API runs at [http://localhost:3000](http://localhost:3000), with a health endpoint at [http://localhost:3000/api/health](http://localhost:3000/api/health).

For a production-style local API process:

```powershell
npm start
```

## Data refresh and maintenance

The project keeps raw downloads outside Git and uses rerunnable import scripts. The main commands are:

```powershell
# Daily AMFI NAV import
npm run import:daily-nav

# Refresh available Nifty TRI data
npm run refresh:nifty-tri

# Import current AMFI AUM and TER source data, then update their mappings
npm run import:amfi-total-aum
npm run map:amfi-total-aum
npm run import:amfi-aaum
npm run map:amfi-aaum
npm run import:amfi-ter
npm run map:amfi-ter

# Refresh supported AMC monthly portfolio disclosures
npm run refresh:all-holdings

# Refresh latest AMC factsheets (exit load, managers and debt quants)
npm run refresh:absl-factsheets
npm run refresh:hdfc-factsheets
npm run refresh:sbi-factsheets
npm run refresh:kotak-factsheets
npm run refresh:axis-factsheets
npm run refresh:ppfas-factsheets
npm run refresh:nippon-factsheets
npm run refresh:uti-factsheets
npm run refresh:invesco-factsheets
npm run refresh:mirae-factsheets
npm run refresh:canara-factsheets
npm run refresh:baroda-factsheets
npm run refresh:edelweiss-factsheets
npm run refresh:tata-factsheets
npm run refresh:motilal-factsheets
npm run refresh:hsbc-factsheets
npm run refresh:franklin-factsheets
npm run refresh:dsp-factsheets

# Refresh every validated official AMC factsheet source
npm run refresh:all-factsheets

# Inspect discontinued/stale scheme cleanup candidates (does not delete)
npm run cleanup:schemes
```

Historical one-time imports are available when their source archives are present:

```powershell
npm run import:history
npm run backfill:amfi-history
```

The historical NAV importer is resumable. To replay an already-downloaded daily AMFI NAV file without a network request:

```powershell
npm run import:daily-nav -- raw/navall_YYYY-MM-DD.txt
```

## Project structure

```text
web/       Vue frontend and browser-side calculations
server/    Express API over local SQLite source data
scripts/   Source importers, mappers, refreshers and data-quality utilities
config/    Benchmark and application mapping configuration
data/      Local SQLite database (ignored by Git)
raw/       Downloaded source files (ignored by Git)
docs/      Methodology notes
```

## Development checks

```powershell
npx vite build --config web/vite.config.js
node --check scripts/map-amfi-ter.js
```

## Important limitations

- This is an analytical tool, not investment advice.
- Data availability and AMC disclosure formats change; every importer should be monitored for source changes.
- Gross-before-TER, benchmark alpha and portfolio statistics are calculations based on the available source history and should be interpreted alongside the stated coverage/date.
- A missing benchmark or portfolio disclosure produces no comparison/section rather than a proxy result.
