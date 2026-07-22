<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

const search = ref('');
const schemes = ref([]);
const loading = ref(false);
const error = ref('');
const selected = ref(null);
const history = ref([]);
const benchmarkHistory = ref([]);
const planPair = ref(null);
const planPairHistory = ref([]);
const detailLoading = ref(false);
const selectedRange = ref('1Y');
const ranges = { '1Y': 12, '3Y': 36, '5Y': 60, All: null };
const directRegularRange = ref('5Y');
const directRegularRanges = { '1Y': 12, '3Y': 36, '5Y': 60, '10Y': 120, All: null };
const view = ref('schemes');
const categories = ref([]);
const selectedCategory = ref('');
const categorySearch = ref('');
const categoryYears = ref(1);
const categoryAsOf = ref('');
const latestNavMonth = ref('');
const categoryRows = ref([]);
const categoryLoading = ref(false);
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
const peerCategory = ref('');
const peerPeriod = ref(1);
const peerPlan = ref('direct');
const peerRows = ref([]);
const peerBenchmark = ref(null);
const peerLoading = ref(false);
const analysisMode = ref('peers');
let searchTimer;

const displaySchemes = computed(() => schemes.value.slice(0, 50));

async function loadSchemes() {
  loading.value = true;
  error.value = '';
  try {
    const response = await fetch(`/api/schemes?q=${encodeURIComponent(search.value)}&limit=50`);
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
  if (!categoryAsOf.value) categoryAsOf.value = latestNavMonth.value;
  if (!quartileAsOf.value) quartileAsOf.value = latestNavMonth.value;
}

async function loadCategoryRanking() {
  if (!selectedCategory.value) return;
  categoryLoading.value = true;
  error.value = '';
  try {
    const response = await fetch(`/api/categories/${encodeURIComponent(selectedCategory.value)}/nav-snapshot?years=${categoryYears.value}&asOf=${encodeURIComponent(categoryAsOf.value)}`);
    if (!response.ok) throw new Error('Could not load category NAV data.');
    categoryRows.value = (await response.json()).schemes;
  } catch (requestError) {
    error.value = requestError.message;
  } finally {
    categoryLoading.value = false;
  }
}

const categoryRankings = computed(() => categoryRows.value
  .filter((row) => Number.isFinite(row.latest_nav) && Number.isFinite(row.start_nav) && row.start_nav > 0)
  .map((row) => {
    const totalReturn = row.latest_nav / row.start_nav;
    const elapsedDays = (Date.parse(`${row.latest_date}T00:00:00Z`) - Date.parse(`${row.start_date}T00:00:00Z`)) / 86_400_000;
    const returnValue = categoryYears.value === 1
      ? (totalReturn - 1) * 100
      : (Math.pow(totalReturn, 365.2425 / elapsedDays) - 1) * 100;
    return { ...row, returnValue };
  })
  .filter((row) => Number.isFinite(row.returnValue))
  .sort((left, right) => right.returnValue - left.returnValue));

const filteredCategories = computed(() => {
  const terms = categorySearch.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return categories.value.filter((category) => terms.every((term) => category.category.toLowerCase().includes(term)));
});

function setCategoryYears(years) {
  categoryYears.value = years;
  loadCategoryRanking();
}

function mainCategory(category) {
  return category.split(' - ')[0].replace(/\s+Schemes?$/i, '');
}

const quartileMainCategories = computed(() => [...new Set(categories.value.map((item) => mainCategory(item.category)))].sort());
const quartileSubcategories = computed(() => categories.value.filter((item) => mainCategory(item.category) === quartileMainCategory.value));

function selectQuartileMainCategory() {
  quartileCategory.value = '';
  quartileRows.value = [];
}

async function loadQuartiles() {
  if (!quartileCategory.value) return;
  quartileLoading.value = true;
  error.value = '';
  try {
    const response = await fetch(`/api/categories/${encodeURIComponent(quartileCategory.value)}/nav-snapshot?years=${quartileYears.value}&asOf=${encodeURIComponent(quartileAsOf.value)}`);
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
  if (!normalized.includes('growth')) return null;
  if (/\bdirect\b/.test(normalized)) return 'direct';
  // AMFI names many Regular Growth plans without writing the word “Regular”.
  // Within a Growth-plan pair, anything not explicitly Direct is the regular leg.
  return 'regular';
}

function planFamily(name) {
  return name.toUpperCase()
    .replace(/\bFLEXICAP\b/g, 'FLEXI CAP')
    .replace(/\b(DIRECT|REGULAR|PLAN|GROWTH|OPTION)\b/g, ' ')
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

async function showCategories() {
  view.value = 'categories';
  if (!categories.value.length) {
    try { await loadCategories(); } catch (requestError) { error.value = requestError.message; }
  }
}

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
    const response = await fetch(`/api/categories/${encodeURIComponent(peerCategory.value)}/peer-nav-history?plan=${encodeURIComponent(peerPlan.value)}`);
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
  .sort((left, right) => right.metrics[peerPeriod.value].alpha - left.metrics[peerPeriod.value].alpha));

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

function averageRollingForHistory(history, years, valueKey = 'nav') {
  const points = history.map((point) => ({ date: point.date, value: point[valueKey] }));
  const values = [];
  for (const end of points) {
    const target = new Date(`${end.date}T00:00:00Z`);
    target.setUTCFullYear(target.getUTCFullYear() - years);
    const start = latestPointOnOrBefore(points, target.toISOString().slice(0, 10));
    if (!start || start.date === end.date) continue;
    const elapsedDays = (Date.parse(`${end.date}T00:00:00Z`) - Date.parse(`${start.date}T00:00:00Z`)) / 86_400_000;
    const value = (Math.pow(end.value / start.value, 365.2425 / elapsedDays) - 1) * 100;
    if (Number.isFinite(value)) values.push(value);
  }
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
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
    rollingOneYear: averageRollingForHistory(item.history, 1),
    rollingThreeYear: averageRollingForHistory(item.history, 3),
    rollingFiveYear: averageRollingForHistory(item.history, 5),
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
  const principal = 100000;
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

const plottedHistory = computed(() => {
  const points = chartHistory.value;
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
  const values = points.map((point) => point.nav);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || Math.max(max * 0.02, 1);
  const x = (index) => padding.left + (index / (points.length - 1)) * (width - padding.left - padding.right);
  const y = (value) => padding.top + ((max - value) / span) * (height - padding.top - padding.bottom);
  return {
    width, height, padding, min, max,
    polyline: points.map((point, index) => `${x(index).toFixed(1)},${y(point.nav).toFixed(1)}`).join(' '),
    start: points[0], end: points.at(-1)
  };
});

async function openScheme(schemeCode) {
  detailLoading.value = true;
  error.value = '';
  try {
    const response = await fetch(`/api/schemes/${encodeURIComponent(schemeCode)}/nav-history`);
    if (!response.ok) throw new Error('Could not load this scheme’s NAV history.');
    const payload = await response.json();
    selected.value = payload.scheme;
    history.value = payload.history;
    benchmarkHistory.value = payload.benchmark_history || [];
    planPair.value = payload.plan_pair || null;
    planPairHistory.value = payload.plan_pair_history || [];
    selectedRange.value = '1Y';
    directRegularRange.value = '5Y';
  } catch (requestError) {
    error.value = requestError.message;
  } finally {
    detailLoading.value = false;
  }
}

function closeDetail() {
  selected.value = null;
  history.value = [];
  benchmarkHistory.value = [];
  planPair.value = null;
  planPairHistory.value = [];
}

onMounted(async () => { await loadSchemes(); });
onBeforeUnmount(() => clearTimeout(searchTimer));
</script>

<template>
  <main class="shell">
    <header>
      <p class="eyebrow"><span class="brand-mark">◆</span> Mutual fund analytics</p>
      <h1>Explore every scheme.<br><em>Start with its NAV.</em></h1>
      <p class="intro">The first local data slice: current AMFI schemes and their latest published NAV.</p>
      <div class="header-meta"><span>Local-first</span><span>NAV-led</span><span>Browser-calculated</span></div>
      <div class="view-switch"><button :class="{ active: view === 'schemes' }" @click="view = 'schemes'">Schemes</button><button :class="{ active: view === 'categories' }" @click="showCategories">Categories</button><button :class="{ active: view === 'quartiles' }" @click="showQuartiles">Quartiles</button><button :class="{ active: view === 'peers' }" @click="showPeerAnalysis">Peer analysis</button></div>
    </header>

    <section v-if="view === 'categories' && !selected" class="card category-browser" aria-label="Category rankings">
      <div class="category-controls">
        <label for="category-search">Search categories</label>
        <input id="category-search" v-model="categorySearch" placeholder="For example: flexi cap, liquid, small cap">
        <label for="category-select">Choose a category</label>
        <select id="category-select" v-model="selectedCategory" @change="loadCategoryRanking"><option value="">Select a category</option><option v-for="category in filteredCategories" :key="category.category" :value="category.category">{{ category.category }} ({{ category.scheme_count }})</option></select>
        <label for="category-as-of">As of month</label>
        <input id="category-as-of" v-model="categoryAsOf" type="month" :max="latestNavMonth" @change="loadCategoryRanking">
        <div class="period-buttons" aria-label="Return period"><button v-for="years in [1, 3, 5]" :key="years" type="button" :class="{ active: categoryYears === years }" :disabled="!selectedCategory" @click="setCategoryYears(years)">{{ years }}Y{{ years > 1 ? ' CAGR' : '' }}</button></div>
      </div>
      <p v-if="error" class="message error">{{ error }}</p>
      <p v-else-if="!selectedCategory" class="message">Choose a category to rank its schemes by return.</p>
      <p v-else-if="categoryLoading" class="message">Loading raw NAV observations…</p>
      <div v-else class="rankings">
        <div class="ranking-head"><span>Rank</span><span>Scheme</span><span>{{ categoryYears }}Y{{ categoryYears > 1 ? ' CAGR' : ' return' }}</span></div>
        <button v-for="(scheme, index) in categoryRankings" :key="scheme.scheme_code" class="ranking-row" @click="openScheme(scheme.scheme_code)"><span>{{ index + 1 }}</span><span><strong>{{ scheme.name }}</strong><small>{{ scheme.amc }}</small></span><span :class="{ positive: scheme.returnValue > 0, negative: scheme.returnValue < 0 }">{{ scheme.returnValue >= 0 ? '+' : '' }}{{ scheme.returnValue.toFixed(2) }}%</span></button>
      </div>
    </section>

    <section v-else-if="view === 'quartiles' && !selected" class="card category-browser quartile-browser" aria-label="Category quartiles">
      <div class="category-controls">
        <label for="quartile-main-category">Category</label>
        <select id="quartile-main-category" v-model="quartileMainCategory" @change="selectQuartileMainCategory"><option value="">Select a category</option><option v-for="category in quartileMainCategories" :key="category" :value="category">{{ category }}</option></select>
        <label for="quartile-subcategory">Subcategory</label>
        <select id="quartile-subcategory" v-model="quartileCategory" :disabled="!quartileMainCategory" @change="loadQuartiles"><option value="">Select a subcategory</option><option v-for="category in quartileSubcategories" :key="category.category" :value="category.category">{{ category.category.replace(`${quartileMainCategory} Scheme - `, '').replace(`${quartileMainCategory} - `, '') }} ({{ category.scheme_count }})</option></select>
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
      <div v-if="compareRows.length" class="compare-matrix-wrap"><div class="compare-matrix"><div class="compare-matrix-head"><span>Scheme</span><span>NAV</span><span>1Y</span><span>3Y CAGR</span><span>5Y CAGR</span><span>Fund avg 1Y rolling</span><span>Fund avg 3Y rolling</span><span>Fund avg 5Y rolling</span><span>1Y vs benchmark</span><span>3Y vs benchmark</span><span>5Y vs benchmark</span><span></span></div><div v-for="row in compareRows" :key="row.scheme.scheme_code" class="compare-matrix-row"><span class="compare-scheme"><strong>{{ row.scheme.name }}</strong><small>{{ row.scheme.amc }} · {{ row.scheme.category || 'Category not supplied' }}</small></span><strong data-label="NAV">{{ formatNav(row.latestNav) }}</strong><strong data-label="1Y" :class="{ positive: row.returns.oneYear > 0, negative: row.returns.oneYear < 0 }">{{ row.returns.oneYear === null ? '—' : `${row.returns.oneYear >= 0 ? '+' : ''}${row.returns.oneYear.toFixed(2)}%` }}</strong><strong data-label="3Y CAGR" :class="{ positive: row.returns.threeYear > 0, negative: row.returns.threeYear < 0 }">{{ row.returns.threeYear === null ? '—' : `${row.returns.threeYear >= 0 ? '+' : ''}${row.returns.threeYear.toFixed(2)}%` }}</strong><strong data-label="5Y CAGR" :class="{ positive: row.returns.fiveYear > 0, negative: row.returns.fiveYear < 0 }">{{ row.returns.fiveYear === null ? '—' : `${row.returns.fiveYear >= 0 ? '+' : ''}${row.returns.fiveYear.toFixed(2)}%` }}</strong><strong data-label="Fund avg 1Y rolling" :class="{ positive: row.rollingOneYear > 0, negative: row.rollingOneYear < 0 }">{{ row.rollingOneYear === null ? '—' : `${row.rollingOneYear >= 0 ? '+' : ''}${row.rollingOneYear.toFixed(2)}%` }}</strong><strong data-label="Fund avg 3Y rolling" :class="{ positive: row.rollingThreeYear > 0, negative: row.rollingThreeYear < 0 }">{{ row.rollingThreeYear === null ? '—' : `${row.rollingThreeYear >= 0 ? '+' : ''}${row.rollingThreeYear.toFixed(2)}%` }}</strong><strong data-label="Fund avg 5Y rolling" :class="{ positive: row.rollingFiveYear > 0, negative: row.rollingFiveYear < 0 }">{{ row.rollingFiveYear === null ? '—' : `${row.rollingFiveYear >= 0 ? '+' : ''}${row.rollingFiveYear.toFixed(2)}%` }}</strong><strong data-label="1Y vs benchmark" :class="{ positive: row.benchmarkOutperformance.oneYear > 0, negative: row.benchmarkOutperformance.oneYear < 0 }">{{ row.benchmarkOutperformance.oneYear === null ? '—' : `${row.benchmarkOutperformance.oneYear >= 0 ? '+' : ''}${row.benchmarkOutperformance.oneYear.toFixed(2)}%` }}</strong><strong data-label="3Y vs benchmark" :class="{ positive: row.benchmarkOutperformance.threeYear > 0, negative: row.benchmarkOutperformance.threeYear < 0 }">{{ row.benchmarkOutperformance.threeYear === null ? '—' : `${row.benchmarkOutperformance.threeYear >= 0 ? '+' : ''}${row.benchmarkOutperformance.threeYear.toFixed(2)}%` }}</strong><strong data-label="5Y vs benchmark" :class="{ positive: row.benchmarkOutperformance.fiveYear > 0, negative: row.benchmarkOutperformance.fiveYear < 0 }">{{ row.benchmarkOutperformance.fiveYear === null ? '—' : `${row.benchmarkOutperformance.fiveYear >= 0 ? '+' : ''}${row.benchmarkOutperformance.fiveYear.toFixed(2)}%` }}</strong><button class="remove-compare" aria-label="Remove scheme" @click="removeFromComparison(row.scheme.scheme_code)">×</button></div></div></div>
      <p v-if="compareRows.length" class="compare-footnote">3Y benchmark comparison is shown only when that scheme’s mapped benchmark has imported TRI history.</p>
    </section>

    <section v-else-if="view === 'peers' && !selected" class="card peer-browser" aria-label="Peer analysis">
      <div class="analysis-mode-switch"><button :class="{ active: analysisMode === 'selected' }" @click="analysisMode = 'selected'">Selected funds</button><button :class="{ active: analysisMode === 'peers' }" @click="analysisMode = 'peers'">Category peers</button></div>
      <div class="compare-intro"><div><p class="eyebrow">Peer analysis</p><h2>Compare a whole category</h2><p>Average every possible holding period, then see which peers beat their benchmark most consistently.</p></div><span>{{ visiblePeerRows.length }} eligible plans</span></div>
      <div class="peer-controls">
        <div><label for="peer-category">Category</label><select id="peer-category" v-model="peerCategory" @change="loadPeerAnalysis"><option value="">Select a category</option><option v-for="category in categories" :key="category.category" :value="category.category">{{ category.category }} ({{ category.scheme_count }})</option></select></div>
        <div><label for="peer-plan">Plans</label><select id="peer-plan" v-model="peerPlan" :disabled="!peerCategory" @change="loadPeerAnalysis"><option value="direct">Direct Growth</option><option value="regular">Regular Growth</option><option value="all-growth">All Growth plans</option></select></div>
      </div>
      <div class="peer-period"><span>Holding period</span><div class="period-buttons"><button v-for="years in [1, 2, 3, 4, 5]" :key="years" type="button" :class="{ active: peerPeriod === years }" :disabled="!peerRows.length" @click="setPeerPeriod(years)">{{ years }}Y</button></div></div>
      <p v-if="peerBenchmark" class="peer-benchmark">Benchmark: <strong>{{ peerBenchmark.name }}</strong><small>{{ peerBenchmark.mapping_status }} category mapping · calculated in your browser from raw NAV and TRI observations</small></p>
      <p v-if="!peerCategory" class="message">Choose a category to analyse its peer funds.</p>
      <p v-else-if="peerLoading" class="message">Loading source histories and calculating rolling peer metrics…</p>
      <p v-else-if="!visiblePeerRows.length" class="message">No eligible Growth plans have enough matching NAV and benchmark TRI history for this period.</p>
      <div v-else class="peer-table-wrap"><div class="peer-table"><div class="peer-head"><span>Scheme</span><span>Fund avg</span><span>Benchmark avg</span><span>Alpha</span><span>Consistency</span></div><button v-for="row in visiblePeerRows" :key="row.scheme_code" class="peer-row" @click="openScheme(row.scheme_code)"><span><strong>{{ row.name }}</strong><small>{{ row.amc }}</small></span><strong data-label="Fund avg" :class="{ positive: row.metrics[peerPeriod].averageFund > 0, negative: row.metrics[peerPeriod].averageFund < 0 }">{{ row.metrics[peerPeriod].averageFund.toFixed(2) }}%</strong><strong data-label="Benchmark avg" :class="{ positive: row.metrics[peerPeriod].averageBenchmark > 0, negative: row.metrics[peerPeriod].averageBenchmark < 0 }">{{ row.metrics[peerPeriod].averageBenchmark.toFixed(2) }}%</strong><strong data-label="Alpha" :class="{ positive: row.metrics[peerPeriod].alpha > 0, negative: row.metrics[peerPeriod].alpha < 0 }">{{ row.metrics[peerPeriod].alpha >= 0 ? '+' : '' }}{{ row.metrics[peerPeriod].alpha.toFixed(2) }}%</strong><strong data-label="Consistency">{{ row.metrics[peerPeriod].consistency.toFixed(1) }}%</strong></button></div></div>
      <p v-if="visiblePeerRows.length" class="compare-footnote">Each window uses the same available fund NAV and benchmark TRI dates. Alpha means average fund return minus average benchmark return; consistency is the share of windows where the fund beat the benchmark.</p>
    </section>

    <section v-else-if="selected" class="detail card" aria-label="Scheme detail">
      <button class="back" @click="closeDetail">← All schemes</button>
      <div class="detail-heading">
        <div><p class="eyebrow">{{ selected.category || selected.amc || 'AMFI scheme' }} · {{ selected.scheme_code }}</p><h2>{{ selected.name }}</h2><p class="scheme-category">{{ selected.amc }}<template v-if="selected.category"> · {{ selected.category }}</template></p><p v-if="selected.benchmark_name" class="benchmark-note"><span>Reference benchmark</span>{{ selected.benchmark_name }} <em>provisional category default</em></p></div>
        <div class="nav"><strong>{{ formatNav(selected.latest_nav) }}</strong><span>NAV · {{ selected.latest_nav_date }}</span></div>
      </div>
      <section class="returns" aria-label="Point-to-point returns">
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
      <p v-else-if="selected.benchmark_name" class="benchmark-unavailable">{{ selected.benchmark_name }} is mapped as a {{ selected.benchmark_mapping_status }} category default, but its TRI history is not yet available from the approved source.</p>
      <section v-if="directRegularComparison" class="direct-regular-section" aria-label="Direct versus Regular plan cost visualiser">
        <div class="direct-regular-heading"><div><p class="eyebrow">Direct vs Regular</p><h3>What the plan choice cost</h3><p>Same ₹1 lakh investment on {{ directRegularComparison.startDate }}.</p></div><div class="range-controls"><button v-for="range in Object.keys(directRegularRanges)" :key="range" :class="{ active: directRegularRange === range }" @click="directRegularRange = range">{{ range }}</button></div></div>
        <div class="direct-regular-values"><div><span>Direct Growth value</span><strong class="positive">{{ formatCurrency(directRegularComparison.directValue) }}</strong><small>{{ directRegularComparison.directReturn >= 0 ? '+' : '' }}{{ directRegularComparison.directReturn.toFixed(2) }}%</small></div><div><span>Regular Growth value</span><strong>{{ formatCurrency(directRegularComparison.regularValue) }}</strong><small>{{ directRegularComparison.regularReturn >= 0 ? '+' : '' }}{{ directRegularComparison.regularReturn.toFixed(2) }}%</small></div><div class="direct-regular-gap"><span>Direct is ahead by</span><strong class="positive">{{ formatCurrency(directRegularComparison.rupeeGap) }}</strong><small>{{ directRegularComparison.returnGap >= 0 ? '+' : '' }}{{ directRegularComparison.returnGap.toFixed(2) }}% return gap</small></div></div>
        <p>Using matching Direct and Regular Growth NAV dates through {{ directRegularComparison.endDate }}. This is a comparison of NAV outcomes, not a projection.</p>
      </section>
      <p v-if="history.length < 2" class="message">Historical NAV is not loaded yet. Returns will appear here once the archive import is complete.</p>
      <template v-else>
        <section class="rolling-section" aria-label="Average rolling returns">
          <div><p class="eyebrow">Average rolling returns</p><p class="rolling-caption">Annualised average across every available rolling window</p></div>
          <div class="rolling-grid">
            <div v-for="rolling in rollingAverages" :key="rolling.years" class="rolling-item">
              <span>{{ rolling.years }}Y</span>
              <strong :class="{ positive: rolling.average > 0, negative: rolling.average < 0 }">{{ rolling.average === null ? '—' : `${rolling.average >= 0 ? '+' : ''}${rolling.average.toFixed(2)}%` }}</strong>
            </div>
          </div>
        </section>
        <section class="chart-section" aria-label="NAV history chart">
          <div class="chart-header"><div><p class="eyebrow">NAV history</p><h3>{{ selectedRange }} range</h3></div><div class="range-controls"><button v-for="range in Object.keys(ranges)" :key="range" :class="{ active: selectedRange === range }" @click="selectedRange = range">{{ range }}</button></div></div>
          <div v-if="chart" class="chart-wrap">
            <svg class="nav-chart" :viewBox="`0 0 ${chart.width} ${chart.height}`" role="img" :aria-label="`NAV history from ${chart.start.date} to ${chart.end.date}`">
              <line v-for="fraction in [0, 0.5, 1]" :key="fraction" class="grid-line" :x1="chart.padding.left" :x2="chart.width - chart.padding.right" :y1="chart.padding.top + fraction * (chart.height - chart.padding.top - chart.padding.bottom)" :y2="chart.padding.top + fraction * (chart.height - chart.padding.top - chart.padding.bottom)" />
              <text class="axis-label" :x="chart.padding.left - 8" :y="chart.padding.top + 4" text-anchor="end">{{ formatNav(chart.max) }}</text>
              <text class="axis-label" :x="chart.padding.left - 8" :y="chart.height - chart.padding.bottom + 4" text-anchor="end">{{ formatNav(chart.min) }}</text>
              <polyline class="nav-line" :points="chart.polyline" fill="none" />
              <circle class="endpoint" :cx="chart.width - chart.padding.right" :cy="chart.padding.top + ((chart.max - chart.end.nav) / (chart.max - chart.min || Math.max(chart.max * 0.02, 1))) * (chart.height - chart.padding.top - chart.padding.bottom)" r="4" />
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
