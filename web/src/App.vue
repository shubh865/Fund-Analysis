<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

const search = ref('');
const schemes = ref([]);
const loading = ref(false);
const error = ref('');
const schemeStructure = ref('all');
const schemeMainCategory = ref('');
const schemeSubcategory = ref('');
const schemePlan = ref('all');
const selected = ref(null);
const history = ref([]);
const benchmarkHistory = ref([]);
const riskFreeRates = ref([]);
const categoryPeerHistories = ref({});
const categoryCaptureLoading = ref(false);
const planPair = ref(null);
const planPairHistory = ref([]);
const holdings = ref([]);
const holdingPortfolio = ref(null);
const holdingsLoading = ref(false);
const fundSnapshot = ref({ aaum: [], ter: [] });
const fundSnapshotLoading = ref(false);
const debtQuartile = ref(null);
const debtQuartileLoading = ref(false);
const detailLoading = ref(false);
const selectedRange = ref('1Y');
const ranges = { '1Y': 12, '3Y': 36, '5Y': 60, All: null };
const directRegularRange = ref('5Y');
const directRegularRanges = { '1Y': 12, '3Y': 36, '5Y': 60, '10Y': 120, All: null };
const directRegularInvestment = ref(100000);
const riskYears = ref(3);
const view = ref('schemes');
const categories = ref([]);
const latestNavMonth = ref('');
const quartileMainCategory = ref('');
const quartileCategory = ref('');
const quartileYears = ref(1);
const quartileAsOf = ref('');
const quartileRows = ref([]);
const quartileLoading = ref(false);
const compareSearch = ref('');
const compareResults = ref([]);
const compareSelection = ref([]);
const compareLoading = ref(false);
const peerMainCategory = ref('');
const peerCategory = ref('');
const peerPeriod = ref(1);
const peerPlan = ref('direct');
const peerRows = ref([]);
const peerBenchmark = ref(null);
const peerLoading = ref(false);
const peerSort = ref({ key: 'alpha', direction: 'desc' });
const analysisMode = ref('peers');
let searchTimer;

const displaySchemes = computed(() => schemes.value.slice(0, 50));

async function loadSchemes() {
  loading.value = true;
  error.value = '';
  try {
    const sourceCategories = selectedSchemeSubcategory.value?.sourceCategories || (schemeMainCategory.value ? categories.value
      .filter((item) => quartileGroup(item.category) === schemeMainCategory.value)
      .map((item) => item.category) : []);
    const response = await fetch(`/api/schemes?q=${encodeURIComponent(search.value)}&structure=${encodeURIComponent(schemeStructure.value)}&plan=${encodeURIComponent(schemePlan.value)}&categories=${encodeURIComponent(JSON.stringify(sourceCategories))}&limit=50`);
    if (!response.ok) throw new Error('Could not load schemes. Import the daily NAV file first.');
    schemes.value = (await response.json()).schemes;
  } catch (requestError) {
    error.value = requestError.message;
  } finally {
    loading.value = false;
  }
}

async function loadCategories() {
  const response = await fetch('/api/categories');
  if (!response.ok) throw new Error('Could not load categories.');
  const payload = await response.json();
  categories.value = payload.categories;
  latestNavMonth.value = payload.latest_nav_date?.slice(0, 7) || '';
  if (!quartileAsOf.value) quartileAsOf.value = latestNavMonth.value;
}

// AMFI has both current and legacy category labels. The raw label stays in
// the database; this layer only makes the Quartile picker easier to navigate.
function quartileGroup(category) {
  const value = String(category || '');
  if (/^(Equity Scheme|ELSS$|Growth$|Index Funds - Equity|Exchange Traded Funds \(ETFs\) - Equity)/i.test(value)) return 'Equity';
  if (/^(Debt Scheme|Income\/Debt Oriented Schemes|Income$|Gilt$|Money Market$|Index Funds - Debt|Exchange Traded Funds \(ETFs\) - Debt)/i.test(value)) return 'Debt';
  if (/^Hybrid Scheme/i.test(value)) return 'Hybrid';
  return 'Other';
}

function quartileSubcategoryLabel(category) {
  return String(category || '')
    .replace(/^(Equity|Debt|Hybrid) Schemes? - /i, '')
    .replace(/^Income\/Debt Oriented Schemes - /i, '')
    .replace(/^Exchange Traded Funds \(ETFs\) - /i, '')
    .replace(/^Index Funds - /i, 'Index fund · ');
}

const quartileMainCategories = computed(() => ['Equity', 'Debt', 'Hybrid', 'Other']
  .filter((group) => categories.value.some((item) => quartileGroup(item.category) === group)));
function groupedSubcategories(mainCategory) {
  const grouped = new Map();
  for (const item of categories.value.filter((entry) => quartileGroup(entry.category) === mainCategory)) {
    const label = quartileSubcategoryLabel(item.category);
    const group = grouped.get(label) || { label, sourceCategories: [] };
    group.sourceCategories.push(item.category);
    grouped.set(label, group);
  }
  return [...grouped.values()].sort((left, right) => left.label.localeCompare(right.label));
}

const quartileSubcategories = computed(() => groupedSubcategories(quartileMainCategory.value));
const schemeMainCategories = quartileMainCategories;
const schemeSubcategories = computed(() => groupedSubcategories(schemeMainCategory.value));
const peerMainCategories = quartileMainCategories;
const peerSubcategories = computed(() => groupedSubcategories(peerMainCategory.value));

const selectedQuartileSubcategory = computed(() => quartileSubcategories.value
  .find((item) => item.label === quartileCategory.value) || null);
const selectedSchemeSubcategory = computed(() => schemeSubcategories.value
  .find((item) => item.label === schemeSubcategory.value) || null);
const selectedPeerSubcategory = computed(() => peerSubcategories.value
  .find((item) => item.label === peerCategory.value) || null);

function selectQuartileMainCategory() {
  quartileCategory.value = '';
  quartileRows.value = [];
}

function selectSchemeMainCategory() {
  schemeSubcategory.value = '';
  loadSchemes();
}

function updateSchemeFilter() {
  loadSchemes();
}

function selectPeerMainCategory() {
  peerCategory.value = '';
  peerRows.value = [];
  peerBenchmark.value = null;
}

async function loadQuartiles() {
  if (!quartileCategory.value) return;
  quartileLoading.value = true;
  error.value = '';
  try {
    const sourceCategories = selectedQuartileSubcategory.value?.sourceCategories || [];
    if (!sourceCategories.length) return;
    const response = await fetch(`/api/categories/${encodeURIComponent(quartileCategory.value)}/nav-snapshot?years=${quartileYears.value}&asOf=${encodeURIComponent(quartileAsOf.value)}&plans=growth-direct-regular&categories=${encodeURIComponent(JSON.stringify(sourceCategories))}`);
    if (!response.ok) throw new Error('Could not load raw NAV observations for this quartile view.');
    quartileRows.value = (await response.json()).schemes;
  } catch (requestError) {
    error.value = requestError.message;
  } finally {
    quartileLoading.value = false;
  }
}

function setQuartileYears(years) {
  quartileYears.value = years;
  loadQuartiles();
}

function growthPlanType(name) {
  const normalized = name.toLowerCase();
  if (!normalized.includes('growth') || /\b(idcw|dividend|payout|reinvestment|bonus)\b/.test(normalized)) return null;
  if (/\bdirect\b/.test(normalized)) return 'direct';
  // AMFI names many Regular Growth plans without writing the word “Regular”.
  // Within a Growth-plan pair, anything not explicitly Direct is the regular leg.
  return 'regular';
}

function planFamily(name) {
  return name.toUpperCase()
    .replace(/\bFLEXICAP\b/g, 'FLEXI CAP')
    .replace(/\bMIDCAP\b/g, 'MID CAP')
    .replace(/\bOWSAL\b/g, 'OSWAL')
    .replace(/\b(DIRECT|REGULAR|STANDARD|PLAN|GROWTH|OPTION|FUND)\b/g, ' ')
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function snapshotReturn(row, years) {
  if (!Number.isFinite(row.latest_nav) || !Number.isFinite(row.start_nav) || row.start_nav <= 0) return null;
  const totalReturn = row.latest_nav / row.start_nav;
  if (years === 1) return (totalReturn - 1) * 100;
  const elapsedDays = (Date.parse(`${row.latest_date}T00:00:00Z`) - Date.parse(`${row.start_date}T00:00:00Z`)) / 86_400_000;
  return elapsedDays > 0 ? (Math.pow(totalReturn, 365.2425 / elapsedDays) - 1) * 100 : null;
}

const quartileTables = computed(() => {
  const families = new Map();
  for (const row of quartileRows.value) {
    const type = growthPlanType(row.name);
    const value = snapshotReturn(row, quartileYears.value);
    if (!type || !Number.isFinite(value)) continue;
    const key = planFamily(row.name);
    const entry = families.get(key) || { family: key, direct: null, regular: null };
    // A family can occasionally have duplicate plan records; prefer the one
    // with the latest source NAV date.
    if (!entry[type] || row.latest_date > entry[type].latest_date) entry[type] = { ...row, value };
    families.set(key, entry);
  }
  const ranked = [...families.values()]
    .filter((entry) => entry.direct || entry.regular)
    .map((entry) => ({
      ...entry,
      rankingValue: entry.direct?.value ?? entry.regular?.value,
      name: entry.direct?.name ?? entry.regular?.name,
      amc: entry.direct?.amc ?? entry.regular?.amc,
    }))
    .sort((left, right) => right.rankingValue - left.rankingValue);
  const includedAmcs = new Set();
  const topTwentyAmcs = ranked.filter((entry) => {
    // The first occurrence is each AMC's highest-ranked eligible Growth fund.
    if (!entry.amc || includedAmcs.has(entry.amc) || includedAmcs.size >= 20) return false;
    includedAmcs.add(entry.amc);
    return true;
  });
  return [0, 1, 2, 3].map((quartile) => ({
    label: `Q${quartile + 1}`,
    subtitle: ['Top 25%', 'Next 25%', 'Next 25%', 'Bottom 25%'][quartile],
    rows: topTwentyAmcs.filter((_, index) => Math.min(3, Math.floor(index * 4 / topTwentyAmcs.length)) === quartile),
  }));
});

async function showQuartiles() {
  view.value = 'quartiles';
  if (!categories.value.length) {
    try { await loadCategories(); } catch (requestError) { error.value = requestError.message; }
  }
}

async function showCompare() {
  view.value = 'peers';
  analysisMode.value = 'selected';
  compareResults.value = [];
}

async function showPeerAnalysis() {
  view.value = 'peers';
  analysisMode.value = 'peers';
  if (!categories.value.length) {
    try { await loadCategories(); } catch (requestError) { error.value = requestError.message; }
  }
}

function subtractCalendarYears(dateString, years) {
  const date = new Date(`${dateString}T00:00:00Z`);
  const month = date.getUTCMonth();
  date.setUTCFullYear(date.getUTCFullYear() - years);
  // 29 February becomes 28 February in a non-leap target year.
  if (date.getUTCMonth() !== month) date.setUTCDate(0);
  return date.toISOString().slice(0, 10);
}

function previousPoint(points, dateString) {
  const index = points.findIndex((point) => point.date === dateString);
  return index > 0 ? points[index - 1] : null;
}

function peerRollingMetrics(fundHistory, benchmarkHistory) {
  if (!fundHistory?.length || !benchmarkHistory?.length) return {};
  const benchmarkByDate = new Map(benchmarkHistory.map((point) => [point.date, point.value]));
  return Object.fromEntries([1, 2, 3, 4, 5].map((years) => {
    const fundReturns = [];
    const benchmarkReturns = [];
    let wins = 0;
    for (const end of fundHistory) {
      const benchmarkEnd = benchmarkByDate.get(end.date);
      if (!Number.isFinite(benchmarkEnd)) continue;
      const targetDate = subtractCalendarYears(end.date, years);
      let start = latestPointOnOrBefore(fundHistory, targetDate);
      // Fund and benchmark must use the same available start date, matching
      // the date-validation step in the user's Excel method.
      while (start && !benchmarkByDate.has(start.date)) {
        start = previousPoint(fundHistory, start.date);
      }
      if (!start || start.date === end.date) continue;
      const elapsedDays = (Date.parse(`${end.date}T00:00:00Z`) - Date.parse(`${start.date}T00:00:00Z`)) / 86_400_000;
      if (elapsedDays <= 0) continue;
      const annualisation = 365.2425 / elapsedDays;
      const fundReturn = (Math.pow(end.nav / start.nav, annualisation) - 1) * 100;
      const benchmarkReturn = (Math.pow(benchmarkEnd / benchmarkByDate.get(start.date), annualisation) - 1) * 100;
      if (!Number.isFinite(fundReturn) || !Number.isFinite(benchmarkReturn)) continue;
      fundReturns.push(fundReturn);
      benchmarkReturns.push(benchmarkReturn);
      if (fundReturn > benchmarkReturn) wins += 1;
    }
    if (!fundReturns.length) return [years, null];
    const averageFund = fundReturns.reduce((sum, value) => sum + value, 0) / fundReturns.length;
    const averageBenchmark = benchmarkReturns.reduce((sum, value) => sum + value, 0) / benchmarkReturns.length;
    return [years, {
      averageFund,
      averageBenchmark,
      alpha: averageFund - averageBenchmark,
      consistency: (wins / fundReturns.length) * 100,
      observations: fundReturns.length,
    }];
  }));
}

async function loadPeerAnalysis() {
  if (!peerCategory.value) return;
  peerLoading.value = true;
  error.value = '';
  try {
    const sourceCategories = selectedPeerSubcategory.value?.sourceCategories || [];
    if (!sourceCategories.length) return;
    const response = await fetch(`/api/categories/${encodeURIComponent(peerCategory.value)}/peer-nav-history?plan=${encodeURIComponent(peerPlan.value)}&categories=${encodeURIComponent(JSON.stringify(sourceCategories))}`);
    if (!response.ok) throw new Error('Could not load raw NAV and benchmark TRI histories for this category.');
    const payload = await response.json();
    peerBenchmark.value = payload.benchmark;
    // Yield once so the loading state is visible before the browser performs
    // the deliberately frontend-only rolling calculations.
    await new Promise((resolve) => setTimeout(resolve, 0));
    peerRows.value = payload.schemes
      .map((scheme) => ({
        ...scheme,
        metrics: peerRollingMetrics(payload.histories[scheme.scheme_code], payload.benchmark_history),
      }))
      .filter((scheme) => scheme.metrics[peerPeriod.value])
      .sort((left, right) => right.metrics[peerPeriod.value].alpha - left.metrics[peerPeriod.value].alpha);
  } catch (requestError) {
    error.value = requestError.message;
    peerRows.value = [];
    peerBenchmark.value = null;
  } finally {
    peerLoading.value = false;
  }
}

const visiblePeerRows = computed(() => peerRows.value
  .filter((row) => row.metrics[peerPeriod.value])
  .sort((left, right) => {
    const direction = peerSort.value.direction === 'desc' ? -1 : 1;
    const metricDifference = (left.metrics[peerPeriod.value][peerSort.value.key] - right.metrics[peerPeriod.value][peerSort.value.key]) * direction;
    if (metricDifference) return metricDifference;
    return right.metrics[peerPeriod.value].alpha - left.metrics[peerPeriod.value].alpha;
  }));

function togglePeerSort(key) {
  peerSort.value = peerSort.value.key === key
    ? { key, direction: peerSort.value.direction === 'desc' ? 'asc' : 'desc' }
    : { key, direction: 'desc' };
}

function setPeerPeriod(years) {
  peerPeriod.value = years;
}

async function searchCompare() {
  const query = compareSearch.value.trim();
  if (query.length < 2) return;
  compareLoading.value = true;
  error.value = '';
  try {
    const response = await fetch(`/api/schemes?q=${encodeURIComponent(query)}&limit=12`);
    if (!response.ok) throw new Error('Could not search schemes for comparison.');
    compareResults.value = (await response.json()).schemes;
  } catch (requestError) {
    error.value = requestError.message;
  } finally {
    compareLoading.value = false;
  }
}

async function addToComparison(scheme) {
  if (compareSelection.value.some((item) => item.scheme.scheme_code === scheme.scheme_code) || compareSelection.value.length >= 5) return;
  compareLoading.value = true;
  error.value = '';
  try {
    const response = await fetch(`/api/schemes/${encodeURIComponent(scheme.scheme_code)}/nav-history`);
    if (!response.ok) throw new Error('Could not load this scheme for comparison.');
    const payload = await response.json();
    compareSelection.value = [...compareSelection.value, { scheme: payload.scheme, history: payload.history, benchmarkHistory: payload.benchmark_history || [] }];
    compareSearch.value = '';
    compareResults.value = [];
  } catch (requestError) {
    error.value = requestError.message;
  } finally {
    compareLoading.value = false;
  }
}

function removeFromComparison(schemeCode) {
  compareSelection.value = compareSelection.value.filter((item) => item.scheme.scheme_code !== schemeCode);
}

function queueSearch() {
  clearTimeout(searchTimer);
  // One character creates too many unhelpful matches across the full AMFI list.
  if (search.value.trim().length === 1) return;
  searchTimer = setTimeout(loadSchemes, 250);
}

function setSchemeStructure(structure) {
  schemeStructure.value = structure;
  loadSchemes();
}

function formatNav(nav) {
  return Number.isFinite(nav) ? nav.toFixed(4) : '—';
}

function formatCurrency(value) {
  return Number.isFinite(value)
    ? new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(value)
    : '—';
}

function returnFromMonths(months, annualised = false) {
  if (history.value.length < 2) return null;
  const latest = history.value.at(-1);
  const target = new Date(`${latest.date}T00:00:00Z`);
  target.setUTCMonth(target.getUTCMonth() - months);
  const startingNav = [...history.value].reverse().find((point) => point.date <= target.toISOString().slice(0, 10));
  if (!startingNav) return null;
  const totalReturn = latest.nav / startingNav.nav;
  if (!annualised) return (totalReturn - 1) * 100;
  const elapsedDays = (Date.parse(`${latest.date}T00:00:00Z`) - Date.parse(`${startingNav.date}T00:00:00Z`)) / 86_400_000;
  return elapsedDays > 0 ? (Math.pow(totalReturn, 365.2425 / elapsedDays) - 1) * 100 : null;
}

const returnPeriods = computed(() => [
  { label: '1M', value: returnFromMonths(1) }, { label: '3M', value: returnFromMonths(3) }, { label: '6M', value: returnFromMonths(6) },
  { label: '1Y', value: returnFromMonths(12) }, { label: '3Y', value: returnFromMonths(36, true), annualised: true }, { label: '5Y', value: returnFromMonths(60, true), annualised: true }
]);

function returnForPeriod(points, months, annualised = false, endDate = null) {
  if (points.length < 2 || !endDate) return null;
  const end = latestPointOnOrBefore(points, endDate);
  if (!end) return null;
  const target = new Date(`${endDate}T00:00:00Z`);
  target.setUTCMonth(target.getUTCMonth() - months);
  const start = latestPointOnOrBefore(points, target.toISOString().slice(0, 10));
  if (!start || start.date === end.date) return null;
  const totalReturn = end.value / start.value;
  const elapsedDays = (Date.parse(`${end.date}T00:00:00Z`) - Date.parse(`${start.date}T00:00:00Z`)) / 86_400_000;
  if (!Number.isFinite(totalReturn) || elapsedDays <= 0) return null;
  return annualised ? (Math.pow(totalReturn, 365.2425 / elapsedDays) - 1) * 100 : (totalReturn - 1) * 100;
}

const compareRows = computed(() => compareSelection.value.map((item) => {
  const fundPoints = item.history.map((point) => ({ date: point.date, value: point.nav }));
  const fundEnd = fundPoints.at(-1)?.date;
  const returns = {
    oneYear: returnForPeriod(fundPoints, 12, false, fundEnd),
    threeYear: returnForPeriod(fundPoints, 36, true, fundEnd),
    fiveYear: returnForPeriod(fundPoints, 60, true, fundEnd),
  };
  const benchmarkOutperformance = { oneYear: null, threeYear: null, fiveYear: null };
  if (item.benchmarkHistory.length && fundEnd) {
    const commonEnd = [fundEnd, item.benchmarkHistory.at(-1).date].sort()[0];
    const comparisonPeriods = [
      ['oneYear', 12, false], ['threeYear', 36, true], ['fiveYear', 60, true],
    ];
    for (const [key, months, annualised] of comparisonPeriods) {
      const fundReturn = returnForPeriod(fundPoints, months, annualised, commonEnd);
      const benchmarkReturn = returnForPeriod(item.benchmarkHistory, months, annualised, commonEnd);
      if (fundReturn !== null && benchmarkReturn !== null) benchmarkOutperformance[key] = fundReturn - benchmarkReturn;
    }
  }
  return {
    ...item,
    latestNav: item.history.at(-1)?.nav ?? null,
    returns,
    benchmarkOutperformance,
  };
}));

const benchmarkComparison = computed(() => {
  if (!selected.value?.benchmark_name || !benchmarkHistory.value.length || !history.value.length) return null;
  const fundAsValues = history.value.map((point) => ({ date: point.date, value: point.nav }));
  const commonEnd = [history.value.at(-1).date, benchmarkHistory.value.at(-1).date].sort()[0];
  const periods = [
    { label: '1Y', months: 12, annualised: false },
    { label: '3Y', months: 36, annualised: true },
    { label: '5Y', months: 60, annualised: true },
  ].map((period) => {
    const fund = returnForPeriod(fundAsValues, period.months, period.annualised, commonEnd);
    const benchmark = returnForPeriod(benchmarkHistory.value, period.months, period.annualised, commonEnd);
    return { ...period, fund, benchmark, outperformance: fund === null || benchmark === null ? null : fund - benchmark };
  });
  return { asOf: commonEnd, periods };
});

function latestPointOnOrBefore(points, targetDate) {
  let low = 0;
  let high = points.length - 1;
  let match = -1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (points[middle].date <= targetDate) {
      match = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return match >= 0 ? points[match] : null;
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function sampleStandardDeviation(values) {
  if (values.length < 2) return null;
  const average = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + ((value - average) ** 2), 0) / (values.length - 1));
}

function commonDailyReturns(fundHistory, benchmarkPoints, years) {
  const benchmarkByDate = new Map(benchmarkPoints.map((point) => [point.date, point.value]));
  const commonPoints = fundHistory
    .filter((point) => Number.isFinite(benchmarkByDate.get(point.date)))
    .map((point) => ({ date: point.date, fund: point.nav, benchmark: benchmarkByDate.get(point.date) }));
  if (commonPoints.length < 2) return [];
  const end = commonPoints.at(-1);
  const startDate = subtractCalendarYears(end.date, years);
  const start = latestPointOnOrBefore(commonPoints, startDate);
  if (!start) return [];
  const startIndex = commonPoints.findIndex((point) => point.date === start.date);
  const returns = [];
  for (let index = startIndex + 1; index < commonPoints.length; index += 1) {
    const previous = commonPoints[index - 1];
    const current = commonPoints[index];
    const fund = (current.fund / previous.fund) - 1;
    const benchmark = (current.benchmark / previous.benchmark) - 1;
    if (Number.isFinite(fund) && Number.isFinite(benchmark)) returns.push({ date: current.date, fund, benchmark });
  }
  return returns;
}

function fundDailyReturns(fundHistory, years) {
  if (fundHistory.length < 2) return [];
  const end = fundHistory.at(-1);
  const startDate = subtractCalendarYears(end.date, years);
  const start = latestPointOnOrBefore(fundHistory, startDate);
  if (!start) return [];
  const startIndex = fundHistory.findIndex((point) => point.date === start.date);
  const returns = [];
  for (let index = startIndex + 1; index < fundHistory.length; index += 1) {
    const previous = fundHistory[index - 1];
    const current = fundHistory[index];
    const fund = (current.nav / previous.nav) - 1;
    if (Number.isFinite(fund)) returns.push({ date: current.date, fund });
  }
  return returns;
}

function annualisedSharpe(fundReturns, rates) {
  if (fundReturns.length < 20 || !rates.length) return null;
  const rateByDate = new Map(rates.map((rate) => [rate.date, rate.annual_rate_percent]));
  let lastRate = null;
  const excess = [];
  for (const point of fundReturns) {
    if (rateByDate.has(point.date)) lastRate = rateByDate.get(point.date);
    if (!Number.isFinite(lastRate)) continue;
    const dailyRiskFree = Math.pow(1 + (lastRate / 100), 1 / 252) - 1;
    excess.push(point.fund - dailyRiskFree);
  }
  const deviation = sampleStandardDeviation(excess);
  return deviation && deviation > 0 ? (mean(excess) / deviation) * Math.sqrt(252) : null;
}

function maximumDrawdown(points, valueKey) {
  let peak = -Infinity;
  let worst = 0;
  for (const point of points) {
    const value = point[valueKey];
    if (!Number.isFinite(value) || value <= 0) continue;
    peak = Math.max(peak, value);
    worst = Math.min(worst, (value / peak) - 1);
  }
  return peak > 0 ? worst * 100 : null;
}

function monthlyReturnPairs(dailyReturns) {
  const months = new Map();
  for (const point of dailyReturns) {
    const key = point.date.slice(0, 7);
    const prior = months.get(key) || { fund: 1, benchmark: 1 };
    months.set(key, { fund: prior.fund * (1 + point.fund), benchmark: prior.benchmark * (1 + point.benchmark) });
  }
  return [...months.values()].map((month) => ({ fund: month.fund - 1, benchmark: month.benchmark - 1 }));
}

function captureRatio(months, direction, comparisonKey = 'benchmark') {
  const relevant = months.filter((month) => (direction === 'up' ? month[comparisonKey] > 0 : month[comparisonKey] < 0));
  if (!relevant.length) return null;
  const fundReturn = relevant.reduce((product, month) => product * (1 + month.fund), 1) - 1;
  const comparisonReturn = relevant.reduce((product, month) => product * (1 + month[comparisonKey]), 1) - 1;
  return comparisonReturn !== 0 ? (fundReturn / comparisonReturn) * 100 : null;
}

function categoryMonthlyReturnPairs(fundHistory, peerHistories, years) {
  if (!fundHistory.length || !Object.keys(peerHistories || {}).length) return [];
  const cutoff = subtractCalendarYears(fundHistory.at(-1).date, years);
  const peerDailyReturns = new Map();
  for (const peerHistory of Object.values(peerHistories)) {
    for (let index = 1; index < peerHistory.length; index += 1) {
      const previous = peerHistory[index - 1];
      const current = peerHistory[index];
      const value = (current.nav / previous.nav) - 1;
      if (!Number.isFinite(value) || current.date < cutoff) continue;
      const entries = peerDailyReturns.get(current.date) || [];
      entries.push(value);
      peerDailyReturns.set(current.date, entries);
    }
  }
  const fundDailyReturnsByDate = new Map();
  for (let index = 1; index < fundHistory.length; index += 1) {
    const previous = fundHistory[index - 1];
    const current = fundHistory[index];
    const value = (current.nav / previous.nav) - 1;
    if (Number.isFinite(value) && current.date >= cutoff) fundDailyReturnsByDate.set(current.date, value);
  }
  const months = new Map();
  for (const [date, fund] of fundDailyReturnsByDate) {
    const peerReturns = peerDailyReturns.get(date);
    if (!peerReturns?.length) continue;
    const key = date.slice(0, 7);
    const prior = months.get(key) || { fund: 1, category: 1 };
    months.set(key, { fund: prior.fund * (1 + fund), category: prior.category * (1 + mean(peerReturns)) });
  }
  return [...months.values()].map((month) => ({ fund: month.fund - 1, category: month.category - 1 }));
}

function selectedCategoryPlan(name) {
  const normalized = String(name || '').toLowerCase();
  const direct = /\bdirect\b/.test(normalized);
  const idcw = /\b(idcw|dividend|payout|reinvestment|bonus)\b/.test(normalized);
  if (idcw) return direct ? 'direct-idcw' : 'regular-idcw';
  return direct ? 'direct' : 'regular';
}

const categoryCapture = computed(() => {
  const months = categoryMonthlyReturnPairs(history.value, categoryPeerHistories.value, riskYears.value);
  if (months.length < 3) return null;
  return {
    months: months.length,
    upside: captureRatio(months, 'up', 'category'),
    downside: captureRatio(months, 'down', 'category'),
  };
});

const riskMetrics = computed(() => {
  if (!history.value.length) return null;
  const fundOnlyReturns = fundDailyReturns(history.value, riskYears.value);
  if (fundOnlyReturns.length < 20) return null;
  const dailyReturns = benchmarkHistory.value.length ? commonDailyReturns(history.value, benchmarkHistory.value, riskYears.value) : [];
  const hasBenchmark = dailyReturns.length >= 20;
  const fundReturns = dailyReturns.map((point) => point.fund);
  const benchmarkReturns = dailyReturns.map((point) => point.benchmark);
  const activeReturns = dailyReturns.map((point) => point.fund - point.benchmark);
  const benchmarkAverage = mean(benchmarkReturns);
  const covariance = mean(dailyReturns.map((point) => (point.fund - mean(fundReturns)) * (point.benchmark - benchmarkAverage)));
  const benchmarkVariance = mean(benchmarkReturns.map((value) => (value - benchmarkAverage) ** 2));
  const monthlyReturns = monthlyReturnPairs(dailyReturns);
  // Drawdown needs the actual aligned price path, so reconstruct it from the daily return stream.
  let fundLevel = 1;
  let benchmarkLevel = 1;
  const levels = [{ fund: fundLevel, benchmark: benchmarkLevel }];
  for (const point of dailyReturns) {
    fundLevel *= 1 + point.fund;
    benchmarkLevel *= 1 + point.benchmark;
    levels.push({ fund: fundLevel, benchmark: benchmarkLevel });
  }
  return {
    years: riskYears.value,
    observations: fundOnlyReturns.length,
    fundDrawdown: maximumDrawdown([{ fund: 1 }, ...fundOnlyReturns.reduce((levels, point) => {
      levels.push({ fund: levels.at(-1).fund * (1 + point.fund) });
      return levels;
    }, [{ fund: 1 }]).slice(1)], 'fund'),
    annualVolatility: (sampleStandardDeviation(fundOnlyReturns.map((point) => point.fund)) ?? 0) * Math.sqrt(252) * 100,
    sharpe: annualisedSharpe(fundOnlyReturns, riskFreeRates.value),
    benchmarkDrawdown: hasBenchmark ? maximumDrawdown(levels, 'benchmark') : null,
    beta: hasBenchmark && benchmarkVariance > 0 ? covariance / benchmarkVariance : null,
    trackingError: hasBenchmark ? (sampleStandardDeviation(activeReturns) ?? 0) * Math.sqrt(252) * 100 : null,
    upsideCapture: hasBenchmark ? captureRatio(monthlyReturns, 'up') : null,
    downsideCapture: hasBenchmark ? captureRatio(monthlyReturns, 'down') : null,
    hasBenchmark,
  };
});

const debtOneYearRisk = computed(() => {
  if (!isDebtScheme.value) return null;
  const returns = fundDailyReturns(history.value, 1);
  if (returns.length < 20) return null;
  return {
    annualVolatility: (sampleStandardDeviation(returns.map((point) => point.fund)) ?? 0) * Math.sqrt(252) * 100,
    sharpe: annualisedSharpe(returns, riskFreeRates.value),
  };
});

const directRegularComparison = computed(() => {
  if (!selected.value || !planPair.value || !history.value.length || !planPairHistory.value.length) return null;
  const selectedType = growthPlanType(selected.value.name);
  if (!selectedType) return null;
  const directHistory = selectedType === 'direct' ? history.value : planPairHistory.value;
  const regularHistory = selectedType === 'regular' ? history.value : planPairHistory.value;
  const regularByDate = new Map(regularHistory.map((point) => [point.date, point.nav]));
  const commonPoints = directHistory
    .filter((point) => regularByDate.has(point.date))
    .map((point) => ({ date: point.date, directNav: point.nav, regularNav: regularByDate.get(point.date) }));
  if (commonPoints.length < 2) return null;
  const end = commonPoints.at(-1);
  const months = directRegularRanges[directRegularRange.value];
  let start = commonPoints[0];
  if (months) {
    const target = new Date(`${end.date}T00:00:00Z`);
    target.setUTCMonth(target.getUTCMonth() - months);
    start = latestPointOnOrBefore(commonPoints, target.toISOString().slice(0, 10));
  }
  if (!start || start.date === end.date) return null;
  const principal = Number.isFinite(directRegularInvestment.value) && directRegularInvestment.value > 0
    ? directRegularInvestment.value
    : 100000;
  const directValue = principal * (end.directNav / start.directNav);
  const regularValue = principal * (end.regularNav / start.regularNav);
  const directReturn = (directValue / principal - 1) * 100;
  const regularReturn = (regularValue / principal - 1) * 100;
  return {
    principal,
    startDate: start.date,
    endDate: end.date,
    directValue,
    regularValue,
    rupeeGap: directValue - regularValue,
    returnGap: directReturn - regularReturn,
    directReturn,
    regularReturn,
  };
});

function disclosureLabel(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function isDisclosureSummaryRow(holding) {
  const name = disclosureLabel(holding.instrument_name);
  return !name
    || /^(?:net assets?|total|sub.?total|benchmark|nav as on|as on\b|number of contracts?|gross notional|at the end|instrument type|% of investment)/i.test(name)
    || /returns?\s*\(\s*annualised\s*\)/i.test(name);
}

function isNonSectorLabel(value) {
  const label = disclosureLabel(value);
  if (!label) return true;
  return /^(?:n\.?a\.?|na|0|-|others?|portfolio holding|sov(?:ereign)?|long|short)$/i.test(label)
    || /^(?:as on|nav as on|number of contracts?|gross notional|net receivable|current (?:option )?price|option price|futures? price|benchmark|instrument type|% of investment|at the end)/i.test(label)
    || /(?:\bA1\+?\b|\bAAA\b|\bAA[+-]?\b|\bBBB[+-]?\b|\bSOVEREIGN\b)/i.test(label)
    || /^-?\d+(?:\.\d+)?$/.test(label)
    || /(?:repo|cash|money market|net current|mutual fund|ETF units?|debt|derivative|T-?bill|government securit)/i.test(label);
}

function disclosedSector(holding) {
  const industry = disclosureLabel(holding.industry_or_rating);
  if (!isNonSectorLabel(industry)) return industry;
  const assetClass = disclosureLabel(holding.asset_class);
  if (!isNonSectorLabel(assetClass) && !/^equity(?:\s+shares?|(?:\s*&\s*equity related).*)?$/i.test(assetClass)) return assetClass;
  return null;
}

function sectorKey(value) {
  return value.toLowerCase().replace(/\band\b/g, '&').replace(/\s+/g, ' ').trim();
}

const usableHoldings = computed(() => holdings.value
  .filter((holding) => Number.isFinite(holding.weight)
    && holding.weight > 0
    && holding.weight <= 1.05
    && !isDisclosureSummaryRow(holding)));

const topHoldings = computed(() => usableHoldings.value
  .sort((left, right) => right.weight - left.weight)
  .slice(0, 10));

const sectorAllocation = computed(() => {
  const sectors = new Map();
  for (const holding of usableHoldings.value) {
    const name = disclosedSector(holding);
    if (!name) continue;
    const key = sectorKey(name);
    const sector = sectors.get(key) || { name, weight: 0 };
    sector.weight += holding.weight;
    sectors.set(key, sector);
  }
  return [...sectors.values()]
    .sort((left, right) => right.weight - left.weight)
    .slice(0, 10);
});

function maturityDateFromHolding(name) {
  const match = String(name || '').match(/\((\d{1,2})\/(\d{1,2})\/(\d{4})\)/);
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[3]), Number(match[2]) - 1, Number(match[1])));
  return Number.isNaN(date.getTime()) ? null : date;
}

function creditBucket(value) {
  const rating = String(value || '').toUpperCase();
  if (/SOVEREIGN|GOVERNMENT|T-?BILL|TREPS|REPO/.test(rating)) return 'Sovereign / cash';
  const match = rating.match(/\b(AAA|AA\+|AA|AA-|A\+|A|A-|BBB\+|BBB|BBB-|BB\+|BB|BB-|B\+|B|B-)\b/);
  return match ? match[1] : null;
}

const debtPortfolioStats = computed(() => {
  if (!isDebtScheme.value || !holdingPortfolio.value) return null;
  const asOf = new Date(`${holdingPortfolio.value.as_of_date}T00:00:00Z`);
  let yieldWeight = 0;
  let weightedYield = 0;
  let maturityWeight = 0;
  let weightedYears = 0;
  const ratings = new Map();
  for (const holding of holdings.value) {
    if (!Number.isFinite(holding.weight) || holding.weight <= 0) continue;
    if (Number.isFinite(holding.yield)) {
      weightedYield += holding.yield * holding.weight;
      yieldWeight += holding.weight;
    }
    const maturity = maturityDateFromHolding(holding.instrument_name);
    if (maturity && maturity > asOf) {
      weightedYears += ((maturity - asOf) / 86_400_000 / 365.2425) * holding.weight;
      maturityWeight += holding.weight;
    }
    const bucket = creditBucket(holding.industry_or_rating);
    if (bucket) ratings.set(bucket, (ratings.get(bucket) || 0) + holding.weight);
  }
  return {
    weightedYield: yieldWeight > 0 ? weightedYield / yieldWeight : null,
    weightedResidualMaturity: maturityWeight > 0 ? weightedYears / maturityWeight : null,
    ratedWeight: [...ratings.values()].reduce((sum, value) => sum + value, 0),
    ratings: [...ratings.entries()].map(([name, weight]) => ({ name, weight })).sort((left, right) => right.weight - left.weight).slice(0, 8),
  };
});

const aaumHistory = computed(() => fundSnapshot.value.aaum || []);
const latestAaum = computed(() => aaumHistory.value.at(-1) || null);
const aaumChange = computed(() => {
  if (aaumHistory.value.length < 2) return null;
  const latest = aaumHistory.value.at(-1)?.aaum_excluding_domestic_fof_lakh;
  const previous = aaumHistory.value.at(-2)?.aaum_excluding_domestic_fof_lakh;
  if (!Number.isFinite(latest) || !Number.isFinite(previous) || previous <= 0) return null;
  return ((latest / previous) - 1) * 100;
});
const selectedTerHistory = computed(() => (fundSnapshot.value.ter || [])
  .map((point) => ({ ...point, value: point.plan_type === 'direct' ? point.direct_ter : point.regular_ter }))
  .filter((point) => Number.isFinite(point.value)));
const latestTer = computed(() => selectedTerHistory.value.at(-1) || null);
const snapshotPlanLabel = computed(() => selectedTerHistory.value[0]?.plan_type === 'direct' ? 'Direct' : 'Regular');
const isDebtScheme = computed(() => /^debt scheme\b/i.test(selected.value?.category || ''));
const debtSnapshot = computed(() => {
  if (!isDebtScheme.value || !selected.value) return null;
  return {
    totalAum: selected.value.total_aum_crore,
    totalAumDate: selected.value.total_aum_date,
    riskometer: selected.value.riskometer_scheme,
    directTer: latestTer.value?.direct_ter ?? null,
    regularTer: latestTer.value?.regular_ter ?? null,
    quartile: debtQuartile.value,
  };
});

function calculateDebtQuartile(snapshotSchemes, scheme) {
  const selectedPlan = growthPlanType(scheme.name);
  if (!selectedPlan) return null;
  const eligible = snapshotSchemes
    .filter((row) => growthPlanType(row.name) === selectedPlan && Number.isFinite(row.latest_nav) && Number.isFinite(row.start_nav) && row.start_nav > 0)
    .map((row) => ({ ...row, returnValue: ((row.latest_nav / row.start_nav) - 1) * 100 }))
    .sort((left, right) => right.returnValue - left.returnValue);
  const rank = eligible.findIndex((row) => row.scheme_code === scheme.scheme_code);
  if (rank < 0) return null;
  return { value: Math.min(4, Math.floor((rank * 4) / eligible.length) + 1), rank: rank + 1, total: eligible.length };
}

function formatAaum(lakh) {
  if (!Number.isFinite(lakh)) return '—';
  const crore = lakh / 100;
  if (crore >= 100000) return `₹${(crore / 100000).toFixed(2)}L cr`;
  if (crore >= 1000) return `₹${(crore / 1000).toFixed(1)}K cr`;
  return `₹${crore.toFixed(crore >= 100 ? 0 : 1)} cr`;
}

function formatTotalAum(crore) {
  if (!Number.isFinite(crore)) return '—';
  if (crore >= 100000) return `₹${(crore / 100000).toFixed(2)}L Cr`;
  if (crore >= 1000) return `₹${(crore / 1000).toFixed(1)}K Cr`;
  return `₹${crore.toLocaleString('en-IN', { maximumFractionDigits: 0 })} Cr`;
}

function buildRollingReturns(years) {
  const points = history.value;
  const results = [];
  for (const end of points) {
    const target = new Date(`${end.date}T00:00:00Z`);
    target.setUTCFullYear(target.getUTCFullYear() - years);
    const start = latestPointOnOrBefore(points, target.toISOString().slice(0, 10));
    if (!start || start.date === end.date) continue;
    const elapsedDays = (Date.parse(`${end.date}T00:00:00Z`) - Date.parse(`${start.date}T00:00:00Z`)) / 86_400_000;
    const value = (Math.pow(end.nav / start.nav, 365.2425 / elapsedDays) - 1) * 100;
    if (Number.isFinite(value)) results.push({ date: end.date, value });
  }
  return results;
}

const rollingAverages = computed(() => [1, 2, 3, 4, 5].map((years) => {
  const values = buildRollingReturns(years);
  const average = values.length ? values.reduce((sum, point) => sum + point.value, 0) / values.length : null;
  return { years, average, observations: values.length };
}));

const chartHistory = computed(() => {
  if (!history.value.length) return [];
  const months = ranges[selectedRange.value];
  const latestDate = history.value.at(-1).date;
  if (!months) return history.value;
  const cutoff = new Date(`${latestDate}T00:00:00Z`);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - months);
  return history.value.filter((point) => point.date >= cutoff.toISOString().slice(0, 10));
});

const chartPoints = computed(() => {
  const fundPoints = chartHistory.value;
  const benchmarkByDate = new Map(benchmarkHistory.value.map((point) => [point.date, point.value]));
  const alignedPoints = fundPoints
    .filter((point) => Number.isFinite(benchmarkByDate.get(point.date)))
    .map((point) => ({ ...point, benchmark: benchmarkByDate.get(point.date) }));
  if (alignedPoints.length < 2) return { comparison: false, points: fundPoints.map((point) => ({ ...point, fundValue: point.nav })) };
  const first = alignedPoints[0];
  return {
    comparison: true,
    points: alignedPoints.map((point) => ({
      ...point,
      fundValue: (point.nav / first.nav) * 100,
      benchmarkValue: (point.benchmark / first.benchmark) * 100,
    })),
  };
});

const plottedHistory = computed(() => {
  const points = chartPoints.value.points;
  const limit = 420;
  if (points.length <= limit) return points;
  const step = Math.ceil(points.length / limit);
  return points.filter((_, index) => index % step === 0 || index === points.length - 1);
});

const chart = computed(() => {
  const points = plottedHistory.value;
  if (points.length < 2) return null;
  const width = 720;
  const height = 250;
  const padding = { top: 18, right: 14, bottom: 30, left: 58 };
  const comparison = chartPoints.value.comparison;
  const values = comparison
    ? points.flatMap((point) => [point.fundValue, point.benchmarkValue])
    : points.map((point) => point.fundValue);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || Math.max(max * 0.02, 1);
  const x = (index) => padding.left + (index / (points.length - 1)) * (width - padding.left - padding.right);
  const y = (value) => padding.top + ((max - value) / span) * (height - padding.top - padding.bottom);
  return {
    width, height, padding, min, max,
    comparison,
    fundPolyline: points.map((point, index) => `${x(index).toFixed(1)},${y(point.fundValue).toFixed(1)}`).join(' '),
    benchmarkPolyline: comparison ? points.map((point, index) => `${x(index).toFixed(1)},${y(point.benchmarkValue).toFixed(1)}`).join(' ') : null,
    start: points[0], end: points.at(-1),
    endFundY: y(points.at(-1).fundValue),
    endBenchmarkY: comparison ? y(points.at(-1).benchmarkValue) : null,
  };
});

async function openScheme(schemeCode) {
  detailLoading.value = true;
  error.value = '';
  holdings.value = [];
  holdingPortfolio.value = null;
  holdingsLoading.value = true;
  fundSnapshot.value = { aaum: [], ter: [] };
  fundSnapshotLoading.value = true;
  debtQuartile.value = null;
  debtQuartileLoading.value = false;
  categoryPeerHistories.value = {};
  categoryCaptureLoading.value = false;
  try {
    const [response, holdingsResponse, snapshotResponse] = await Promise.all([
      fetch(`/api/schemes/${encodeURIComponent(schemeCode)}/nav-history`),
      fetch(`/api/schemes/${encodeURIComponent(schemeCode)}/holdings`),
      fetch(`/api/schemes/${encodeURIComponent(schemeCode)}/fund-snapshot`),
    ]);
    if (!response.ok) throw new Error('Could not load this scheme’s NAV history.');
    const payload = await response.json();
    selected.value = payload.scheme;
    history.value = payload.history;
    benchmarkHistory.value = payload.benchmark_history || [];
    riskFreeRates.value = payload.risk_free_rates || [];
    planPair.value = payload.plan_pair || null;
    planPairHistory.value = payload.plan_pair_history || [];
    selectedRange.value = '1Y';
    directRegularRange.value = '5Y';
    riskYears.value = 3;
    if (payload.scheme.category) {
      categoryCaptureLoading.value = true;
      try {
        const peerResponse = await fetch(`/api/categories/${encodeURIComponent(payload.scheme.category)}/category-nav-history?plan=${encodeURIComponent(selectedCategoryPlan(payload.scheme.name))}&excludeScheme=${encodeURIComponent(payload.scheme.scheme_code)}`);
        if (peerResponse.ok) categoryPeerHistories.value = (await peerResponse.json()).histories || {};
      } finally {
        categoryCaptureLoading.value = false;
      }
    }
    if (/^debt scheme\b/i.test(payload.scheme.category || '')) {
      debtQuartileLoading.value = true;
      try {
        const quartileResponse = await fetch(`/api/categories/${encodeURIComponent(payload.scheme.category)}/nav-snapshot?years=1&plans=growth-direct-regular`);
        if (quartileResponse.ok) debtQuartile.value = calculateDebtQuartile((await quartileResponse.json()).schemes || [], payload.scheme);
      } finally {
        debtQuartileLoading.value = false;
      }
    }
    if (holdingsResponse.ok) {
      const holdingsPayload = await holdingsResponse.json();
      holdings.value = holdingsPayload.holdings || [];
      holdingPortfolio.value = holdingsPayload.portfolio || null;
    }
    if (snapshotResponse.ok) fundSnapshot.value = await snapshotResponse.json();
  } catch (requestError) {
    error.value = requestError.message;
  } finally {
    detailLoading.value = false;
    holdingsLoading.value = false;
    fundSnapshotLoading.value = false;
  }
}

function closeDetail() {
  selected.value = null;
  history.value = [];
  benchmarkHistory.value = [];
  riskFreeRates.value = [];
  planPair.value = null;
  planPairHistory.value = [];
  holdings.value = [];
  holdingPortfolio.value = null;
  fundSnapshot.value = { aaum: [], ter: [] };
  debtQuartile.value = null;
  categoryPeerHistories.value = {};
}

onMounted(async () => {
  await Promise.all([loadSchemes(), loadCategories()]);
});
onBeforeUnmount(() => clearTimeout(searchTimer));
</script>

<template>
  <main class="shell">
    <header>
      <p class="eyebrow"><span class="brand-mark">◆</span> Mutual fund analytics</p>
      <h1>Explore every scheme.<br><em>Start with its NAV.</em></h1>
      <div class="view-switch"><button :class="{ active: view === 'schemes' }" @click="view = 'schemes'">Schemes</button><button :class="{ active: view === 'quartiles' }" @click="showQuartiles">Quartiles</button><button :class="{ active: view === 'peers' }" @click="showPeerAnalysis">Peer analysis</button></div>
    </header>

    <section v-if="view === 'quartiles' && !selected" class="card category-browser quartile-browser" aria-label="Category quartiles">
      <div class="category-controls">
        <label for="quartile-main-category">Category</label>
        <select id="quartile-main-category" v-model="quartileMainCategory" @change="selectQuartileMainCategory"><option value="">Select a category</option><option v-for="category in quartileMainCategories" :key="category" :value="category">{{ category }}</option></select>
        <label for="quartile-subcategory">Subcategory</label>
        <select id="quartile-subcategory" v-model="quartileCategory" :disabled="!quartileMainCategory" @change="loadQuartiles"><option value="">Select a subcategory</option><option v-for="category in quartileSubcategories" :key="category.label" :value="category.label">{{ category.label }}</option></select>
        <label for="quartile-as-of">As of month</label>
        <input id="quartile-as-of" v-model="quartileAsOf" type="month" :max="latestNavMonth" @change="loadQuartiles">
        <div class="period-buttons" aria-label="Quartile return period"><button v-for="years in [1, 3, 5]" :key="years" type="button" :class="{ active: quartileYears === years }" :disabled="!quartileCategory" @click="setQuartileYears(years)">{{ years }}Y{{ years > 1 ? ' CAGR' : '' }}</button></div>
      </div>
      <p v-if="error" class="message error">{{ error }}</p>
      <p v-else-if="!quartileCategory" class="message">Choose a category and subcategory to split paired Growth plans into performance quartiles.</p>
      <p v-else-if="quartileLoading" class="message">Loading raw NAV observations…</p>
      <template v-else>
        <p class="quartile-note">The first 20 AMCs are chosen by their highest-ranked eligible Growth fund. Q1 holds the top 25% of that AMC set by Direct Growth return where available; Regular Growth is used only when a Direct plan does not exist. Both plan returns are shown.</p>
        <div class="quartile-grid">
          <section v-for="table in quartileTables" :key="table.label" class="quartile-table" :aria-label="`${table.label} ${table.subtitle}`">
            <header><strong>{{ table.label }}</strong><span>{{ table.subtitle }}</span></header>
            <div class="quartile-head"><span>Fund</span><span>Direct Growth</span><span>Regular Growth</span></div>
            <button v-for="entry in table.rows" :key="entry.family" class="quartile-row" @click="openScheme((entry.direct ?? entry.regular).scheme_code)"><span>{{ entry.name }}</span><strong :class="{ positive: entry.direct?.value > 0, negative: entry.direct?.value < 0 }">{{ entry.direct ? `${entry.direct.value >= 0 ? '+' : ''}${entry.direct.value.toFixed(2)}%` : '—' }}</strong><strong :class="{ positive: entry.regular?.value > 0, negative: entry.regular?.value < 0 }">{{ entry.regular ? `${entry.regular.value >= 0 ? '+' : ''}${entry.regular.value.toFixed(2)}%` : '—' }}</strong></button>
            <p v-if="!table.rows.length" class="quartile-empty">No eligible paired Growth plans.</p>
          </section>
        </div>
      </template>
    </section>

    <section v-else-if="view === 'peers' && analysisMode === 'selected' && !selected" class="card compare-browser" aria-label="Fund comparison">
      <div class="analysis-mode-switch"><button :class="{ active: analysisMode === 'selected' }" @click="analysisMode = 'selected'">Selected funds</button><button :class="{ active: analysisMode === 'peers' }" @click="analysisMode = 'peers'">Category peers</button></div>
      <div class="compare-intro"><div><p class="eyebrow">Comparison workspace</p><h2>Compare up to five schemes</h2><p>Returns and rolling averages are calculated from the stored NAV series in your browser.</p></div><span>{{ compareSelection.length }} / 5 selected</span></div>
      <div class="compare-search"><input v-model="compareSearch" @keyup.enter="searchCompare" placeholder="Search a scheme to add"><button :disabled="compareLoading || compareSearch.trim().length < 2 || compareSelection.length >= 5" @click="searchCompare">{{ compareLoading ? 'Loading…' : 'Add scheme' }}</button></div>
      <p v-if="error" class="message error">{{ error }}</p>
      <div v-if="compareResults.length" class="compare-results"><button v-for="scheme in compareResults" :key="scheme.scheme_code" :disabled="compareSelection.some((item) => item.scheme.scheme_code === scheme.scheme_code) || compareSelection.length >= 5" @click="addToComparison(scheme)"><span><strong>{{ scheme.name }}</strong><small>{{ scheme.amc }} · {{ scheme.category || 'Category not supplied' }}</small></span><span>+ Add</span></button></div>
      <p v-else-if="!compareSelection.length" class="message">Search for the first scheme you would like to compare.</p>
      <div v-if="compareRows.length" class="compare-matrix-wrap"><div class="compare-matrix"><div class="compare-matrix-head"><span>Scheme</span><span>NAV</span><span>Total AUM</span><span>1Y</span><span>3Y CAGR</span><span>5Y CAGR</span><span>1Y alpha</span><span>3Y alpha</span><span>5Y alpha</span><span></span></div><div v-for="row in compareRows" :key="row.scheme.scheme_code" class="compare-matrix-row"><span class="compare-scheme"><strong>{{ row.scheme.name }}</strong><small>{{ row.scheme.amc }} · {{ row.scheme.category || 'Category not supplied' }}</small></span><strong data-label="NAV">{{ formatNav(row.latestNav) }}</strong><strong data-label="Total AUM">{{ row.scheme.total_aum_crore === null || row.scheme.total_aum_crore === undefined ? '—' : `₹${row.scheme.total_aum_crore.toLocaleString('en-IN', { maximumFractionDigits: 0 })} Cr` }}</strong><strong data-label="1Y" :class="{ positive: row.returns.oneYear > 0, negative: row.returns.oneYear < 0 }">{{ row.returns.oneYear === null ? '—' : `${row.returns.oneYear >= 0 ? '+' : ''}${row.returns.oneYear.toFixed(2)}%` }}</strong><strong data-label="3Y CAGR" :class="{ positive: row.returns.threeYear > 0, negative: row.returns.threeYear < 0 }">{{ row.returns.threeYear === null ? '—' : `${row.returns.threeYear >= 0 ? '+' : ''}${row.returns.threeYear.toFixed(2)}%` }}</strong><strong data-label="5Y CAGR" :class="{ positive: row.returns.fiveYear > 0, negative: row.returns.fiveYear < 0 }">{{ row.returns.fiveYear === null ? '—' : `${row.returns.fiveYear >= 0 ? '+' : ''}${row.returns.fiveYear.toFixed(2)}%` }}</strong><strong data-label="1Y alpha" :class="{ positive: row.benchmarkOutperformance.oneYear > 0, negative: row.benchmarkOutperformance.oneYear < 0 }">{{ row.benchmarkOutperformance.oneYear === null ? '—' : `${row.benchmarkOutperformance.oneYear >= 0 ? '+' : ''}${row.benchmarkOutperformance.oneYear.toFixed(2)}%` }}</strong><strong data-label="3Y alpha" :class="{ positive: row.benchmarkOutperformance.threeYear > 0, negative: row.benchmarkOutperformance.threeYear < 0 }">{{ row.benchmarkOutperformance.threeYear === null ? '—' : `${row.benchmarkOutperformance.threeYear >= 0 ? '+' : ''}${row.benchmarkOutperformance.threeYear.toFixed(2)}%` }}</strong><strong data-label="5Y alpha" :class="{ positive: row.benchmarkOutperformance.fiveYear > 0, negative: row.benchmarkOutperformance.fiveYear < 0 }">{{ row.benchmarkOutperformance.fiveYear === null ? '—' : `${row.benchmarkOutperformance.fiveYear >= 0 ? '+' : ''}${row.benchmarkOutperformance.fiveYear.toFixed(2)}%` }}</strong><button class="remove-compare" aria-label="Remove scheme" @click="removeFromComparison(row.scheme.scheme_code)">×</button></div></div></div>
      <p v-if="compareRows.length" class="compare-footnote">Alpha is fund return minus its mapped benchmark return.</p>
    </section>

    <section v-else-if="view === 'peers' && !selected" class="card peer-browser" aria-label="Peer analysis">
      <div class="analysis-mode-switch"><button :class="{ active: analysisMode === 'selected' }" @click="analysisMode = 'selected'">Selected funds</button><button :class="{ active: analysisMode === 'peers' }" @click="analysisMode = 'peers'">Category peers</button></div>
      <div class="compare-intro"><div><p class="eyebrow">Peer analysis</p><h2>Compare a whole category</h2><p>Average every possible holding period, then see which peers beat their benchmark most consistently.</p></div><span>{{ visiblePeerRows.length }} eligible plans</span></div>
      <div class="peer-controls">
        <div><label for="peer-main-category">Category</label><select id="peer-main-category" v-model="peerMainCategory" @change="selectPeerMainCategory"><option value="">Select a category</option><option v-for="category in peerMainCategories" :key="category" :value="category">{{ category }}</option></select></div>
        <div><label for="peer-category">Subcategory</label><select id="peer-category" v-model="peerCategory" :disabled="!peerMainCategory" @change="loadPeerAnalysis"><option value="">Select a subcategory</option><option v-for="category in peerSubcategories" :key="category.label" :value="category.label">{{ category.label }}</option></select></div>
        <div><label for="peer-plan">Plans</label><select id="peer-plan" v-model="peerPlan" :disabled="!peerCategory" @change="loadPeerAnalysis"><option value="direct">Direct Growth</option><option value="regular">Regular Growth</option><option value="all-growth">All Growth plans</option><option value="direct-idcw">Direct IDCW</option><option value="regular-idcw">Regular IDCW</option></select></div>
      </div>
      <div class="peer-period"><span>Holding period</span><div class="period-buttons"><button v-for="years in [1, 2, 3, 4, 5]" :key="years" type="button" :class="{ active: peerPeriod === years }" :disabled="!peerRows.length" @click="setPeerPeriod(years)">{{ years }}Y</button></div></div>
      <p v-if="peerBenchmark" class="peer-benchmark">Benchmark: <strong>{{ peerBenchmark.name }}</strong><small>{{ peerBenchmark.mapping_status }} category mapping · calculated in your browser from raw NAV and TRI observations</small></p>
      <p v-if="!peerCategory" class="message">Choose a category to analyse its peer funds.</p>
      <p v-else-if="peerLoading" class="message">Loading source histories and calculating rolling peer metrics…</p>
      <p v-else-if="!visiblePeerRows.length" class="message">No eligible Growth plans have enough matching NAV and benchmark TRI history for this period.</p>
      <div v-else class="peer-table-wrap"><div class="peer-table"><div class="peer-head"><span>Scheme</span><span>Fund avg</span><span>Benchmark avg</span><button type="button" class="peer-sort" @click="togglePeerSort('alpha')">Alpha {{ peerSort.key === 'alpha' ? (peerSort.direction === 'desc' ? '↓' : '↑') : '↕' }}</button><button type="button" class="peer-sort" @click="togglePeerSort('consistency')">Consistency {{ peerSort.key === 'consistency' ? (peerSort.direction === 'desc' ? '↓' : '↑') : '↕' }}</button></div><button v-for="row in visiblePeerRows" :key="row.scheme_code" class="peer-row" @click="openScheme(row.scheme_code)"><span><strong>{{ row.name }}</strong><small>{{ row.amc }}</small></span><strong data-label="Fund avg" :class="{ positive: row.metrics[peerPeriod].averageFund > 0, negative: row.metrics[peerPeriod].averageFund < 0 }">{{ row.metrics[peerPeriod].averageFund.toFixed(2) }}%</strong><strong data-label="Benchmark avg" :class="{ positive: row.metrics[peerPeriod].averageBenchmark > 0, negative: row.metrics[peerPeriod].averageBenchmark < 0 }">{{ row.metrics[peerPeriod].averageBenchmark.toFixed(2) }}%</strong><strong data-label="Alpha" :class="{ positive: row.metrics[peerPeriod].alpha > 0, negative: row.metrics[peerPeriod].alpha < 0 }">{{ row.metrics[peerPeriod].alpha >= 0 ? '+' : '' }}{{ row.metrics[peerPeriod].alpha.toFixed(2) }}%</strong><strong data-label="Consistency">{{ row.metrics[peerPeriod].consistency.toFixed(1) }}%</strong></button></div></div>
      <p v-if="visiblePeerRows.length" class="compare-footnote">Each window uses the same available fund NAV and benchmark TRI dates. Alpha means average fund return minus average benchmark return; consistency is the share of windows where the fund beat the benchmark.</p>
    </section>

    <section v-else-if="selected" class="detail card" aria-label="Scheme detail">
      <button class="back" @click="closeDetail">← All schemes</button>
      <div class="detail-heading">
        <div><p class="eyebrow">{{ selected.category || selected.amc || 'AMFI scheme' }} · {{ selected.scheme_code }}</p><h2>{{ selected.name }}</h2><p class="scheme-category">{{ selected.amc }}<template v-if="selected.category"> · {{ selected.category }}</template></p><p v-if="selected.benchmark_name" class="benchmark-note"><span>Reference benchmark</span>{{ selected.benchmark_name }} <em>provisional category default</em></p></div>
        <div class="nav"><strong>{{ formatNav(selected.latest_nav) }}</strong><span>NAV · {{ selected.latest_nav_date }}</span></div>
      </div>
      <section v-if="fundSnapshotLoading || latestAaum || latestTer || holdingPortfolio" class="fund-snapshot" aria-label="Fund snapshot">
        <div class="snapshot-heading"><div><p class="eyebrow">Fund snapshot</p><h3>Scale, cost & disclosure</h3></div><p>Source observations<small>Calculated context stays in your browser</small></p></div>
        <p v-if="fundSnapshotLoading" class="snapshot-message">Loading AAUM and TER source history…</p>
        <div v-else class="snapshot-grid">
          <div><span>Latest reported AAUM</span><strong>{{ latestAaum ? formatAaum(latestAaum.aaum_excluding_domestic_fof_lakh) : '—' }}</strong><small>{{ latestAaum ? `${latestAaum.period_label} · AMFI average AUM` : 'No AMFI AAUM linked yet' }}</small></div>
          <div><span>AAUM movement</span><strong :class="{ positive: aaumChange > 0, negative: aaumChange < 0 }">{{ aaumChange === null ? '—' : `${aaumChange >= 0 ? '+' : ''}${aaumChange.toFixed(1)}%` }}</strong><small>{{ aaumChange === null ? 'Needs two reporting periods' : 'Versus previous reporting period' }}</small></div>
          <div><span>{{ snapshotPlanLabel }} TER</span><strong>{{ latestTer ? `${latestTer.value.toFixed(2)}%` : '—' }}</strong><small>{{ latestTer ? `${latestTer.date} · AMFI daily disclosure` : 'No TER mapping linked yet' }}</small></div>
          <div><span>Portfolio disclosure</span><strong>{{ holdingPortfolio ? 'Available' : 'Not imported' }}</strong><small>{{ holdingPortfolio ? `${holdingPortfolio.as_of_date} · ${holdingPortfolio.name}` : 'Shown only when an AMC disclosure is mapped' }}</small></div>
        </div>
        <p v-if="!fundSnapshotLoading" class="snapshot-note">AAUM uses AMFI’s reported average AUM, not month-end AUM. TER is already reflected in NAV and is shown here as a separate cost observation.</p>
      </section>
      <section class="returns" aria-label="Point-to-point returns">
        <div class="returns-heading"><div><p class="eyebrow">Return snapshot</p><h3>Point-to-point returns</h3></div><p>Latest NAV date<small>{{ selected.latest_nav_date }}</small></p></div>
        <div v-for="period in returnPeriods" :key="period.label" class="return-item">
          <span>{{ period.label }}<small v-if="period.annualised">annualised</small></span><strong :class="{ positive: period.value > 0, negative: period.value < 0 }">{{ period.value === null ? '—' : `${period.value >= 0 ? '+' : ''}${period.value.toFixed(2)}%` }}</strong>
        </div>
      </section>
      <section v-if="benchmarkComparison" class="comparison-section" aria-label="Fund versus benchmark comparison">
        <div class="comparison-heading"><div><p class="eyebrow">Fund vs benchmark</p><h3>{{ selected.benchmark_name }}</h3></div><p>Aligned to {{ benchmarkComparison.asOf }}<small>{{ selected.benchmark_mapping_status }} category default</small></p></div>
        <div class="comparison-table">
          <div class="comparison-row comparison-labels"><span>Period</span><span>Fund</span><span>Benchmark</span><span>Outperformance</span></div>
          <div v-for="period in benchmarkComparison.periods" :key="period.label" class="comparison-row"><span>{{ period.label }}<small v-if="period.annualised">CAGR</small></span><strong :class="{ positive: period.fund > 0, negative: period.fund < 0 }">{{ period.fund === null ? '—' : `${period.fund >= 0 ? '+' : ''}${period.fund.toFixed(2)}%` }}</strong><strong :class="{ positive: period.benchmark > 0, negative: period.benchmark < 0 }">{{ period.benchmark === null ? '—' : `${period.benchmark >= 0 ? '+' : ''}${period.benchmark.toFixed(2)}%` }}</strong><strong :class="{ positive: period.outperformance > 0, negative: period.outperformance < 0 }">{{ period.outperformance === null ? '—' : `${period.outperformance >= 0 ? '+' : ''}${period.outperformance.toFixed(2)}%` }}</strong></div>
        </div>
        <p class="comparison-note">Fund NAV and benchmark TRI are source observations; all returns and outperformance are calculated in your browser.</p>
      </section>
      <section v-else class="comparison-section comparison-unavailable" aria-label="Fund versus benchmark availability">
        <div class="comparison-heading"><div><p class="eyebrow">Fund vs benchmark</p><h3>Benchmark comparison</h3></div></div>
        <p class="benchmark-unavailable">{{ selected.benchmark_name ? `${selected.benchmark_name} is mapped as a ${selected.benchmark_mapping_status} category default, but its TRI history is not available from the approved source.` : 'No category-wide benchmark is assigned to this scheme. Sectoral and thematic funds need their individually stated benchmark; a broad-market substitute would be misleading.' }}</p>
      </section>
      <section v-if="riskMetrics" class="risk-section" aria-label="Risk and resilience analysis">
        <div class="risk-heading"><div><p class="eyebrow">Risk & resilience</p><h3>How the fund behaved on the way</h3></div><div class="range-controls"><button v-for="years in [1, 3, 5]" :key="years" :class="{ active: riskYears === years }" @click="riskYears = years">{{ years }}Y</button></div></div>
        <div class="risk-grid">
          <div><span>Maximum drawdown</span><strong class="negative">{{ riskMetrics.fundDrawdown === null ? '—' : `${riskMetrics.fundDrawdown.toFixed(2)}%` }}</strong><small>Fund’s largest fall from a prior peak</small></div>
          <div><span>Benchmark drawdown</span><strong class="negative">{{ riskMetrics.benchmarkDrawdown === null ? '—' : `${riskMetrics.benchmarkDrawdown.toFixed(2)}%` }}</strong><small>On the same aligned date range</small></div>
          <div><span>Annualised volatility</span><strong>{{ riskMetrics.annualVolatility.toFixed(2) }}%</strong><small>How much the fund’s daily returns moved</small></div>
          <div><span>Sharpe ratio</span><strong :class="{ positive: riskMetrics.sharpe > 0, negative: riskMetrics.sharpe < 0 }">{{ riskMetrics.sharpe === null ? '—' : riskMetrics.sharpe.toFixed(2) }}</strong><small>Return earned for each unit of volatility</small></div>
          <div><span>Beta</span><strong>{{ riskMetrics.beta === null ? '—' : riskMetrics.beta.toFixed(2) }}</strong><small>Market sensitivity versus benchmark</small></div>
          <div><span>Tracking error</span><strong>{{ riskMetrics.trackingError === null ? '—' : `${riskMetrics.trackingError.toFixed(2)}%` }}</strong><small>How differently it moved from benchmark</small></div>
          <div><span>Upside capture</span><strong :class="{ positive: riskMetrics.upsideCapture > 100 }">{{ riskMetrics.upsideCapture === null ? '—' : `${riskMetrics.upsideCapture.toFixed(0)}%` }}</strong><small>Share of benchmark’s positive months captured</small></div>
          <div><span>Downside capture</span><strong :class="{ positive: riskMetrics.downsideCapture < 100, negative: riskMetrics.downsideCapture > 100 }">{{ riskMetrics.downsideCapture === null ? '—' : `${riskMetrics.downsideCapture.toFixed(0)}%` }}</strong><small>Below 100% means less of benchmark’s fall</small></div>
          <div><span>Category upside capture</span><strong :class="{ positive: categoryCapture?.upside > 100 }">{{ categoryCaptureLoading ? '…' : categoryCapture?.upside === null || !categoryCapture ? '—' : `${categoryCapture.upside.toFixed(0)}%` }}</strong><small>Versus same-category {{ selectedCategoryPlan(selected.name).includes('direct') ? 'Direct' : 'Regular' }} peers</small></div>
          <div><span>Category downside capture</span><strong :class="{ positive: categoryCapture?.downside < 100, negative: categoryCapture?.downside > 100 }">{{ categoryCaptureLoading ? '…' : categoryCapture?.downside === null || !categoryCapture ? '—' : `${categoryCapture.downside.toFixed(0)}%` }}</strong><small>Below 100% means less of the category fall</small></div>
        </div>
        <p class="risk-note">{{ riskMetrics.observations.toLocaleString() }} daily NAV observations. Sharpe uses the official RBI Repo Rate as its risk-free baseline. Category capture is calculated from the equal-weighted monthly returns of comparable same-category plans, excluding this fund.</p>
      </section>
      <section v-else class="risk-section risk-unavailable" aria-label="Risk and resilience availability">
        <div class="risk-heading"><div><p class="eyebrow">Risk & resilience</p><h3>How the fund behaved on the way</h3></div></div>
        <p class="benchmark-unavailable">Risk measures versus a benchmark need matched daily fund NAV and benchmark TRI observations. They will appear once an approved benchmark TRI series is available for this scheme.</p>
      </section>
      <section v-if="debtSnapshot" class="fund-snapshot debt-snapshot" aria-label="Debt fund snapshot">
        <div class="snapshot-heading"><div><p class="eyebrow">Debt snapshot</p><h3>Rate, credit & cost view</h3></div><p>Current source data<small>Portfolio characteristics come next</small></p></div>
        <div class="snapshot-grid debt-snapshot-grid">
          <div><span>Total AUM</span><strong>{{ formatTotalAum(debtSnapshot.totalAum) }}</strong><small>{{ debtSnapshot.totalAumDate ? `AMFI as of ${debtSnapshot.totalAumDate}` : 'No AMFI Total AUM linked yet' }}</small></div>
          <div><span>SEBI Risk-o-meter</span><strong>{{ debtSnapshot.riskometer || '—' }}</strong><small>{{ debtSnapshot.riskometer ? 'Latest AMFI scheme disclosure' : 'No AMFI risk label linked yet' }}</small></div>
          <div><span>Direct TER</span><strong>{{ debtSnapshot.directTer === null ? '—' : `${debtSnapshot.directTer.toFixed(2)}%` }}</strong><small>Latest AMFI daily disclosure</small></div>
          <div><span>Regular TER</span><strong>{{ debtSnapshot.regularTer === null ? '—' : `${debtSnapshot.regularTer.toFixed(2)}%` }}</strong><small>Latest AMFI daily disclosure</small></div>
          <div><span>1Y category quartile</span><strong>{{ debtQuartileLoading ? '…' : debtSnapshot.quartile ? `Q${debtSnapshot.quartile.value}` : '—' }}</strong><small>{{ debtSnapshot.quartile ? `Rank ${debtSnapshot.quartile.rank} of ${debtSnapshot.quartile.total} same-plan peers` : 'Direct/Regular Growth peers only' }}</small></div>
          <div><span>1Y volatility</span><strong>{{ debtOneYearRisk ? `${debtOneYearRisk.annualVolatility.toFixed(2)}%` : '—' }}</strong><small>Annualised daily NAV volatility</small></div>
          <div><span>1Y Sharpe</span><strong :class="{ positive: debtOneYearRisk?.sharpe > 0, negative: debtOneYearRisk?.sharpe < 0 }">{{ debtOneYearRisk?.sharpe === null || !debtOneYearRisk ? '—' : debtOneYearRisk.sharpe.toFixed(2) }}</strong><small>Uses the RBI Repo Rate baseline</small></div>
        </div>
        <p class="snapshot-note">YTM, modified duration, effective maturity and issuer credit ratings require the monthly debt portfolio disclosures, which are the next layer.</p>
      </section>
      <section v-if="directRegularComparison" class="direct-regular-section" aria-label="Direct versus Regular plan cost visualiser">
        <div class="direct-regular-heading"><div><p class="eyebrow">Direct vs Regular</p><h3>What the plan choice cost</h3><p>Same investment on {{ directRegularComparison.startDate }}.</p></div><div class="range-controls"><button v-for="range in Object.keys(directRegularRanges)" :key="range" :class="{ active: directRegularRange === range }" @click="directRegularRange = range">{{ range }}</button></div></div>
        <label class="investment-input" for="direct-regular-investment">Investment amount <input id="direct-regular-investment" v-model.number="directRegularInvestment" type="number" min="1" step="1000" inputmode="numeric"></label>
        <div class="direct-regular-values"><div><span>Direct Growth value</span><strong class="positive">{{ formatCurrency(directRegularComparison.directValue) }}</strong><small>{{ directRegularComparison.directReturn >= 0 ? '+' : '' }}{{ directRegularComparison.directReturn.toFixed(2) }}%</small></div><div><span>Regular Growth value</span><strong>{{ formatCurrency(directRegularComparison.regularValue) }}</strong><small>{{ directRegularComparison.regularReturn >= 0 ? '+' : '' }}{{ directRegularComparison.regularReturn.toFixed(2) }}%</small></div><div class="direct-regular-gap"><span>Direct is ahead by</span><strong class="positive">{{ formatCurrency(directRegularComparison.rupeeGap) }}</strong><small>{{ directRegularComparison.returnGap >= 0 ? '+' : '' }}{{ directRegularComparison.returnGap.toFixed(2) }}% return gap</small></div></div>
        <p>Using matching Direct and Regular Growth NAV dates through {{ directRegularComparison.endDate }}. This is a comparison of NAV outcomes, not a projection.</p>
      </section>
      <section v-if="holdingsLoading || holdingPortfolio" class="holdings-section" aria-label="Portfolio holdings">
        <div class="holdings-heading"><div><p class="eyebrow">Portfolio disclosure</p><h3>{{ debtPortfolioStats ? 'Holdings & credit quality' : 'Holdings & sector allocation' }}</h3></div><p v-if="holdingPortfolio">{{ holdingPortfolio.as_of_date }}<small>{{ holdingPortfolio.amc }} monthly disclosure</small></p></div>
        <p v-if="holdingsLoading" class="holdings-message">Loading raw monthly holdings…</p>
        <template v-else>
          <div v-if="debtPortfolioStats" class="debt-portfolio-summary">
            <div><span>Weighted holding yield</span><strong>{{ debtPortfolioStats.weightedYield === null ? '—' : `${(debtPortfolioStats.weightedYield * 100).toFixed(2)}%` }}</strong><small>Weighted from disclosed security yields</small></div>
            <div><span>Weighted residual maturity</span><strong>{{ debtPortfolioStats.weightedResidualMaturity === null ? '—' : `${debtPortfolioStats.weightedResidualMaturity.toFixed(1)} years` }}</strong><small>Calculated from disclosed maturity dates</small></div>
            <div><span>Rated exposure</span><strong>{{ `${(debtPortfolioStats.ratedWeight * 100).toFixed(1)}%` }}</strong><small>Positions with a recognised credit rating</small></div>
          </div>
          <div class="holdings-grid">
            <div><h4>Top holdings</h4><div class="holdings-list"><div v-for="holding in topHoldings" :key="`${holding.isin}-${holding.instrument_name}`"><span><strong>{{ holding.instrument_name }}</strong><small>{{ holding.industry_or_rating || holding.asset_class || 'Portfolio holding' }}</small></span><b>{{ (holding.weight * 100).toFixed(2) }}%</b></div></div></div>
            <div v-if="debtPortfolioStats"><h4>Credit-quality allocation</h4><div class="holdings-list"><div v-for="rating in debtPortfolioStats.ratings" :key="rating.name"><span><strong>{{ rating.name }}</strong><small>Portfolio exposure</small></span><b>{{ (rating.weight * 100).toFixed(2) }}%</b></div><p v-if="!debtPortfolioStats.ratings.length" class="holdings-message">No recognised credit ratings in this disclosure.</p></div></div>
            <div v-else><h4>Top sectors</h4><div class="holdings-list"><div v-for="sector in sectorAllocation" :key="sector.name"><span><strong>{{ sector.name }}</strong><small>Equity allocation</small></span><b>{{ (sector.weight * 100).toFixed(2) }}%</b></div><p v-if="!sectorAllocation.length" class="holdings-message">Sector allocation is available for equity holdings only.</p></div></div>
          </div>
          <p class="holdings-note">Raw monthly portfolio positions supplied by {{ holdingPortfolio.amc }}. Rankings, credit buckets and weighted measures are calculated in your browser.</p>
        </template>
      </section>
      <p v-if="history.length < 2" class="message">Historical NAV is not loaded yet. Returns will appear here once the archive import is complete.</p>
      <template v-else>
        <section v-if="false" class="rolling-section" aria-label="Average rolling returns">
          <div><p class="eyebrow">Average rolling returns</p><p class="rolling-caption">Annualised average across every available rolling window</p></div>
          <div class="rolling-grid">
            <div v-for="rolling in rollingAverages" :key="rolling.years" class="rolling-item">
              <span>{{ rolling.years }}Y</span>
              <strong :class="{ positive: rolling.average > 0, negative: rolling.average < 0 }">{{ rolling.average === null ? '—' : `${rolling.average >= 0 ? '+' : ''}${rolling.average.toFixed(2)}%` }}</strong>
            </div>
          </div>
        </section>
        <section class="chart-section" aria-label="NAV history chart">
          <div class="chart-header"><div><p class="eyebrow">NAV history</p><h3>{{ chart?.comparison ? 'Fund vs benchmark growth' : `${selectedRange} range` }}</h3><p v-if="chart?.comparison" class="chart-caption">Both lines rebased to 100 on {{ chart.start.date }}</p></div><div><div class="range-controls"><button v-for="range in Object.keys(ranges)" :key="range" :class="{ active: selectedRange === range }" @click="selectedRange = range">{{ range }}</button></div><div v-if="chart?.comparison" class="chart-legend"><span><i class="fund-swatch"></i>Fund</span><span><i class="benchmark-swatch"></i>{{ selected.benchmark_name }}</span></div></div></div>
          <div v-if="chart" class="chart-wrap">
            <svg class="nav-chart" :viewBox="`0 0 ${chart.width} ${chart.height}`" role="img" :aria-label="chart.comparison ? `Fund and benchmark growth from ${chart.start.date} to ${chart.end.date}` : `NAV history from ${chart.start.date} to ${chart.end.date}`">
              <line v-for="fraction in [0, 0.5, 1]" :key="fraction" class="grid-line" :x1="chart.padding.left" :x2="chart.width - chart.padding.right" :y1="chart.padding.top + fraction * (chart.height - chart.padding.top - chart.padding.bottom)" :y2="chart.padding.top + fraction * (chart.height - chart.padding.top - chart.padding.bottom)" />
              <text class="axis-label" :x="chart.padding.left - 8" :y="chart.padding.top + 4" text-anchor="end">{{ chart.comparison ? chart.max.toFixed(1) : formatNav(chart.max) }}</text>
              <text class="axis-label" :x="chart.padding.left - 8" :y="chart.height - chart.padding.bottom + 4" text-anchor="end">{{ chart.comparison ? chart.min.toFixed(1) : formatNav(chart.min) }}</text>
              <polyline v-if="chart.benchmarkPolyline" class="benchmark-line" :points="chart.benchmarkPolyline" fill="none" />
              <polyline class="nav-line" :points="chart.fundPolyline" fill="none" />
              <circle class="endpoint" :cx="chart.width - chart.padding.right" :cy="chart.endFundY" r="4" />
              <circle v-if="chart.endBenchmarkY !== null" class="benchmark-endpoint" :cx="chart.width - chart.padding.right" :cy="chart.endBenchmarkY" r="3.5" />
              <text class="axis-label" :x="chart.padding.left" :y="chart.height - 7">{{ chart.start.date }}</text>
              <text class="axis-label" :x="chart.width - chart.padding.right" :y="chart.height - 7" text-anchor="end">{{ chart.end.date }}</text>
            </svg>
          </div>
        </section>
        <p class="history-note">{{ history.length.toLocaleString() }} NAV observations · {{ history[0].date }} to {{ history.at(-1).date }} · calculated in your browser</p>
      </template>
    </section>

    <section v-else class="card" aria-label="Scheme search">
      <label for="scheme-search">Find a scheme</label>
      <div class="search-row">
        <input id="scheme-search" v-model="search" @input="queueSearch" @keyup.enter="loadSchemes" placeholder="Type any part of a fund name or scheme code" autocomplete="off">
        <button :disabled="loading" @click="loadSchemes">{{ loading ? 'Searching…' : 'Search' }}</button>
      </div>
      <div class="scheme-filter-panel">
        <p>Browse filters</p>
        <div class="scheme-navigation-filters">
          <label><span>Category</span><select v-model="schemeMainCategory" :disabled="loading" @change="selectSchemeMainCategory"><option value="">All categories</option><option v-for="category in schemeMainCategories" :key="category" :value="category">{{ category }}</option></select></label>
          <label><span>Subcategory</span><select v-model="schemeSubcategory" :disabled="loading || !schemeMainCategory" @change="updateSchemeFilter"><option value="">All subcategories</option><option v-for="subcategory in schemeSubcategories" :key="subcategory.label" :value="subcategory.label">{{ subcategory.label }}</option></select></label>
          <label><span>Plan</span><select v-model="schemePlan" :disabled="loading" @change="updateSchemeFilter"><option value="all">All plans</option><option value="direct">Direct</option><option value="regular">Regular Growth</option><option value="idcw">IDCW</option></select></label>
          <div class="scheme-structure-control"><span>Fund structure</span><div class="period-buttons"><button v-for="option in [{ value: 'all', label: 'All' }, { value: 'open', label: 'Open-ended' }, { value: 'closed', label: 'Close-ended' }]" :key="option.value" type="button" :class="{ active: schemeStructure === option.value }" :disabled="loading" @click="setSchemeStructure(option.value)">{{ option.label }}</button></div></div>
        </div>
      </div>
      <p v-if="error" class="message error">{{ error }}</p>
      <p v-else-if="!loading && !schemes.length" class="message">No schemes yet. Run the daily NAV importer to populate this list.</p>
      <div v-else class="results">
        <button v-for="scheme in displaySchemes" :key="scheme.scheme_code" class="scheme" @click="openScheme(scheme.scheme_code)">
          <div><h2>{{ scheme.name }}</h2><p>{{ scheme.category || scheme.amc || 'Category not supplied' }} · Code {{ scheme.scheme_code }}</p></div>
          <div class="nav"><strong>{{ formatNav(scheme.nav) }}</strong><span>NAV · {{ scheme.nav_date ?? '—' }}</span></div>
        </button>
      </div>
    </section>
  </main>
</template>
