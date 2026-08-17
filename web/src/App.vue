<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import * as XLSX from 'xlsx';

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
const fundSnapshot = ref({ aaum: [], ter: [], factsheet: null });
const fundSnapshotLoading = ref(false);
const debtQuartile = ref(null);
const debtQuartileLoading = ref(false);
const detailLoading = ref(false);
const selectedRange = ref('1Y');
const chartHover = ref(null);
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
const quartileReturnMode = ref('net');
const quartileRows = ref([]);
const quartileLoading = ref(false);
const compareSearch = ref('');
const compareResults = ref([]);
const compareSelection = ref([]);
const compareLoading = ref(false);
const compareChartRange = ref('1Y');
const compareChartHover = ref(null);
const peerMainCategory = ref('');
const peerCategory = ref('');
const peerPeriod = ref(1);
const peerPlan = ref('direct');
const peerRows = ref([]);
const peerBenchmark = ref(null);
const peerBenchmarkMismatchCount = ref(0);
const peerExcludedSchemes = ref([]);
const peerBenchmarkHistoryAvailable = ref(false);
const peerLoading = ref(false);
const peerSort = ref({ key: 'alpha', direction: 'desc' });
const peerInspectedScheme = ref('');
const analysisMode = ref('peers');
const overlapSearch = ref('');
const overlapResults = ref([]);
const overlapSelection = ref([]);
const overlapLoading = ref(false);
const portfolioChangeSearch = ref('');
const portfolioChangeResults = ref([]);
const portfolioChangeScheme = ref(null);
const portfolioChangeSnapshots = ref([]);
const portfolioChangeLoading = ref(false);
const navDriverSearch = ref('');
const navDriverResults = ref([]);
const navDriverData = ref(null);
const navDriverLoading = ref(false);
const marketSectorPulse = ref(null);
const marketSectorNews = ref(null);
const authReady = ref(false);
const authenticatedUser = ref('');
const authenticatedRole = ref('');
const authMode = ref('sign-in');
const loginUsername = ref('');
const loginPassword = ref('');
const loginError = ref('');
const loginLoading = ref(false);
const requestFullName = ref('');
const requestUsername = ref('');
const requestEmail = ref('');
const requestPassword = ref('');
const requestError = ref('');
const requestMessage = ref('');
const requestLoading = ref(false);
const accessStatus = ref(null);
const adminUsers = ref([]);
const adminLoading = ref(false);
const adminError = ref('');
const usageSearch = ref('');
const adminUsage = ref({ days: 30, totals: { events: 0, active_users: 0, logins: 0 }, daily: [], events: { login: [], logout: [], page_view: [] } });
const interfaceLanguage = ref(localStorage.getItem('fund-analysis-language') === 'gu' ? 'gu' : 'en');
let searchTimer;
let interfaceObserver;

// Only interface copy is translated. Fund names, AMCs, benchmarks, dates and
// every stored/calculated number deliberately remain in their original form.
const gujaratiCopy = {
  'Checking secure access…': 'સુરક્ષિત ઍક્સેસ તપાસી રહ્યા છીએ…', 'Mutual fund analytics': 'મ્યુચ્યુઅલ ફંડ એનાલિટિક્સ',
  'From NAV to Insights.': 'NAV થી ઇનસાઇટ્સ સુધી.', 'From NAV': 'NAV થી', 'to Insights.': 'ઇનસાઇટ્સ સુધી.',
  'Sign in to open the research workspace.': 'રિસર્ચ વર્કસ્પેસ ખોલવા માટે સાઇન ઇન કરો.', 'Username': 'યુઝરનેમ', 'Password': 'પાસવર્ડ',
  'Sign in': 'સાઇન ઇન', 'Signing in…': 'સાઇન ઇન થઈ રહ્યું છે…', 'New here? Sign up': 'નવા છો? સાઇન અપ કરો',
  'Create your account.': 'તમારું એકાઉન્ટ બનાવો.', 'Create your': 'તમારું', 'account.': 'એકાઉન્ટ બનાવો.',
  'After sign-up, your account stays pending until the Super Admin approves it.': 'સાઇન અપ પછી સુપર એડમિન મંજૂરી આપે ત્યાં સુધી તમારું એકાઉન્ટ પેન્ડિંગ રહેશે.',
  'Full name': 'પૂરું નામ', 'Office email': 'ઓફિસ ઈમેઇલ', '(optional)': '(વૈકલ્પિક)', 'Choose password': 'પાસવર્ડ પસંદ કરો',
  'Creating...': 'બનાવી રહ્યા છીએ...', 'Sign up': 'સાઇન અપ', 'Back to sign in': 'સાઇન ઇન પર પાછા જાઓ',
  'Admin': 'એડમિન', 'Sign out': 'સાઇન આઉટ', 'Explore every scheme.': 'દરેક સ્કીમ જાણો.', 'Start with its NAV.': 'તેના NAV થી શરૂઆત કરો.',
  'Schemes': 'સ્કીમ્સ', 'Quartiles': 'ક્વાર્ટાઇલ્સ', 'Peer analysis': 'પિયર એનાલિસિસ', 'Portfolio overlap': 'પોર્ટફોલિયો ઓવરલૅપ',
  'Portfolio changes': 'પોર્ટફોલિયો ફેરફારો', 'NAV movement analysis': 'NAV મૂવમેન્ટ એનાલિસિસ', 'Access control': 'ઍક્સેસ નિયંત્રણ',
  'Super Admin': 'સુપર એડમિન', 'Refresh': 'રિફ્રેશ', 'Refreshing...': 'રિફ્રેશ થઈ રહ્યું છે...', 'Approve': 'મંજૂર કરો', 'Reject': 'નકારો', 'Suspend': 'સસ્પેન્ડ કરો',
  'Usage log': 'ઉપયોગ લોગ', 'Search': 'શોધો', 'Active users': 'સક્રિય યુઝર્સ', 'Logins': 'લોગિન્સ', 'Recorded events': 'નોંધાયેલી પ્રવૃત્તિઓ',
  'Find a scheme': 'સ્કીમ શોધો', 'Browse filters': 'ફિલ્ટર્સ બ્રાઉઝ કરો', 'Category': 'કેટેગરી', 'Subcategory': 'સબકેટેગરી', 'Plan': 'પ્લાન',
  'All categories': 'બધી કેટેગરીઝ', 'All subcategories': 'બધી સબકેટેગરીઝ', 'All plans': 'બધા પ્લાન્સ', 'Direct Growth': 'ડાયરેક્ટ ગ્રોથ',
  'Regular Growth': 'રેગ્યુલર ગ્રોથ', 'Fund structure': 'ફંડ સ્ટ્રક્ચર', 'All': 'બધા', 'Open-ended': 'ઓપન-એન્ડેડ', 'Close-ended': 'ક્લોઝ-એન્ડેડ',
  'Searching…': 'શોધી રહ્યા છીએ…', 'No schemes yet. Run the daily NAV importer to populate this list.': 'હજુ કોઈ સ્કીમ નથી. આ સૂચિ ભરવા માટે દૈનિક NAV ઇમ્પોર્ટર ચલાવો.',
  'Download Excel': 'Excel ડાઉનલોડ કરો', 'Return basis': 'રિટર્ન આધાર', 'Net return': 'નેટ રિટર્ન', 'Gross before TER': 'TER પહેલાં ગ્રોસ',
  'As of month': 'મહિના અનુસાર', 'Select a subcategory': 'સબકેટેગરી પસંદ કરો', 'No eligible paired Growth plans.': 'કોઈ યોગ્ય જોડાયેલા ગ્રોથ પ્લાન્સ નથી.',
  'Comparison workspace': 'તુલના વર્કસ્પેસ', 'Compare up to five schemes': 'પાંચ સુધીની સ્કીમ્સની તુલના કરો', 'Add scheme': 'સ્કીમ ઉમેરો',
  'Selected funds': 'પસંદ કરેલ ફંડ્સ', 'Category peers': 'કેટેગરી પિયર્સ', 'Portfolio disclosure': 'પોર્ટફોલિયો ડિસ્ક્લોઝર',
  'Top 10 holdings': 'ટોપ 10 હોલ્ડિંગ્સ', 'Top sectors': 'ટોપ સેક્ટર્સ', 'Credit-quality allocation': 'ક્રેડિટ ક્વૉલિટી એલોકેશન',
  'Risk & resilience': 'રિસ્ક અને રિઝિલિયન્સ', 'Fund snapshot': 'ફંડ સ્નેપશોટ', 'Debt snapshot': 'ડેટ સ્નેપશોટ',
  'AMC factsheet': 'AMC ફેક્ટશીટ', 'Official debt quants': 'ઓફિશિયલ ડેટ ક્વોન્ટ્સ', 'Direct vs Regular': 'ડાયરેક્ટ vs રેગ્યુલર',
  'NAV history': 'NAV હિસ્ટ્રી', 'Fund vs benchmark growth': 'ફંડ vs બેન્ચમાર્ક ગ્રોથ', 'Point-to-point returns': 'પોઇન્ટ-ટુ-પોઇન્ટ રિટર્ન્સ',
  'Portfolio holding': 'પોર્ટફોલિયો હોલ્ડિંગ', 'Equity allocation': 'ઇક્વિટી એલોકેશન', 'Portfolio exposure': 'પોર્ટફોલિયો એક્સપોઝર',
  'Loading raw monthly holdings…': 'માસિક હોલ્ડિંગ્સ લોડ થઈ રહી છે…', 'No recognised credit ratings in this disclosure.': 'આ ડિસ્ક્લોઝરમાં માન્ય ક્રેડિટ રેટિંગ્સ નથી.',
  'Sector allocation is available for equity holdings only.': 'સેક્ટર એલોકેશન માત્ર ઇક્વિટી હોલ્ડિંગ્સ માટે ઉપલબ્ધ છે.',
  'Modified duration': 'મોડિફાઇડ ડ્યુરેશન', 'Average maturity': 'એવરેજ મેચ્યોરિટી', 'Residual maturity': 'રેસિડ્યુઅલ મેચ્યોરિટી',
  'Yield to maturity': 'યીલ્ડ ટુ મેચ્યોરિટી', 'Macaulay duration': 'મેકોલે ડ્યુરેશન', 'Standard deviation': 'સ્ટાન્ડર્ડ ડિવિએશન',
  'Total AUM': 'કુલ AUM', 'SEBI Risk-o-meter': 'SEBI રિસ્ક-ઓ-મીટર', 'Direct TER': 'ડાયરેક્ટ TER', 'Regular TER': 'રેગ્યુલર TER',
  '1Y category quartile': '1Y કેટેગરી ક્વાર્ટાઇલ', '1Y volatility': '1Y વોલેટિલિટી', '1Y Sharpe': '1Y શાર્પે',
  'Select a category': 'કેટેગરી પસંદ કરો', 'Choose a category and subcategory to split paired Growth plans into performance quartiles.': 'જોડાયેલા ગ્રોથ પ્લાન્સને પર્ફોર્મન્સ ક્વાર્ટાઇલ્સમાં વહેંચવા માટે કેટેગરી અને સબકેટેગરી પસંદ કરો.',
  'Loading raw NAV observations…': 'કાચા NAV અવલોકનો લોડ થઈ રહ્યા છે…', 'Net return is the investor return calculated directly from published NAV.': 'નેટ રિટર્ન પ્રકાશિત NAV પરથી સીધું ગણાયેલ રોકાણકારનું રિટર્ન છે.',
  'All eligible AMCs are ranked and the best 20 representatives are displayed. Q1 holds the top 25% of the displayed set by Direct Growth return where available; Regular Growth is used only when a Direct plan does not exist.': 'બધા યોગ્ય AMC ને ક્રમ આપવામાં આવે છે અને શ્રેષ્ઠ 20 પ્રતિનિધિઓ દર્શાવવામાં આવે છે. જ્યાં ડાયરેક્ટ ગ્રોથ ઉપલબ્ધ હોય ત્યાં Q1 માં ટોચના 25% હોય છે; ડાયરેક્ટ પ્લાન ન હોય ત્યારે જ રેગ્યુલર ગ્રોથ વપરાય છે.',
  'Fund': 'ફંડ', 'No eligible paired Growth plans.': 'કોઈ યોગ્ય જોડાયેલા ગ્રોથ પ્લાન્સ નથી.', '+ Add': '+ ઉમેરો',
  'Search for the first scheme you would like to compare.': 'તમે જે પહેલી સ્કીમની તુલના કરવા માંગો છો તે શોધો.', 'NAV comparison': 'NAV તુલના', 'Selected funds growth': 'પસંદ કરેલા ફંડ્સનો ગ્રોથ',
  'Growth-plan returns and benchmark alpha are calculated from aligned source dates in your browser.': 'ગ્રોથ પ્લાન રિટર્ન્સ અને બેન્ચમાર્ક આલ્ફા તમારા બ્રાઉઝરમાં મેળ ખાતી સોર્સ તારીખો પરથી ગણવામાં આવે છે.',
  'Alpha is fund return minus its mapped benchmark return.': 'આલ્ફા એટલે ફંડ રિટર્નમાંથી તેના મેપ કરેલા બેન્ચમાર્ક રિટર્નનો તફાવત.',
  'Compare a whole category': 'આખી કેટેગરીની તુલના કરો', 'Average every possible holding period, then see which peers beat their benchmark most consistently.': 'દરેક શક્ય હોલ્ડિંગ પિરિયડની સરેરાશ જુઓ, પછી કયા પિયર્સે બેન્ચમાર્કને સૌથી સતત હરાવ્યું તે જુઓ.',
  'Plans': 'પ્લાન્સ', 'All Growth plans': 'બધા ગ્રોથ પ્લાન્સ', 'Holding period': 'હોલ્ડિંગ પિરિયડ', 'Choose a category to analyse its peer funds.': 'તેના પિયર ફંડ્સનું વિશ્લેષણ કરવા માટે કેટેગરી પસંદ કરો.',
  'Loading source histories and calculating rolling peer metrics…': 'સોર્સ હિસ્ટ્રી લોડ કરીને રોલિંગ પિયર મેટ્રિક્સની ગણતરી થઈ રહી છે…',
  "The mapped benchmark's TRI history is not available from an approved source, so alpha and consistency are not calculated.": 'મેપ કરેલા બેન્ચમાર્કની TRI હિસ્ટ્રી માન્ય સોર્સમાંથી ઉપલબ્ધ નથી, તેથી આલ્ફા અને કન્સિસ્ટન્સીની ગણતરી થતી નથી.',
  'No eligible Growth plans have enough matching NAV and benchmark TRI history for this period.': 'આ સમયગાળા માટે કોઈ યોગ્ય ગ્રોથ પ્લાન પાસે પૂરતી મેળ ખાતી NAV અને બેન્ચમાર્ક TRI હિસ્ટ્રી નથી.',
  'Fund avg': 'ફંડ સરેરાશ', 'Benchmark avg': 'બેન્ચમાર્ક સરેરાશ', 'Consistency journey': 'કન્સિસ્ટન્સી સફર', 'How one fund held up over time': 'એક ફંડ સમય સાથે કેવું ટક્યું',
  'Share of rolling windows in which the fund beat its mapped benchmark.': 'રોલિંગ વિન્ડોઝનો હિસ્સો જેમાં ફંડે તેના મેપ કરેલા બેન્ચમાર્કને હરાવ્યું.', 'Inspect a fund': 'ફંડ તપાસો',
  '1Y to latest available holding period': '1Y થી ઉપલબ્ધ તાજેતરના હોલ્ડિંગ પિરિયડ સુધી', 'Latest consistency': 'તાજેતરની કન્સિસ્ટન્સી', 'Reference only': 'માત્ર સંદર્ભ માટે',
  'Not included in benchmark comparison': 'બેન્ચમાર્ક તુલનામાં સામેલ નથી', 'These funds are shown for completeness, but their alpha and consistency are not calculated here because they report a different benchmark from the category comparison.': 'પૂર્ણતા માટે આ ફંડ્સ બતાવવામાં આવ્યા છે, પરંતુ કેટેગરી તુલના કરતાં અલગ બેન્ચમાર્ક જણાવતા હોવાથી અહીં તેમનો આલ્ફા અને કન્સિસ્ટન્સી ગણાતો નથી.',
  'Each window uses the same available fund NAV and benchmark TRI dates. Alpha means average fund return minus average benchmark return; consistency is the share of windows where the fund beat the benchmark.': 'દરેક વિન્ડો સમાન ઉપલબ્ધ ફંડ NAV અને બેન્ચમાર્ક TRI તારીખોનો ઉપયોગ કરે છે. આલ્ફા એટલે સરેરાશ ફંડ રિટર્નમાંથી સરેરાશ બેન્ચમાર્ક રિટર્નનો તફાવત; કન્સિસ્ટન્સી એટલે ફંડે બેન્ચમાર્કને હરાવ્યો હોય તેવી વિન્ડોઝનો હિસ્સો.',
  'See what two funds actually own together': 'બે ફંડ્સ પાસે ખરેખર શું એકસાથે છે તે જુઓ', 'Compare only verified monthly disclosures. Common holdings are matched by ISIN, not by a fuzzy name match.': 'માત્ર વેરિફાઇડ માસિક ડિસ્ક્લોઝરની તુલના કરો. સામાન્ય હોલ્ડિંગ્સનું મેચિંગ નામથી નહીં પરંતુ ISIN દ્વારા થાય છે.',
  'Choose two schemes. A scheme can be compared once its latest monthly disclosure has been imported and mapped.': 'બે સ્કીમ્સ પસંદ કરો. તાજેતરનું માસિક ડિસ્ક્લોઝર ઇમ્પોર્ટ અને મેપ થયા પછી સ્કીમની તુલના કરી શકાય છે.',
  'Common holding overlap': 'સામાન્ય હોલ્ડિંગ ઓવરલૅપ', 'Sum of the lower weight for each shared ISIN': 'દરેક સામાન્ય ISIN માટે ઓછા વેઇટનું કુલ', 'Common sector overlap': 'સામાન્ય સેક્ટર ઓવરલૅપ',
  'Sum of the lower disclosed sector weight': 'દરેક જાહેર કરેલા સેક્ટર માટે ઓછા વેઇટનું કુલ', 'Top-10 concentration': 'ટોપ-10 કન્સન્ટ્રેશન', 'First fund / second fund': 'પહેલું ફંડ / બીજું ફંડ',
  'First fund': 'પહેલું ફંડ', 'Second fund': 'બીજું ફંડ', 'Common holding': 'સામાન્ય હોલ્ડિંગ', 'No common ISINs were found in these two current disclosures.': 'આ બંને વર્તમાન ડિસ્ક્લોઝરમાં કોઈ સામાન્ય ISIN મળ્યા નથી.',
  'First fund: Top 10 holdings': 'પહેલું ફંડ: ટોપ 10 હોલ્ડિંગ્સ', 'Second fund: Top 10 holdings': 'બીજું ફંડ: ટોપ 10 હોલ્ડિંગ્સ', 'Only positive, non-derivative positions with an ISIN are used. The disclosures may have different as-of dates; compare the dates above before drawing a conclusion.': 'માત્ર ISIN ધરાવતી પોઝિટિવ, નોન-ડેરિવેટિવ પોઝિશન્સ વપરાય છે. ડિસ્ક્લોઝરની તારીખો અલગ હોઈ શકે છે; નિષ્કર્ષ કાઢતા પહેલાં ઉપરની તારીખોની તુલના કરો.',
  'Portfolio change tracker': 'પોર્ટફોલિયો ફેરફાર ટ્રૅકર', 'See what a fund manager changed': 'ફંડ મેનેજરે શું બદલ્યું તે જુઓ', 'Compare the latest two verified monthly disclosures for a single scheme.': 'એક સ્કીમ માટે તાજેતરના બે વેરિફાઇડ માસિક ડિસ્ક્લોઝરની તુલના કરો.',
  'View changes': 'ફેરફારો જુઓ', 'Choose a scheme to inspect how its disclosed portfolio changed month to month.': 'તેનું જાહેર કરેલું પોર્ટફોલિયો મહિના પ્રમાણે કેવી રીતે બદલાયું તે જોવા સ્કીમ પસંદ કરો.',
  'Only one verified disclosure is available so far. The tracker will activate automatically after the next monthly portfolio refresh.': 'હાલમાં માત્ર એક વેરિફાઇડ ડિસ્ક્લોઝર ઉપલબ્ધ છે. આગામી માસિક પોર્ટફોલિયો રિફ્રેશ પછી ટ્રૅકર આપમેળે સક્રિય થશે.',
  'Disclosure comparison': 'ડિસ્ક્લોઝર તુલના', 'Latest disclosure': 'તાજેતરનું ડિસ્ક્લોઝર', 'Compared with the prior available month': 'અગાઉના ઉપલબ્ધ મહિના સાથે તુલના', 'New holdings': 'નવી હોલ્ડિંગ્સ', 'All additions shown below': 'બધા ઉમેરાઓ નીચે બતાવ્યા છે',
  'Exited holdings': 'બહાર થયેલી હોલ્ડિંગ્સ', 'All exits shown below': 'બધા એક્ઝિટ નીચે બતાવ્યા છે', 'Change in the largest ten positions': 'સૌથી મોટી દસ પોઝિશન્સમાં ફેરફાર', 'Added': 'ઉમેર્યું', 'Exited': 'બહાર થયું',
  'No new ISINs.': 'કોઈ નવા ISIN નથી.', 'No exited ISINs.': 'કોઈ બહાર થયેલા ISIN નથી.', 'Largest weight changes': 'સૌથી મોટા વેઇટ ફેરફારો', 'No material weight changes.': 'કોઈ નોંધપાત્ર વેઇટ ફેરફાર નથી.', 'Largest sector shifts': 'સૌથી મોટા સેક્ટર ફેરફારો', 'No disclosed sector shifts.': 'કોઈ જાહેર કરેલા સેક્ટર ફેરફારો નથી.',
  'Changes use positive, non-derivative positions with an ISIN. Sector shifts use disclosed sector labels and may be unavailable for debt or non-equity holdings.': 'ફેરફારો માટે ISIN ધરાવતી પોઝિટિવ, નોન-ડેરિવેટિવ પોઝિશન્સ વપરાય છે. સેક્ટર ફેરફારો જાહેર કરેલા સેક્ટર લેબલનો ઉપયોગ કરે છે અને ડેટ અથવા નોન-ઇક્વિટી હોલ્ડિંગ્સ માટે ઉપલબ્ધ ન હોઈ શકે.',
  'What likely moved the fund today': 'આજે ફંડને કદાચ શેના કારણે ફેરફાર થયો', 'Uses the latest disclosed portfolio and official NSE closing prices; this is an estimate, not AMC attribution.': 'તાજા જાહેર કરેલા પોર્ટફોલિયો અને સત્તાવાર NSE ક્લોઝિંગ પ્રાઇસનો ઉપયોગ થાય છે; આ અંદાજ છે, AMC એટ્રિબ્યુશન નથી.',
  'Analyse': 'વિશ્લેષણ કરો', 'Choose a scheme with a mapped equity portfolio and NSE price coverage.': 'મેપ કરેલા ઇક્વિટી પોર્ટફોલિયો અને NSE પ્રાઇસ કવરેજ ધરાવતી સ્કીમ પસંદ કરો.', 'In plain English': 'સરળ ભાષામાં', 'How the estimate works': 'અંદાજ કેવી રીતે કામ કરે છે',
  'Fund weight × one-day stock return = estimated impact on the fund NAV.': 'ફંડ વેઇટ × એક દિવસનો સ્ટોક રિટર્ન = ફંડ NAV પર અંદાજિત અસર.', 'Actual NAV move': 'વાસ્તવિક NAV ફેરફાર', 'Estimated holdings move': 'અંદાજિત હોલ્ડિંગ્સ ફેરફાર',
  'Residual': 'બાકી અસર', 'Actual NAV move minus the holdings estimate': 'વાસ્તવિક NAV ફેરફારમાંથી હોલ્ડિંગ્સના અંદાજનો તફાવત', 'A small residual means the disclosed priced holdings broadly explain the day. It will not be exactly zero because the fund may hold cash, debt, derivatives or unpriced positions, may trade after the disclosure date, and NAV also reflects daily expenses.': 'નાની બાકી અસરનો અર્થ છે કે જાહેર કરેલી પ્રાઇસવાળી હોલ્ડિંગ્સ દિવસના ફેરફારને મોટેભાગે સમજાવે છે. તે બરાબર શૂન્ય નહીં હોય કારણ કે ફંડમાં કૅશ, ડેટ, ડેરિવેટિવ્સ અથવા પ્રાઇસ વગરની પોઝિશન્સ હોઈ શકે છે, ડિસ્ક્લોઝર તારીખ પછી ટ્રેડ થઈ શકે છે અને NAVમાં દૈનિક ખર્ચ પણ સામેલ હોય છે.',
  'Top positive drivers': 'ટોપ પોઝિટિવ ડ્રાઇવર્સ', 'Holding': 'હોલ્ડિંગ', 'Weight': 'વેઇટ', 'Price move': 'પ્રાઇસ ફેરફાર', 'Stock return': 'સ્ટોક રિટર્ન', 'NAV impact': 'NAV અસર', 'No priced positive contributors for this date.': 'આ તારીખ માટે કોઈ પ્રાઇસવાળા પોઝિટિવ કોન્ટ્રિબ્યુટર્સ નથી.', 'Top negative drivers': 'ટોપ નેગેટિવ ડ્રાઇવર્સ', 'No priced negative contributors for this date.': 'આ તારીખ માટે કોઈ પ્રાઇસવાળા નેગેટિવ કોન્ટ્રિબ્યુટર્સ નથી.',
  'This is a daily, holdings-based estimate—not an official AMC attribution. It uses the latest portfolio disclosure available before the NAV date and official NSE closing prices only for mapped equity holdings.': 'આ દૈનિક, હોલ્ડિંગ્સ આધારિત અંદાજ છે—સત્તાવાર AMC એટ્રિબ્યુશન નથી. તે NAV તારીખ પહેલાં ઉપલબ્ધ તાજેતરના પોર્ટફોલિયો ડિસ્ક્લોઝર અને માત્ર મેપ કરેલી ઇક્વિટી હોલ્ડિંગ્સ માટે સત્તાવાર NSE ક્લોઝિંગ પ્રાઇસનો ઉપયોગ કરે છે.',
  'Market sector pulse': 'માર્કેટ સેક્ટર પલ્સ', 'How the overall market’s sectors moved': 'ઓવરઓલ માર્કેટના સેક્ટર્સ કેવી રીતે બદલાયા', 'NSE closing report': 'NSE ક્લોઝિંગ રિપોર્ટ', 'These are the daily moves of broad NSE sector indices, independent of this fund. They provide the market backdrop for the holdings analysis above.': 'આ વ્યાપક NSE સેક્ટર ઇન્ડેક્સના દૈનિક ફેરફારો છે, આ ફંડથી સ્વતંત્ર. તે ઉપરના હોલ્ડિંગ્સ વિશ્લેષણ માટે માર્કેટ સંદર્ભ આપે છે.',
  'Read the market context below.': 'નીચે માર્કેટ સંદર્ભ વાંચો.', 'Headlines are useful context, not a proven cause of a sector or fund move.': 'હેડલાઇન્સ ઉપયોગી સંદર્ભ છે, સેક્ટર અથવા ફંડ ફેરફારનું સાબિત કારણ નથી.', 'Market context': 'માર્કેટ સંદર્ભ', 'What was being discussed around the day’s biggest sector moves': 'દિવસના સૌથી મોટા સેક્ટર ફેરફારો વિશે શું ચર્ચાયું', 'Headline context': 'હેડલાઇન સંદર્ભ', 'These headlines provide context for the strongest and weakest sectors. They do not prove the reason for a sector move or this fund’s NAV change.': 'આ હેડલાઇન્સ સૌથી મજબૂત અને નબળા સેક્ટર્સ માટે સંદર્ભ આપે છે. તે સેક્ટર ફેરફાર અથવા આ ફંડના NAV ફેરફારનું કારણ સાબિત કરતી નથી.', 'No dated sector-specific headline was available from the news feed.': 'ન્યૂઝ ફીડમાંથી તારીખવાળી સેક્ટર-સ્પેસિફIC હેડલાઇન ઉપલબ્ધ નથી.',
  'Reference benchmark': 'રેફરન્સ બેન્ચમાર્ક', 'Scale, cost & disclosure': 'સ્કેલ, ખર્ચ અને ડિસ્ક્લોઝર', 'Source observations': 'સોર્સ અવલોકનો', 'Calculated context stays in your browser': 'ગણાયેલ સંદર્ભ તમારા બ્રાઉઝરમાં રહે છે', 'Loading AAUM and TER source history…': 'AAUM અને TER સોર્સ હિસ્ટ્રી લોડ થઈ રહી છે…', 'Latest reported AAUM': 'તાજેતરનું રિપોર્ટેડ AAUM', 'AAUM movement': 'AAUM ફેરફાર',
  'AAUM uses AMFI’s reported average AUM, not month-end AUM. TER is already reflected in NAV and is shown here as a separate cost observation.': 'AAUMમાં AMFI દ્વારા રિપોર્ટ કરેલું સરેરાશ AUM વપરાય છે, મહિના અંતનું AUM નહીં. TER પહેલેથી NAVમાં પ્રતિબિંબિત છે અને અહીં અલગ ખર્ચ અવલોકન તરીકે બતાવ્યું છે.', 'Fund management & exit load': 'ફંડ મેનેજમેન્ટ અને એક્ઝિટ લોડ', 'Exit load': 'એક્ઝિટ લોડ', 'Always check the current scheme information document before transacting.': 'ટ્રાન્ઝેક્શન કરતાં પહેલાં હંમેશા વર્તમાન સ્કીમ ઇન્ફોર્મેશન ડોક્યુમેન્ટ તપાસો.', 'Not stated': 'જણાવેલ નથી', 'No manager record was found in this factsheet.': 'આ ફેક્ટશીટમાં કોઈ મેનેજર રેકોર્ડ મળ્યો નથી.',
  'The details above are reported by the AMC, plan-linked to the scheme, and retained with their factsheet date.': 'ઉપરની વિગતો AMC દ્વારા રિપોર્ટ કરવામાં આવી છે, સ્કીમ સાથે પ્લાન-લિંક છે અને ફેક્ટશીટ તારીખ સાથે રાખવામાં આવી છે.', 'Return snapshot': 'રિટર્ન સ્નેપશોટ', 'Latest NAV date': 'તાજેતરની NAV તારીખ', 'annualised': 'વાર્ષિકીકૃત', 'Total return unavailable': 'કુલ રિટર્ન ઉપલબ્ધ નથી', 'Fund vs benchmark': 'ફંડ vs બેન્ચમાર્ક', 'Period': 'સમયગાળો', 'Benchmark': 'બેન્ચમાર્ક', 'Outperformance': 'આઉટપરફોર્મન્સ',
  'Fund NAV and benchmark TRI are source observations; all returns and outperformance are calculated in your browser.': 'ફંડ NAV અને બેન્ચમાર્ક TRI સોર્સ અવલોકનો છે; તમામ રિટર્ન્સ અને આઉટપરફોર્મન્સ તમારા બ્રાઉઝરમાં ગણાય છે.', 'Benchmark comparison': 'બેન્ચમાર્ક તુલના', 'How the fund behaved on the way': 'ફંડ સફરમાં કેવી રીતે વર્ત્યું', 'Maximum drawdown': 'મહત્તમ ડ્રોડાઉન', 'Fund’s largest fall from a prior peak': 'અગાઉના પીકથી ફંડનો સૌથી મોટો ઘટાડો', 'Benchmark drawdown': 'બેન્ચમાર્ક ડ્રોડાઉન', 'On the same aligned date range': 'સમાન મેળ ખાતી તારીખ રેન્જ પર', 'Annualised volatility': 'વાર્ષિકીકૃત વોલેટિલિટી', 'How much the fund’s daily returns moved': 'ફંડના દૈનિક રિટર્ન્સ કેટલા બદલાયા', 'Sharpe ratio': 'શાર્પે રેશિયો', 'Beta': 'બીટા', 'Tracking error': 'ટ્રેકિંગ એરર', 'Upside capture': 'અપસાઇડ કૅપ્ચર', 'Downside capture': 'ડાઉનસાઇડ કૅપ્ચર', 'Category upside capture': 'કેટેગરી અપસાઇડ કૅપ્ચર', 'Category downside capture': 'કેટેગરી ડાઉનસાઇડ કૅપ્ચર', 'Below 100% means less of the category fall': '100%થી નીચે એટલે કેટેગરીના ઘટાડામાં ઓછો ઘટાડો',
  'Rate, credit & cost view': 'રેટ, ક્રેડિટ અને ખર્ચ વ્યૂ', 'Current source data': 'વર્તમાન સોર્સ ડેટા', 'Latest mapped portfolio disclosure': 'તાજેતરનું મેપ કરેલું પોર્ટફોલિયો ડિસ્ક્લોઝર', 'Latest AMFI daily disclosure': 'તાજેતરનું AMFI દૈનિક ડિસ્ક્લોઝર', 'Annualised daily NAV volatility': 'વાર્ષિકીકૃત દૈનિક NAV વોલેટિલિટી', 'Uses the RBI Repo Rate baseline': 'RBI રેપો રેટ બેઝલાઇનનો ઉપયોગ કરે છે', 'Interest-rate sensitivity': 'વ્યાજ દર સંવેદનશીલતા', 'Portfolio yield reported by the AMC': 'AMC દ્વારા રિપોર્ટેડ પોર્ટફોલિયો યીલ્ડ', 'Weighted time to receive cash flows': 'કૅશ ફ્લો મેળવવાનો વેઇટેડ સમય', 'AMC-reported volatility measure': 'AMC દ્વારા રિપોર્ટેડ વોલેટિલિટી મેટ્રિક',
  'These are factsheet values, not estimates from the holdings table. Their calculation methodology is the AMC’s published methodology.': 'આ ફેક્ટશીટના મૂલ્યો છે, હોલ્ડિંગ્સ ટેબલના અંદાજ નથી. તેમની ગણતરી પદ્ધતિ AMCની પ્રકાશિત પદ્ધતિ છે.', 'What the plan choice cost': 'પ્લાનની પસંદગીનો ખર્ચ', 'Investment amount': 'રોકાણની રકમ', 'Direct Growth value': 'ડાયરેક્ટ ગ્રોથ વેલ્યુ', 'Regular Growth value': 'રેગ્યુલર ગ્રોથ વેલ્યુ', 'Direct is ahead by': 'ડાયરેક્ટ આગળ છે', 'Historical NAV is not loaded yet. Returns will appear here once the archive import is complete.': 'હિસ્ટોરિકલ NAV હજુ લોડ થયું નથી. આર્કાઇવ ઇમ્પોર્ટ પૂર્ણ થયા પછી રિટર્ન્સ અહીં દેખાશે.', 'Average rolling returns': 'સરેરાશ રોલિંગ રિટર્ન્સ', 'Annualised average across every available rolling window': 'દરેક ઉપલબ્ધ રોલિંગ વિન્ડોમાં વાર્ષિકીકૃત સરેરાશ', 'Fund lead': 'ફંડ લીડ',
  'Choose language': 'ભાષા પસંદ કરો', 'Search a user by name, username, or email': 'નામ, યુઝરનેમ અથવા ઈમેઇલથી યુઝર શોધો', 'Category quartiles': 'કેટેગરી ક્વાર્ટાઇલ્સ', 'Quartile return period': 'ક્વાર્ટાઇલ રિટર્ન સમયગાળો', 'Quartile return basis': 'ક્વાર્ટાઇલ રિટર્ન આધાર', 'Fund comparison': 'ફંડ તુલના', 'Search a scheme to add': 'ઉમેરવા માટે સ્કીમ શોધો', 'Selected-fund NAV growth chart': 'પસંદ કરેલા ફંડનો NAV ગ્રોથ ચાર્ટ', 'Remove scheme': 'સ્કીમ દૂર કરો', 'Fund consistency journey': 'ફંડ કન્સિસ્ટન્સી સફર', 'Funds not included in category benchmark comparison': 'કેટેગરી બેન્ચમાર્ક તુલનામાં સામેલ ન થયેલા ફંડ્સ', 'Search a scheme with a portfolio disclosure': 'પોર્ટફોલિયો ડિસ્ક્લોઝર ધરાવતી સ્કીમ શોધો', 'Search a scheme with portfolio disclosures': 'પોર્ટફોલિયો ડિસ્ક્લોઝર્સ ધરાવતી સ્કીમ શોધો', 'Search an equity scheme': 'ઇક્વિટી સ્કીમ શોધો', 'NAV movement summary': 'NAV ફેરફાર સારાંશ', 'Overall market sector pulse': 'ઓવરઓલ માર્કેટ સેક્ટર પલ્સ', 'Sector news context': 'સેક્ટર ન્યૂઝ સંદર્ભ', 'Scheme detail': 'સ્કીમ વિગત', 'Fund management and exit load': 'ફંડ મેનેજમેન્ટ અને એક્ઝિટ લોડ', 'IDCW return availability': 'IDCW રિટર્ન ઉપલબ્ધતા', 'Fund versus benchmark comparison': 'ફંડ વિરુદ્ધ બેન્ચમાર્ક તુલના', 'Fund versus benchmark availability': 'ફંડ વિરુદ્ધ બેન્ચમાર્ક ઉપલબ્ધતા', 'Risk and resilience analysis': 'રિસ્ક અને રિઝિલિયન્સ વિશ્લેષણ', 'Risk and resilience availability': 'રિસ્ક અને રિઝિલિયન્સ ઉપલબ્ધતા', 'Debt fund snapshot': 'ડેટ ફંડ સ્નેપશોટ', 'Direct versus Regular plan cost visualiser': 'ડાયરેક્ટ વિરુદ્ધ રેગ્યુલર પ્લાન ખર્ચ વિઝ્યુઅલાઇઝર', 'Portfolio holdings': 'પોર્ટફોલિયો હોલ્ડિંગ્સ', 'NAV history chart': 'NAV હિસ્ટ્રી ચાર્ટ', 'Scheme search': 'સ્કીમ શોધ',
  'is pending Super Admin approval.': 'સુપર એડમિનની મંજૂરીની રાહમાં છે.', 'Your access is approved. Sign in using': 'તમારી ઍક્સેસ મંજૂર છે. આથી સાઇન ઇન કરો', 'New accounts stay pending until you approve them. You can suspend approved accounts at any time.': 'નવા એકાઉન્ટ્સ તમે મંજૂર કરો ત્યાં સુધી પેન્ડિંગ રહે છે. મંજૂર એકાઉન્ટને તમે ગમે ત્યારે સસ્પેન્ડ કરી શકો છો.', 'Loading access requests...': 'ઍક્સેસ વિનંતીઓ લોડ થઈ રહી છે...', 'No access requests yet.': 'હજુ કોઈ ઍક્સેસ વિનંતીઓ નથી.', 'Basic internal activity': 'મૂળભૂત આંતરિક પ્રવૃત્તિ', 'No searches, scheme selections, passwords, or IP addresses stored': 'કોઈ સર્ચ, સ્કીમ પસંદગી, પાસવર્ડ અથવા IP એડ્રેસ સ્ટોર થતા નથી', 'Logged in or opened a section': 'લોગિન કર્યું અથવા સેક્શન ખોલ્યું', 'Successful sign-ins': 'સફળ સાઇન-ઇન્સ', 'Login, logout, or section visit': 'લોગિન, લોગઆઉટ અથવા સેક્શન વિઝિટ', 'Scheme': 'સ્કીમ', '1Y alpha': '1Y આલ્ફા', '3Y alpha': '3Y આલ્ફા', '5Y alpha': '5Y આલ્ફા', 'Benchmark:': 'બેન્ચમાર્ક:', '← All schemes': '← બધી સ્કીમ્સ', 'CAGR': 'CAGR', 'Holding-level yield, residual maturity and credit quality are calculated below when a mapped monthly portfolio disclosure is available.': 'મેપ કરેલું માસિક પોર્ટફોલિયો ડિસ્ક્લોઝર ઉપલબ્ધ હોય ત્યારે હોલ્ડિંગ લેવલ યીલ્ડ, રેસિડ્યુઅલ મેચ્યોરિટી અને ક્રેડિટ ક્વૉલિટી નીચે ગણાય છે.',
  'Could not sign in.': 'સાઇન ઇન થઈ શક્યું નથી.', 'Could not submit your access request.': 'તમારી ઍક્સેસ વિનંતી મોકલી શકાઈ નથી.', 'Your access request is awaiting Super Admin approval.': 'તમારી ઍક્સેસ વિનંતી સુપર એડમિનની મંજૂરીની રાહમાં છે.', 'This account does not have access. Contact the Super Admin.': 'આ એકાઉન્ટ પાસે ઍક્સેસ નથી. સુપર એડમિનનો સંપર્ક કરો.', 'Invalid username or password.': 'યુઝરનેમ અથવા પાસવર્ડ ખોટો છે.', 'Username is already in use.': 'આ યુઝરનેમ પહેલેથી ઉપયોગમાં છે.', 'Sign-up complete. Your account is pending Super Admin approval.': 'સાઇન અપ પૂર્ણ. તમારું એકાઉન્ટ સુપર એડમિનની મંજૂરીની રાહમાં છે.', 'Your sign-up as': 'તમારું સાઇન અપ', 'An IDCW plan’s NAV falls when cash is distributed. Correct investor returns require the complete distribution cash-flow history, so NAV change alone is not presented as return.': 'કૅશ ડિસ્ટ્રિબ્યુટ થાય ત્યારે IDCW પ્લાનનું NAV ઘટે છે. સાચા રોકાણકાર રિટર્ન માટે સંપૂર્ણ ડિસ્ટ્રિબ્યુશન કૅશ-ફ્લો હિસ્ટ્રી જરૂરી છે, તેથી માત્ર NAV ફેરફારને રિટર્ન તરીકે રજૂ કરાતો નથી.'
};
const nodeSources = new WeakMap();
const attributeSources = new WeakMap();
let translatingCopy = false;
const nameWordMap = {
  fund: 'ફંડ', funds: 'ફંડ્સ', mutual: 'મ્યુચ્યુઅલ', plan: 'પ્લાન', direct: 'ડાયરેક્ટ', regular: 'રેગ્યુલર', growth: 'ગ્રોથ', option: 'ઓપ્શન', english: 'અંગ્રેજી',
  hdfc: 'એચડીએફસી', icici: 'આઈસીઆઈસીઆઈ', sbi: 'એસબીઆઈ', axis: 'એક્સિસ', kotak: 'કોટક', tata: 'ટાટા', uti: 'યુટીઆઈ', dsp: 'ડીએસપી',
  aditya: 'આદિત્ય', birla: 'બિરલા', sun: 'સન', life: 'લાઇફ', nippon: 'નિપ્પોન', india: 'ઇન્ડિયા', mirae: 'મિરાઇ', asset: 'એસેટ',
  motilal: 'મોતિલાલ', oswal: 'ઓસ્વાલ', parag: 'પરાગ', parikh: 'પરીખ', whiteoak: 'વ્હાઇટઓક', bandhan: 'બંધન', invesco: 'ઇન્વેસ્કો',
  franklin: 'ફ્રેન્કલિન', templeton: 'ટેમ્પલટન', edelweiss: 'એડેલવાઇસ', canara: 'કેનરા', robeco: 'રોબેકો', baroda: 'બરોડા',
  quantum: 'ક્વોન્ટમ', quant: 'ક્વોન્ટ', ppfas: 'પીપીએફએએસ', bajaj: 'બજાજ', finserv: 'ફિનસર્વ', union: 'યુનિયન', bank: 'બેંક',
  nse: 'એનએસઈ', bse: 'બીએસઈ', nifty: 'નિફ્ટી', sensex: 'સેન્સેક્સ', index: 'ઇન્ડેક્સ', total: 'ટોટલ', return: 'રિટર્ન', tri: 'ટીઆરઆઈ', nav: 'એનએવી', aum: 'એયુએમ', aaum: 'એએયુએમ', ter: 'ટીઈઆર', amc: 'એએમસી', sebi: 'સેબી', rbi: 'આરબીઆઈ', cagr: 'સીએજીઆર', idcw: 'આઈડીસીડબ્લ્યુ', ytm: 'વાયટીએમ',
  flexi: 'ફ્લેક્સી', cap: 'કેપ', large: 'લાર્જ', mid: 'મિડ', small: 'સ્મોલ', equity: 'ઇક્વિટી', debt: 'ડેટ', hybrid: 'હાઇબ્રિડ',
  elss: 'ઈએલએસએસ', tax: 'ટેક્સ', saver: 'સેવર', corporate: 'કોર્પોરેટ', bond: 'બોન્ડ', liquid: 'લિક્વિડ', overnight: 'ઓવરનાઇટ',
  arbitrage: 'આર્બિટ્રાજ', money: 'મની', market: 'માર્કેટ', short: 'શોર્ટ', medium: 'મિડિયમ', long: 'લોંગ', duration: 'ડ્યુરેશન', gilt: 'ગિલ્ટ',
  income: 'ઇનકમ', value: 'વેલ્યુ', focused: 'ફોકસ્ડ', multi: 'મલ્ટી', allocation: 'એલોકેશન', balanced: 'બેલેન્સ્ડ', advantage: 'એડવાન્ટેજ',
  banking: 'બેન્કિંગ', financial: 'ફાઇનાન્સિયલ', services: 'સર્વિસિસ', consumption: 'કન્ઝમ્પ્શન', manufacturing: 'મેન્યુફેક્ચરિંગ', infrastructure: 'ઇન્ફ્રાસ્ટ્રક્ચર',
  healthcare: 'હેલ્થકેર', technology: 'ટેક્નોલોજી', pharma: 'ફાર્મા', business: 'બિઝનેસ', cycle: 'સાયકલ', commodity: 'કોમોડિટી',
  january: 'જાન્યુઆરી', february: 'ફેબ્રુઆરી', march: 'માર્ચ', april: 'એપ્રિલ', may: 'મે', june: 'જૂન', july: 'જુલાઈ', august: 'ઓગસ્ટ', september: 'સપ્ટેમ્બર', october: 'ઓક્ટોબર', november: 'નવેમ્બર', december: 'ડિસેમ્બર',
};
const protectedNameTokens = new Set(['ISIN']);
function transliterateFallback(word) {
  const pairs = [['th', 'થ'], ['sh', 'શ'], ['ch', 'ચ'], ['ph', 'ફ'], ['kh', 'ખ'], ['aa', 'ા'], ['ee', 'ી'], ['oo', 'ૂ'], ['ai', 'ૈ'], ['au', 'ૌ'], ['a', 'અ'], ['e', 'ે'], ['i', 'િ'], ['o', 'ો'], ['u', 'ુ'], ['b', 'બ'], ['c', 'ક'], ['d', 'ડ'], ['f', 'ફ'], ['g', 'ગ'], ['h', 'હ'], ['j', 'જ'], ['k', 'ક'], ['l', 'લ'], ['m', 'મ'], ['n', 'ન'], ['p', 'પ'], ['q', 'ક'], ['r', 'ર'], ['s', 'સ'], ['t', 'ટ'], ['v', 'વ'], ['w', 'વ'], ['x', 'ક્સ'], ['y', 'ય'], ['z', 'ઝ']];
  let output = word.toLowerCase();
  for (const [latin, gujarati] of pairs) output = output.replaceAll(latin, gujarati);
  return output;
}
function looksLikeFundName(value) {
  return /\b(?:fund|mutual|nifty|sensex|index|hdfc|icici|sbi|axis|kotak|aditya|birla|parag|whiteoak|motilal|nippon|tata|mirae|bandhan|invesco|uti|quantum|quant|franklin|dsp|edelweiss|canara|baroda|bajaj|nse|bse|equity|debt|hybrid|flexi|large|mid|small|sectoral|thematic|arbitrage|liquid|money|duration|gilt|income|value|focused|multi|balanced|banking|financial|consumption|manufacturing|healthcare|technology|january|february|march|april|may|june|july|august|september|october|november|december)\b/i.test(value);
}
function transliterateName(value) {
  return String(value).replace(/[A-Za-z]+/g, (word) => {
    if (protectedNameTokens.has(word.toUpperCase()) || /^[A-Z]{2,}\d*$/.test(word) && !nameWordMap[word.toLowerCase()]) return word;
    return nameWordMap[word.toLowerCase()] || transliterateFallback(word);
  });
}
function translateCopy(value, element) {
  if (interfaceLanguage.value !== 'gu') return value;
  const trimmed = String(value || '').trim();
  if (gujaratiCopy[trimmed]) return String(value).replace(trimmed, gujaratiCopy[trimmed]);
  // Codes, emails, URLs and a signed-in username are identifiers, not reader-facing copy.
  if (/^(?:https?:\/\/|\S+@\S+\.|[A-Z]{2,}\d*[A-Z0-9-]{2,})$/.test(trimmed) || element?.closest('.sign-out')) return value;
  if (/[A-Za-z]/.test(value)) return transliterateName(value);
  return String(value)
    .replace(/^Sign out\s*·/i, 'સાઇન આઉટ ·')
    .replace(/^Last (\d+) days$/i, 'છેલ્લા $1 દિવસ')
    .replace(/^Loading access requests\.\.\.$/i, 'ઍક્સેસ વિનંતીઓ લોડ થઈ રહી છે...');
}
function translateInterface(root = document.querySelector('#app')) {
  if (!root) return;
  translatingCopy = true;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = []; let node;
  while ((node = walker.nextNode())) nodes.push(node);
  for (const textNode of nodes) {
    const source = nodeSources.get(textNode) ?? textNode.nodeValue;
    nodeSources.set(textNode, source);
    const translated = translateCopy(source, textNode.parentElement);
    if (textNode.nodeValue !== translated) textNode.nodeValue = translated;
  }
  for (const element of root.querySelectorAll('[placeholder],[aria-label],[title]')) {
    const original = attributeSources.get(element) ?? {};
    for (const name of ['placeholder', 'aria-label', 'title']) {
      if (!element.hasAttribute(name)) continue;
      if (!(name in original)) original[name] = element.getAttribute(name);
      const translated = translateCopy(original[name], element);
      if (element.getAttribute(name) !== translated) element.setAttribute(name, translated);
    }
    attributeSources.set(element, original);
  }
  translatingCopy = false;
}
function setInterfaceLanguage(language) {
  interfaceLanguage.value = language;
  localStorage.setItem('fund-analysis-language', language);
}

function excelFileName(label) {
  return `${String(label).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'fund-analysis'}-${new Date().toISOString().slice(0, 10)}.xlsx`;
}

function downloadWorkbook(label, sheets) {
  const workbook = XLSX.utils.book_new();
  for (const [sheetName, rows] of sheets) {
    if (!rows?.length) continue;
    const worksheet = Array.isArray(rows[0]) ? XLSX.utils.aoa_to_sheet(rows) : XLSX.utils.json_to_sheet(rows);
    worksheet['!cols'] = Object.keys(rows[0]).map(() => ({ wch: 22 }));
    XLSX.utils.book_append_sheet(workbook, worksheet, sheetName.slice(0, 31));
  }
  XLSX.writeFile(workbook, excelFileName(label));
}

function downloadQuartiles() {
  const rows = quartileTables.value.flatMap((table) => table.rows.map((entry) => ({
    Quartile: table.label, Fund: entry.name, 'Direct Growth Return %': entry.direct?.value ?? null,
    'Regular Growth Return %': entry.regular?.value ?? null, 'Direct Scheme Code': entry.direct?.scheme_code ?? '',
    'Regular Scheme Code': entry.regular?.scheme_code ?? '',
  })));
  downloadWorkbook('quartiles', [
    ['Read me', [['Category', quartileMainCategory.value], ['Subcategory', quartileCategory.value], ['As of month', quartileAsOf.value], ['Period', `${quartileYears.value}Y${quartileYears.value > 1 ? ' CAGR' : ''}`], ['Return basis', quartileReturnMode.value === 'gross' ? 'Gross before TER (estimated)' : 'Net return from NAV']]],
    ['Quartiles', rows],
  ]);
}

function downloadPeerCategory() {
  const rows = visiblePeerRows.value.map((row) => ({ Fund: row.name, AMC: row.amc, 'Fund average return %': row.metrics[peerPeriod.value].averageFund, 'Benchmark average return %': row.metrics[peerPeriod.value].averageBenchmark, 'Alpha %': row.metrics[peerPeriod.value].alpha, 'Consistency %': row.metrics[peerPeriod.value].consistency, 'Rolling windows': row.metrics[peerPeriod.value].observations }));
  const excluded = peerExcludedSchemes.value.map((row) => ({ Fund: row.name, AMC: row.amc, 'Reported benchmark': row.reported_benchmark_name, Reason: 'Different reported benchmark from category comparison' }));
  downloadWorkbook('category-peers', [['Read me', [['Category', peerMainCategory.value], ['Subcategory', peerCategory.value], ['Plan', peerPlan.value], ['Holding period', `${peerPeriod.value}Y`], ['Category benchmark', peerBenchmark.value?.name || '']]], ['Eligible peers', rows], ['Not compared', excluded]]);
}

function downloadSelectedComparison() {
  const metrics = compareRows.value.map((row) => ({ Fund: row.scheme.name, AMC: row.scheme.amc, Category: row.scheme.category, NAV: row.latestNav, 'Total AUM crore': row.scheme.total_aum_crore, '1Y return %': row.returns.oneYear, '3Y CAGR %': row.returns.threeYear, '5Y CAGR %': row.returns.fiveYear, '1Y alpha %': row.benchmarkOutperformance.oneYear, '3Y alpha %': row.benchmarkOutperformance.threeYear, '5Y alpha %': row.benchmarkOutperformance.fiveYear }));
  const chart = compareChart.value;
  const historyRows = chart ? chart.dates.flatMap((date, index) => chart.series.map((series) => ({ Date: date, Fund: series.name, 'Rebased growth index': series.values[index] }))) : [];
  downloadWorkbook('selected-fund-comparison', [['Comparison', metrics], ['Rebased NAV history', historyRows]]);
}

function downloadOverlap() {
  if (!portfolioOverlap.value) return;
  const data = portfolioOverlap.value;
  downloadWorkbook('portfolio-overlap', [['Summary', [{ 'First fund': data.left.scheme.name, 'Second fund': data.right.scheme.name, 'Common holdings overlap %': data.sharedWeight * 100, 'Common sector overlap %': data.sharedSectorWeight * 100, 'First fund top-10 concentration %': data.leftTopTen * 100, 'Second fund top-10 concentration %': data.rightTopTen * 100 }]], ['Common holdings', data.commonHoldings.map((row) => ({ Holding: row.name, ISIN: row.isin, 'First fund weight %': row.leftWeight * 100, 'Second fund weight %': row.rightWeight * 100, 'Common weight %': row.commonWeight * 100 }))], ['First fund top 10', data.leftTopHoldings.map((row) => ({ Holding: row.instrument_name, ISIN: row.isin, 'Weight %': row.weight * 100 }))], ['Second fund top 10', data.rightTopHoldings.map((row) => ({ Holding: row.instrument_name, ISIN: row.isin, 'Weight %': row.weight * 100 }))]]);
}

function downloadPortfolioChanges() {
  if (!portfolioChanges.value || !portfolioChangeScheme.value) return;
  const data = portfolioChanges.value;
  const holdingRows = (items, changeLabel) => items.map((row) => ({ Holding: row.instrument_name, ISIN: row.isin, Type: holdingType(row).label, 'Previous weight %': row.previousWeight == null ? 0 : row.previousWeight * 100, 'Current weight %': row.weight * 100, 'Change pp': row.change * 100, Change: changeLabel }));
  downloadWorkbook('portfolio-changes', [['Read me', [['Fund', portfolioChangeScheme.value.scheme.name], ['Current disclosure', data.currentDate], ['Previous disclosure', data.previousDate]]], ['Added', holdingRows(data.additions, 'Added')], ['Exited', holdingRows(data.exits, 'Exited')], ['Weight changes', holdingRows([...data.increases, ...data.reductions], 'Weight change')], ['Sector shifts', data.sectorChanges.map((row) => ({ Sector: row.name, 'Previous weight %': row.previousWeight * 100, 'Current weight %': row.currentWeight * 100, 'Change pp': row.change * 100 }))]]);
}

function downloadNavDrivers() {
  if (!navDrivers.value) return;
  const data = navDrivers.value;
  const rows = [...data.positive, ...data.negative].map((row) => ({ Holding: row.instrument_name, Symbol: row.symbol || '', ISIN: row.isin, 'Portfolio weight %': row.weight * 100, 'Previous close': row.previous_close_price, Close: row.close_price, 'Stock return %': row.stockReturn, 'Estimated NAV impact pp': row.contribution }));
  downloadWorkbook('nav-movement-analysis', [['Read me', [['Fund', data.scheme.name], ['NAV date', data.date], ['Actual NAV move %', data.actual], ['Estimated holdings move %', data.estimated], ['Residual %', data.residual], ['Note', 'Estimate based on latest disclosed holdings and official NSE closing prices; not AMC attribution.']]], ['Priced drivers', rows]]);
}

function downloadUsageLogs() {
  const rows = Object.entries(adminUsage.value.events).flatMap(([type, events]) => events.map((event) => ({ Event: type, Name: event.full_name, Username: event.username, Email: event.email || '', Detail: event.event_value || '', 'Recorded at': event.created_at })));
  downloadWorkbook('usage-log', [['Read me', [['Period', `Last ${adminUsage.value.days} days`], ['Note', 'Super Admin activity is excluded. No searches, passwords, scheme selections, or IP addresses are recorded.']]], ['Usage events', rows]]);
}

function downloadSchemeDetail() {
  if (!selected.value) return;
  downloadWorkbook('scheme-detail', [['Scheme snapshot', [{ Fund: selected.value.name, AMC: selected.value.amc, Category: selected.value.category, 'Latest NAV': history.value.at(-1)?.nav ?? null, 'Latest NAV date': history.value.at(-1)?.date ?? null, Benchmark: selected.value.benchmark_name || '', 'Portfolio disclosure date': holdingPortfolio.value?.as_of_date || '' }]]]);
}

async function checkSession() {
  const response = await fetch('/api/auth/session');
  const payload = await response.json();
  authenticatedUser.value = payload.authenticated ? payload.username : '';
  authenticatedRole.value = payload.authenticated ? payload.role : '';
  authReady.value = true;
}

async function checkAccessStatus() {
  try {
    const response = await fetch('/api/auth/access-status');
    const payload = await response.json();
    accessStatus.value = payload.status ? payload : null;
  } catch {
    accessStatus.value = null;
  }
}

async function signIn() {
  loginLoading.value = true;
  loginError.value = '';
  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: loginUsername.value, password: loginPassword.value }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Could not sign in.');
    authenticatedUser.value = payload.username;
    authenticatedRole.value = payload.role;
    loginPassword.value = '';
    await Promise.all([loadSchemes(), loadCategories()]);
    trackUsage('schemes');
  } catch (requestError) {
    loginError.value = requestError.message;
  } finally {
    loginLoading.value = false;
  }
}

async function trackUsage(section) {
  if (!authenticatedUser.value) return;
  try {
    await fetch('/api/usage/page-view', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ section }),
    });
  } catch {
    // Usage logging must never block the research workspace.
  }
}

async function requestAccess() {
  requestLoading.value = true;
  requestError.value = '';
  requestMessage.value = '';
  try {
    const response = await fetch('/api/auth/request-access', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fullName: requestFullName.value, username: requestUsername.value, email: requestEmail.value, password: requestPassword.value }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Could not submit your access request.');
    requestMessage.value = payload.message;
    requestPassword.value = '';
    accessStatus.value = { status: payload.status, username: payload.username, fullName: requestFullName.value };
    authMode.value = 'sign-in';
  } catch (requestFailure) {
    requestError.value = requestFailure.message;
  } finally {
    requestLoading.value = false;
  }
}

async function loadAdminUsers() {
  if (authenticatedRole.value !== 'super_admin') return;
  adminLoading.value = true;
  adminError.value = '';
  try {
    const response = await fetch('/api/admin/users');
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Could not load access requests.');
    adminUsers.value = payload.users;
  } catch (requestFailure) {
    adminError.value = requestFailure.message;
  } finally {
    adminLoading.value = false;
  }
}

async function loadAdminUsage() {
  if (authenticatedRole.value !== 'super_admin') return;
  try {
    const response = await fetch(`/api/admin/usage?days=30&q=${encodeURIComponent(usageSearch.value)}`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Could not load usage activity.');
    adminUsage.value = payload;
  } catch (requestFailure) {
    adminError.value = requestFailure.message;
  }
}

async function updateUserAccess(userId, action) {
  adminError.value = '';
  try {
    const response = await fetch(`/api/admin/users/${userId}/${action}`, { method: 'POST' });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Could not update this account.');
    await loadAdminUsers();
  } catch (requestFailure) {
    adminError.value = requestFailure.message;
  }
}

function showAdminPanel() {
  closeDetail();
  view.value = 'admin';
  Promise.all([loadAdminUsers(), loadAdminUsage()]);
}

async function signOut() {
  await fetch('/api/auth/logout', { method: 'POST' });
  authenticatedUser.value = '';
  authenticatedRole.value = '';
  selected.value = null;
}

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
  const label = String(category || '')
    .replace(/^(Equity|Debt|Hybrid) Schemes? - /i, '')
    .replace(/^Income\/Debt Oriented Schemes - /i, '')
    .replace(/^Exchange Traded Funds \(ETFs\) - /i, '')
    .replace(/^Index Funds - /i, 'Index Fund: ')
    .replace(/^Other Scheme - /i, '')
    .trim();
  const aliases = {
    'elss- tax saver fund': 'ELSS',
    'banking and psu debt fund': 'Banking and PSU Fund',
    'dynamic term fund': 'Dynamic Bond',
    'medium term fund': 'Medium Duration Fund',
    'short term fund': 'Short Duration Fund',
    'ultra short term fund': 'Ultra Short Duration Fund',
    'ultra short to short term fund': 'Ultra Short Duration Fund',
    gilt: 'Gilt Fund',
    'balanced advantage fund/ dynamic asset allocation': 'Dynamic Asset Allocation or Balanced Advantage',
    'equity savings fund': 'Equity Savings',
    'multi asset allocation fund': 'Multi Asset Allocation',
    'fund of funds scheme (domestic)': 'FoF Domestic',
    'fund of funds investing overseas': 'FoF Overseas',
  };
  return aliases[label.toLowerCase()] || label;
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
  peerBenchmarkMismatchCount.value = 0;
  peerExcludedSchemes.value = [];
  peerBenchmarkHistoryAvailable.value = false;
}

async function loadQuartiles() {
  if (!quartileCategory.value) return;
  quartileLoading.value = true;
  error.value = '';
  try {
    const sourceCategories = selectedQuartileSubcategory.value?.sourceCategories || [];
    if (!sourceCategories.length) return;
    const response = await fetch(`/api/categories/${encodeURIComponent(quartileCategory.value)}/nav-snapshot?years=${quartileYears.value}&asOf=${encodeURIComponent(quartileAsOf.value)}&plans=growth-direct-regular&includeTer=1&categories=${encodeURIComponent(JSON.stringify(sourceCategories))}`);
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

function setQuartileReturnMode(mode) {
  quartileReturnMode.value = mode;
  // TER mappings can be refreshed while the local app remains open. Reload
  // the raw observations when switching basis so a stale in-memory response
  // cannot make otherwise covered funds disappear.
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

function addUtcDays(dateString, days) {
  const date = new Date(`${dateString}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function grossExpenseFactor(row) {
  const points = row.ter?.change_points || [];
  const coverage = row.ter?.coverage;
  if (!points.length || !coverage?.first_date || !coverage.last_date || coverage.ambiguous_days > 0) return null;
  const startCoverageGap = Math.round((Date.parse(`${coverage.first_date}T00:00:00Z`) - Date.parse(`${row.start_date}T00:00:00Z`)) / 86_400_000);
  const endCoverageGap = Math.round((Date.parse(`${row.latest_date}T00:00:00Z`) - Date.parse(`${coverage.last_date}T00:00:00Z`)) / 86_400_000);
  // TER changes infrequently; carry the latest official value for at most
  // 14 days so a short publication lag does not remove an otherwise valid fund.
  if (startCoverageGap > 0 || endCoverageGap > 14) return null;
  if (coverage.max_gap_days && coverage.max_gap_days > 14) return null;

  const firstApplicableDate = addUtcDays(row.start_date, 1);
  let pointIndex = points.findLastIndex((point) => point.date <= firstApplicableDate);
  if (pointIndex < 0) return null;
  let currentDate = firstApplicableDate;
  let factor = 1;
  while (currentDate <= row.latest_date) {
    const annualTer = points[pointIndex]?.value;
    if (!Number.isFinite(annualTer) || annualTer <= 0 || annualTer >= 100) return null;
    const nextDate = points[pointIndex + 1]?.date;
    const segmentEnd = nextDate && nextDate <= row.latest_date ? addUtcDays(nextDate, -1) : row.latest_date;
    const calendarDays = Math.max(0, Math.round((Date.parse(`${segmentEnd}T00:00:00Z`) - Date.parse(`${currentDate}T00:00:00Z`)) / 86_400_000) + 1);
    const dailyExpenseRate = annualTer / 100 / 365.2425;
    factor *= Math.pow(1 - dailyExpenseRate, -calendarDays);
    if (!nextDate || nextDate > row.latest_date) break;
    currentDate = nextDate;
    pointIndex += 1;
  }
  return factor;
}

function snapshotReturn(row, years, mode = 'net') {
  if (!Number.isFinite(row.latest_nav) || !Number.isFinite(row.start_nav) || row.start_nav <= 0) return null;
  let totalReturn = row.latest_nav / row.start_nav;
  if (mode === 'gross') {
    const expenseFactor = grossExpenseFactor(row);
    if (!Number.isFinite(expenseFactor)) return null;
    totalReturn *= expenseFactor;
  }
  if (years === 1) return (totalReturn - 1) * 100;
  const elapsedDays = (Date.parse(`${row.latest_date}T00:00:00Z`) - Date.parse(`${row.start_date}T00:00:00Z`)) / 86_400_000;
  return elapsedDays > 0 ? (Math.pow(totalReturn, 365.2425 / elapsedDays) - 1) * 100 : null;
}

function quartilePlanPreference(name, type) {
  const normalized = String(name || '').toLowerCase();
  if (type === 'direct') return /\bdirect\b/.test(normalized) ? 2 : 1;
  return /\bregular\b/.test(normalized) ? 2 : 1;
}

const quartileTables = computed(() => {
  const families = new Map();
  for (const row of quartileRows.value) {
    const type = growthPlanType(row.name);
    const value = snapshotReturn(row, quartileYears.value, quartileReturnMode.value);
    if (!type || !Number.isFinite(value)) continue;
    const key = planFamily(row.name);
    const entry = families.get(key) || { family: key, direct: null, regular: null };
    // A family can occasionally have duplicate plan records; prefer the one
    // with the latest source NAV date.
    const candidate = { ...row, value, planPreference: quartilePlanPreference(row.name, type) };
    if (!entry[type]
      || row.latest_date > entry[type].latest_date
      || (row.latest_date === entry[type].latest_date && candidate.planPreference > entry[type].planPreference)) {
      entry[type] = candidate;
    }
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
  const displayedAmcs = ranked.filter((entry) => {
    // Rank the complete eligible AMC universe, then display its best 20
    // representatives. No AMC is removed from the source universe.
    if (!entry.amc || includedAmcs.has(entry.amc) || includedAmcs.size >= 20) return false;
    includedAmcs.add(entry.amc);
    return true;
  });
  // Split the ranked set into consecutive, near-equal groups. The earlier
  // proportional-index approach could put two funds in Q1 and Q3, leaving
  // Q2 empty. Filling groups in order keeps small historical universes
  // intelligible: two funds become Q1 and Q2, not Q1 and Q3.
  const baseSize = Math.floor(displayedAmcs.length / 4);
  const remainder = displayedAmcs.length % 4;
  let offset = 0;
  return [0, 1, 2, 3].map((quartile) => {
    const size = baseSize + (quartile < remainder ? 1 : 0);
    const rows = displayedAmcs.slice(offset, offset + size);
    offset += size;
    return {
      label: `Q${quartile + 1}`,
      subtitle: ['Top 25%', 'Next 25%', 'Next 25%', 'Bottom 25%'][quartile],
      rows,
    };
  });
});

const quartileGrossCoverage = computed(() => {
  const eligible = quartileRows.value.filter((row) => growthPlanType(row.name) && Number.isFinite(snapshotReturn(row, quartileYears.value, 'net')));
  const covered = eligible.filter((row) => Number.isFinite(snapshotReturn(row, quartileYears.value, 'gross')));
  return { eligible: eligible.length, covered: covered.length };
});

async function showQuartiles() {
  closeDetail();
  view.value = 'quartiles';
  if (!categories.value.length) {
    try { await loadCategories(); } catch (requestError) { error.value = requestError.message; }
  }
}

async function showCompare() {
  closeDetail();
  view.value = 'peers';
  analysisMode.value = 'selected';
  compareResults.value = [];
}

async function showPeerAnalysis() {
  closeDetail();
  view.value = 'peers';
  analysisMode.value = 'peers';
  if (!categories.value.length) {
    try { await loadCategories(); } catch (requestError) { error.value = requestError.message; }
  }
}

function showPortfolioOverlap() {
  closeDetail();
  view.value = 'overlap';
  overlapResults.value = [];
}

function showPortfolioChanges() {
  closeDetail();
  view.value = 'changes';
  portfolioChangeResults.value = [];
}

function showNavDrivers() {
  closeDetail();
  view.value = 'drivers';
  navDriverResults.value = [];
}

function showSchemes() {
  closeDetail();
  view.value = 'schemes';
}

function subtractCalendarYears(dateString, years) {
  const date = new Date(`${dateString}T00:00:00Z`);
  const month = date.getUTCMonth();
  date.setUTCFullYear(date.getUTCFullYear() - years);
  // 29 February becomes 28 February in a non-leap target year.
  if (date.getUTCMonth() !== month) date.setUTCDate(0);
  return date.toISOString().slice(0, 10);
}

function subtractCalendarMonths(dateString, months) {
  const date = new Date(`${dateString}T00:00:00Z`);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() - months);
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
  return date.toISOString().slice(0, 10);
}

function subtractPeriod(dateString, months) {
  return months % 12 === 0 ? subtractCalendarYears(dateString, months / 12) : subtractCalendarMonths(dateString, months);
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
    peerBenchmarkMismatchCount.value = payload.benchmark_mismatch_count || 0;
    peerExcludedSchemes.value = payload.excluded_schemes || [];
    peerBenchmarkHistoryAvailable.value = Boolean(payload.benchmark_history?.length);
    // Yield once so the loading state is visible before the browser performs
    // the deliberately frontend-only rolling calculations.
    await new Promise((resolve) => setTimeout(resolve, 0));
    peerRows.value = payload.schemes
      .map((scheme) => ({
        ...scheme,
        metrics: peerRollingMetrics(payload.histories[scheme.scheme_code], payload.benchmark_history),
      }));
    peerInspectedScheme.value = peerRows.value.find((scheme) => Object.values(scheme.metrics).some(Boolean))?.scheme_code || '';
  } catch (requestError) {
    error.value = requestError.message;
    peerRows.value = [];
    peerInspectedScheme.value = '';
    peerBenchmark.value = null;
    peerBenchmarkMismatchCount.value = 0;
    peerExcludedSchemes.value = [];
    peerBenchmarkHistoryAvailable.value = false;
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

const peerInspectableRows = computed(() => peerRows.value
  .filter((row) => Object.values(row.metrics).some(Boolean))
  .sort((left, right) => left.name.localeCompare(right.name)));

const peerInspectedRow = computed(() => peerInspectableRows.value
  .find((row) => row.scheme_code === peerInspectedScheme.value) || peerInspectableRows.value[0] || null);

const peerConsistencyTrend = computed(() => {
  const row = peerInspectedRow.value;
  if (!row) return null;
  const points = [1, 2, 3, 4, 5]
    .map((years) => ({ years, metric: row.metrics[years] }))
    .filter((point) => point.metric && Number.isFinite(point.metric.consistency));
  if (!points.length) return null;
  const width = 560;
  const height = 170;
  const padding = { top: 18, right: 18, bottom: 32, left: 42 };
  const x = (index) => points.length === 1 ? width / 2 : padding.left + (index / (points.length - 1)) * (width - padding.left - padding.right);
  const y = (value) => padding.top + ((100 - value) / 100) * (height - padding.top - padding.bottom);
  const change = points.at(-1).metric.consistency - points[0].metric.consistency;
  return {
    ...row,
    width, height, padding, points: points.map((point, index) => ({ ...point, x: x(index), y: y(point.metric.consistency) })),
    polyline: points.map((point, index) => `${x(index).toFixed(1)},${y(point.metric.consistency).toFixed(1)}`).join(' '),
    interpretation: change >= 5 ? 'Improving consistency' : change <= -5 ? 'Weakening consistency' : 'Stable consistency',
    change,
  };
});

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
    const response = await fetch(`/api/schemes?q=${encodeURIComponent(query)}&limit=12&plan=growth`);
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
  compareChartHover.value = null;
}

function setCompareChartRange(range) {
  compareChartRange.value = range;
  compareChartHover.value = null;
}

async function searchPortfolioOverlap() {
  const query = overlapSearch.value.trim();
  if (query.length < 2) return;
  overlapLoading.value = true;
  error.value = '';
  try {
    const response = await fetch(`/api/schemes?q=${encodeURIComponent(query)}&limit=12&plan=growth`);
    if (!response.ok) throw new Error('Could not search schemes for portfolio overlap.');
    overlapResults.value = (await response.json()).schemes;
  } catch (requestError) {
    error.value = requestError.message;
  } finally {
    overlapLoading.value = false;
  }
}

async function addToPortfolioOverlap(scheme) {
  if (overlapSelection.value.some((item) => item.scheme.scheme_code === scheme.scheme_code) || overlapSelection.value.length >= 2) return;
  overlapLoading.value = true;
  error.value = '';
  try {
    const response = await fetch(`/api/schemes/${encodeURIComponent(scheme.scheme_code)}/holdings`);
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || 'No verified monthly portfolio disclosure is available for this scheme yet.');
    }
    const payload = await response.json();
    overlapSelection.value = [...overlapSelection.value, {
      scheme,
      portfolio: payload.portfolio,
      holdings: payload.holdings || [],
    }];
    overlapSearch.value = '';
    overlapResults.value = [];
  } catch (requestError) {
    error.value = requestError.message;
  } finally {
    overlapLoading.value = false;
  }
}

function removeFromPortfolioOverlap(schemeCode) {
  overlapSelection.value = overlapSelection.value.filter((item) => item.scheme.scheme_code !== schemeCode);
}

async function searchPortfolioChanges() {
  const query = portfolioChangeSearch.value.trim();
  if (query.length < 2) return;
  portfolioChangeLoading.value = true;
  error.value = '';
  try {
    const response = await fetch(`/api/schemes?q=${encodeURIComponent(query)}&limit=12&plan=growth`);
    if (!response.ok) throw new Error('Could not search schemes for portfolio changes.');
    portfolioChangeResults.value = (await response.json()).schemes;
  } catch (requestError) {
    error.value = requestError.message;
  } finally {
    portfolioChangeLoading.value = false;
  }
}

async function selectPortfolioChangeScheme(scheme) {
  portfolioChangeLoading.value = true;
  error.value = '';
  portfolioChangeSnapshots.value = [];
  try {
    const response = await fetch(`/api/schemes/${encodeURIComponent(scheme.scheme_code)}/holdings/history`);
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || 'No verified monthly portfolio disclosure is available for this scheme yet.');
    }
    const payload = await response.json();
    portfolioChangeScheme.value = { scheme, portfolio: payload.portfolio };
    portfolioChangeSnapshots.value = payload.snapshots || [];
    portfolioChangeSearch.value = '';
    portfolioChangeResults.value = [];
  } catch (requestError) {
    error.value = requestError.message;
  } finally {
    portfolioChangeLoading.value = false;
  }
}

function clearPortfolioChangeScheme() {
  portfolioChangeScheme.value = null;
  portfolioChangeSnapshots.value = [];
}

async function searchNavDrivers() {
  if (navDriverSearch.value.trim().length < 2) return;
  navDriverLoading.value = true; error.value = '';
  try {
    const response = await fetch(`/api/schemes?q=${encodeURIComponent(navDriverSearch.value.trim())}&limit=12&plan=growth`);
    if (!response.ok) throw new Error('Could not search schemes for NAV drivers.');
    navDriverResults.value = (await response.json()).schemes;
  } catch (requestError) { error.value = requestError.message; } finally { navDriverLoading.value = false; }
}

async function selectNavDriverScheme(scheme) {
  navDriverLoading.value = true; error.value = ''; navDriverData.value = null; marketSectorPulse.value = null; marketSectorNews.value = null;
  try {
    const response = await fetch(`/api/schemes/${encodeURIComponent(scheme.scheme_code)}/nav-drivers`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Could not load NAV-driver source data.');
    navDriverData.value = payload; navDriverSearch.value = ''; navDriverResults.value = [];
    const sectorResponse = await fetch(`/api/market-sector-pulse?date=${encodeURIComponent(payload.date)}`);
    if (sectorResponse.ok) marketSectorPulse.value = await sectorResponse.json();
    const newsResponse = await fetch(`/api/market-sector-news?date=${encodeURIComponent(payload.date)}`);
    if (newsResponse.ok) marketSectorNews.value = await newsResponse.json();
  } catch (requestError) { error.value = requestError.message; } finally { navDriverLoading.value = false; }
}

const navDrivers = computed(() => {
  const source = navDriverData.value;
  if (!source) return null;
  const eligible = source.positions.filter((row) => Number.isFinite(row.weight) && row.weight > 0 && row.weight <= 5);
  const covered = eligible.filter((row) => Number.isFinite(row.close_price) && Number.isFinite(row.previous_close_price) && row.previous_close_price > 0);
  const rows = covered.map((row) => ({ ...row, stockReturn: (row.close_price / row.previous_close_price - 1) * 100, contribution: row.weight * (row.close_price / row.previous_close_price - 1) * 100 }));
  const estimated = rows.reduce((total, row) => total + row.contribution, 0);
  const actual = (source.nav.nav / source.previous_nav.nav - 1) * 100;
  return { ...source, actual, estimated, residual: actual - estimated, coverage: covered.reduce((total, row) => total + row.weight, 0) * 100, positive: rows.filter((row) => row.contribution > 0).sort((a, b) => b.contribution - a.contribution).slice(0, 10), negative: rows.filter((row) => row.contribution < 0).sort((a, b) => a.contribution - b.contribution).slice(0, 10) };
});

const navDriverExplanation = computed(() => {
  const data = navDrivers.value;
  if (!data) return null;
  const direction = data.actual >= 0 ? 'rose' : 'fell';
  const lead = data.actual >= 0 ? data.positive[0] : data.negative[0];
  const leadText = lead ? `${lead.instrument_name} was the largest ${data.actual >= 0 ? 'positive' : 'negative'} contributor at ${lead.contribution >= 0 ? '+' : ''}${lead.contribution.toFixed(3)} percentage points.` : 'No individually priced holding was available to explain the move.';
  return `The fund NAV ${direction} ${Math.abs(data.actual).toFixed(2)}%. Priced disclosed holdings indicate a ${data.estimated >= 0 ? '+' : ''}${data.estimated.toFixed(2)}% movement across ${data.coverage.toFixed(1)}% of the portfolio. ${leadText}`;
});

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
  const startingNav = latestPointOnOrBefore(history.value, subtractPeriod(latest.date, months));
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
  const start = latestPointOnOrBefore(points, subtractPeriod(end.date, months));
  if (!start || start.date === end.date) return null;
  const totalReturn = end.value / start.value;
  const elapsedDays = (Date.parse(`${end.date}T00:00:00Z`) - Date.parse(`${start.date}T00:00:00Z`)) / 86_400_000;
  if (!Number.isFinite(totalReturn) || elapsedDays <= 0) return null;
  return annualised ? (Math.pow(totalReturn, 365.2425 / elapsedDays) - 1) * 100 : (totalReturn - 1) * 100;
}

function alignedPeriodReturns(fundPoints, benchmarkPoints, months, annualised = false, desiredEndDate = null) {
  if (fundPoints.length < 2 || benchmarkPoints.length < 2 || !desiredEndDate) return null;
  const benchmarkByDate = new Map(benchmarkPoints.map((point) => [point.date, point.value]));
  const aligned = fundPoints
    .filter((point) => Number.isFinite(benchmarkByDate.get(point.date)))
    .map((point) => ({ date: point.date, fund: point.value, benchmark: benchmarkByDate.get(point.date) }));
  const end = latestPointOnOrBefore(aligned, desiredEndDate);
  if (!end) return null;
  const start = latestPointOnOrBefore(aligned, subtractPeriod(end.date, months));
  if (!start || start.date === end.date) return null;
  const elapsedDays = (Date.parse(`${end.date}T00:00:00Z`) - Date.parse(`${start.date}T00:00:00Z`)) / 86_400_000;
  if (elapsedDays <= 0 || start.fund <= 0 || start.benchmark <= 0) return null;
  const exponent = annualised ? 365.2425 / elapsedDays : 1;
  const fund = (Math.pow(end.fund / start.fund, exponent) - 1) * 100;
  const benchmark = (Math.pow(end.benchmark / start.benchmark, exponent) - 1) * 100;
  if (!Number.isFinite(fund) || !Number.isFinite(benchmark)) return null;
  return { startDate: start.date, endDate: end.date, fund, benchmark, outperformance: fund - benchmark };
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
      const aligned = alignedPeriodReturns(fundPoints, item.benchmarkHistory, months, annualised, commonEnd);
      if (aligned) benchmarkOutperformance[key] = aligned.outperformance;
    }
  }
  return {
    ...item,
    latestNav: item.history.at(-1)?.nav ?? null,
    returns,
    benchmarkOutperformance,
  };
}));

const compareChart = computed(() => {
  if (compareSelection.value.length < 2) return null;
  const endDate = compareSelection.value.map((item) => item.history.at(-1)?.date).filter(Boolean).sort()[0];
  if (!endDate) return null;
  const months = ranges[compareChartRange.value];
  const desiredStart = months ? subtractPeriod(endDate, months) : null;
  const histories = compareSelection.value.map((item) => new Map(item.history
    .filter((point) => point.date <= endDate && (!desiredStart || point.date >= desiredStart))
    .map((point) => [point.date, point.nav])));
  const commonDates = [...histories[0].keys()]
    .filter((date) => histories.every((historyByDate) => Number.isFinite(historyByDate.get(date))))
    .sort();
  if (commonDates.length < 2) return null;
  const limit = 420;
  const step = Math.ceil(commonDates.length / limit);
  const dates = commonDates.filter((_, index) => index % step === 0 || index === commonDates.length - 1);
  const palette = ['#4f826c', '#a67b46', '#5d72a2', '#a35d72', '#6f8050'];
  const series = compareSelection.value.map((item, index) => {
    const firstNav = histories[index].get(commonDates[0]);
    return {
      schemeCode: item.scheme.scheme_code,
      name: item.scheme.name,
      color: palette[index],
      values: dates.map((date) => (histories[index].get(date) / firstNav) * 100),
    };
  });
  const values = series.flatMap((item) => item.values);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || Math.max(max * 0.02, 1);
  const width = 720;
  const height = 250;
  const padding = { top: 18, right: 14, bottom: 30, left: 58 };
  const x = (index) => padding.left + (index / (dates.length - 1)) * (width - padding.left - padding.right);
  const y = (value) => padding.top + ((max - value) / span) * (height - padding.top - padding.bottom);
  return {
    width, height, padding, min, max, dates, startDate: commonDates[0], endDate: commonDates.at(-1),
    xPositions: dates.map((_, index) => x(index)),
    series: series.map((item) => ({
      ...item,
      polyline: item.values.map((value, index) => `${x(index).toFixed(1)},${y(value).toFixed(1)}`).join(' '),
      endY: y(item.values.at(-1)),
    })),
  };
});

const compareChartHoverDetails = computed(() => {
  const chart = compareChart.value;
  const index = compareChartHover.value;
  if (!chart || !Number.isInteger(index) || index < 0 || index >= chart.dates.length) return null;
  const x = chart.xPositions[index];
  return {
    date: chart.dates[index],
    x,
    left: Math.min(84, Math.max(6, (x / chart.width) * 100)),
    series: chart.series.map((item) => ({
      ...item,
      value: item.values[index],
      returnSinceStart: item.values[index] - 100,
    })),
  };
});

function updateCompareChartHover(event) {
  const chart = compareChart.value;
  if (!chart) return;
  const rect = event.currentTarget.getBoundingClientRect();
  const svgX = ((event.clientX - rect.left) / rect.width) * chart.width;
  const plotWidth = chart.width - chart.padding.left - chart.padding.right;
  const index = Math.round(((svgX - chart.padding.left) / plotWidth) * (chart.dates.length - 1));
  compareChartHover.value = Math.max(0, Math.min(chart.dates.length - 1, index));
}

const benchmarkComparison = computed(() => {
  if (isDistributionScheme.value || !selected.value?.benchmark_name || !benchmarkHistory.value.length || !history.value.length) return null;
  const fundAsValues = history.value.map((point) => ({ date: point.date, value: point.nav }));
  const commonEnd = [history.value.at(-1).date, benchmarkHistory.value.at(-1).date].sort()[0];
  const periods = [
    { label: '1Y', months: 12, annualised: false },
    { label: '3Y', months: 36, annualised: true },
    { label: '5Y', months: 60, annualised: true },
  ].map((period) => ({
    ...period,
    ...(alignedPeriodReturns(fundAsValues, benchmarkHistory.value, period.months, period.annualised, commonEnd)
      || { fund: null, benchmark: null, outperformance: null, startDate: null, endDate: null }),
  }));
  return { asOf: periods.find((period) => period.endDate)?.endDate || commonEnd, periods };
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
  const orderedRates = [...rates].sort((left, right) => left.date.localeCompare(right.date));
  let rateIndex = -1;
  let lastRate = null;
  const excess = [];
  for (const point of fundReturns) {
    while (rateIndex + 1 < orderedRates.length && orderedRates[rateIndex + 1].date <= point.date) {
      rateIndex += 1;
      lastRate = orderedRates[rateIndex].annual_rate_percent;
    }
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
  const annualisation = 12 / relevant.length;
  const fundReturn = Math.pow(relevant.reduce((product, month) => product * (1 + month.fund), 1), annualisation) - 1;
  const comparisonReturn = Math.pow(relevant.reduce((product, month) => product * (1 + month[comparisonKey]), 1), annualisation) - 1;
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
  if (isDistributionScheme.value || !history.value.length) return null;
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
  if (!isDebtScheme.value || isDistributionScheme.value) return null;
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
    start = latestPointOnOrBefore(commonPoints, subtractPeriod(end.date, months));
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
    || /^(?:net assets?|total|sub.?total|benchmark|nav as on|as on\b|number of contracts?|gross notional|at the end|instrument type|% of investment|aggregate dividend|plan\/option)/i.test(name)
    || (!holding.isin && !holding.industry_or_rating && /^(?:government securities|non-convertible debentures\s*\/\s*bonds|corporate debt securities|commercial paper|certificates? of deposit|treasury bills?|money market instruments|pass through certificates|securiti[zs]ed debt|floating rate notes|equity shares|mutual fund units|interest rate swaps?(?: \(at notional value\))?)$/i.test(name))
    || /returns?\s*\(\s*annualised\s*\)/i.test(name);
}

function isDerivativeDisclosureRow(holding) {
  const label = [holding.asset_class, holding.holding_group, holding.instrument_name]
    .map(disclosureLabel).join(' ');
  return /\b(?:derivatives?|futures?|options?|swaps?|irs|forward contracts?)\b/i.test(label);
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
    // A small number of debt disclosures legitimately exceed 100% gross
    // exposure because liabilities/derivatives offset the long position.
    && holding.weight <= 5
    && !isDisclosureSummaryRow(holding)
    && !isDerivativeDisclosureRow(holding)));

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

function overlapHoldings(rows) {
  return rows.filter((holding) => Number.isFinite(holding.weight)
    && holding.weight > 0
    && holding.weight <= 5
    && holding.isin
    && !isDisclosureSummaryRow(holding)
    && !isDerivativeDisclosureRow(holding));
}

function holdingByIsin(rows) {
  const mapped = new Map();
  for (const holding of overlapHoldings(rows)) {
    const key = String(holding.isin).trim().toUpperCase();
    if (!key) continue;
    const current = mapped.get(key);
    if (!current || holding.weight > current.weight) mapped.set(key, holding);
  }
  return mapped;
}

function holdingType(holding) {
  const assetClass = String(holding?.asset_class || '').toLowerCase();
  const descriptor = `${holding?.holding_group || ''} ${holding?.instrument_name || ''} ${holding?.industry_or_rating || ''}`.toLowerCase();
  if (assetClass.includes('equity') || assetClass.includes('share')) return { label: 'Equity', className: 'equity' };
  if (assetClass.includes('debt') || /\b(bond|debenture|government securit|g-sec|treasury bill|commercial paper|certificate of deposit|floating rate|frn|securiti[sz]ed debt)\b/.test(descriptor)) return { label: 'Debt', className: 'debt' };
  if (assetClass.includes('money market') || /\b(treps|repo|reverse repo|cash|money market)\b/.test(descriptor)) return { label: 'Cash / money market', className: 'cash' };
  // Some AMC files omit asset_class on individual equity rows but supply a sector.
  if (holding?.industry_or_rating && !/\b(aaa|aa\+?|a\+?|a1\+?|p1\+?|sov|unrated)\b/i.test(String(holding.industry_or_rating))) return { label: 'Equity', className: 'equity' };
  return { label: 'Other', className: 'other' };
}

function allocationBySector(rows) {
  const allocations = new Map();
  for (const holding of overlapHoldings(rows)) {
    const name = disclosedSector(holding);
    if (!name) continue;
    const key = sectorKey(name);
    const current = allocations.get(key) || { name, weight: 0 };
    current.weight += holding.weight;
    allocations.set(key, current);
  }
  return allocations;
}

function topTenWeight(rows) {
  return overlapHoldings(rows)
    .sort((left, right) => right.weight - left.weight)
    .slice(0, 10)
    .reduce((total, holding) => total + holding.weight, 0);
}

function topTenHoldings(rows) {
  return overlapHoldings(rows)
    .sort((left, right) => right.weight - left.weight)
    .slice(0, 10);
}

const portfolioOverlap = computed(() => {
  if (overlapSelection.value.length !== 2) return null;
  const [left, right] = overlapSelection.value;
  const leftByIsin = holdingByIsin(left.holdings);
  const rightByIsin = holdingByIsin(right.holdings);
  const commonHoldings = [];
  let sharedWeight = 0;
  let leftSharedWeight = 0;
  let rightSharedWeight = 0;
  for (const [isin, leftHolding] of leftByIsin) {
    const rightHolding = rightByIsin.get(isin);
    if (!rightHolding) continue;
    const commonWeight = Math.min(leftHolding.weight, rightHolding.weight);
    sharedWeight += commonWeight;
    leftSharedWeight += leftHolding.weight;
    rightSharedWeight += rightHolding.weight;
    commonHoldings.push({
      isin,
      name: leftHolding.instrument_name || rightHolding.instrument_name,
      leftWeight: leftHolding.weight,
      rightWeight: rightHolding.weight,
      commonWeight,
    });
  }
  const leftSectors = allocationBySector(left.holdings);
  const rightSectors = allocationBySector(right.holdings);
  let sharedSectorWeight = 0;
  for (const [key, leftSector] of leftSectors) {
    const rightSector = rightSectors.get(key);
    if (rightSector) sharedSectorWeight += Math.min(leftSector.weight, rightSector.weight);
  }
  return {
    left,
    right,
    sharedWeight,
    leftSharedWeight,
    rightSharedWeight,
    sharedSectorWeight,
    leftTopTen: topTenWeight(left.holdings),
    rightTopTen: topTenWeight(right.holdings),
    commonHoldings: commonHoldings.sort((a, b) => b.commonWeight - a.commonWeight).slice(0, 10),
    leftTopHoldings: topTenHoldings(left.holdings),
    rightTopHoldings: topTenHoldings(right.holdings),
    comparableLeftWeight: [...leftByIsin.values()].reduce((total, holding) => total + holding.weight, 0),
    comparableRightWeight: [...rightByIsin.values()].reduce((total, holding) => total + holding.weight, 0),
  };
});

const portfolioChanges = computed(() => {
  if (portfolioChangeSnapshots.value.length < 2) return null;
  const [current, previous] = portfolioChangeSnapshots.value;
  const currentByIsin = holdingByIsin(current.holdings);
  const previousByIsin = holdingByIsin(previous.holdings);
  const additions = [];
  const exits = [];
  const increases = [];
  const reductions = [];
  for (const [isin, holding] of currentByIsin) {
    const prior = previousByIsin.get(isin);
    if (!prior) additions.push({ ...holding, change: holding.weight });
    else if (holding.weight - prior.weight >= 0.001) increases.push({ ...holding, previousWeight: prior.weight, change: holding.weight - prior.weight });
    else if (prior.weight - holding.weight >= 0.001) reductions.push({ ...holding, previousWeight: prior.weight, change: holding.weight - prior.weight });
  }
  for (const [isin, holding] of previousByIsin) {
    if (!currentByIsin.has(isin)) exits.push({ ...holding, change: -holding.weight });
  }
  const currentSectors = allocationBySector(current.holdings);
  const previousSectors = allocationBySector(previous.holdings);
  const sectorKeys = new Set([...currentSectors.keys(), ...previousSectors.keys()]);
  const sectorChanges = [...sectorKeys].map((key) => {
    const latest = currentSectors.get(key);
    const prior = previousSectors.get(key);
    return { name: latest?.name || prior?.name || key, currentWeight: latest?.weight || 0, previousWeight: prior?.weight || 0, change: (latest?.weight || 0) - (prior?.weight || 0) };
  }).filter((item) => Math.abs(item.change) >= 0.001).sort((left, right) => Math.abs(right.change) - Math.abs(left.change)).slice(0, 6);
  return {
    currentDate: current.as_of_date,
    previousDate: previous.as_of_date,
    newHoldingCount: additions.length,
    exitedHoldingCount: exits.length,
    additions: additions.sort((left, right) => right.weight - left.weight),
    exits: exits.sort((left, right) => right.weight - left.weight),
    increases: increases.sort((left, right) => right.change - left.change).slice(0, 5),
    reductions: reductions.sort((left, right) => left.change - right.change).slice(0, 5),
    sectorChanges,
    topTenChange: topTenWeight(current.holdings) - topTenWeight(previous.holdings),
  };
});

function maturityDateFromHolding(name) {
  const value = String(name || '');
  const numeric = value.match(/\b(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})\b/);
  if (numeric) {
    const year = Number(numeric[3]) < 100 ? 2000 + Number(numeric[3]) : Number(numeric[3]);
    const date = new Date(Date.UTC(year, Number(numeric[2]) - 1, Number(numeric[1])));
    if (!Number.isNaN(date.getTime())) return date;
  }
  const named = value.match(/\b(\d{1,2})[-\s]([A-Za-z]{3,9})[-\s](\d{2,4})\b/);
  if (!named) return null;
  const year = Number(named[3]) < 100 ? 2000 + Number(named[3]) : Number(named[3]);
  const date = new Date(`${named[1]} ${named[2]} ${year} UTC`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function creditBucket(value) {
  const rating = String(value || '').toUpperCase();
  if (/\b(?:SOV|SOVEREIGN|GOVERNMENT|G-?SEC|T-?BILL|TREPS|REPO)\b/.test(rating)) return 'Sovereign / cash';
  const shortTerm = rating.match(/(?:^|[^A-Z0-9])(A1\+|A1|A2\+|A2|A3|A4|P1\+|P1|P2)(?![A-Z0-9+-])/);
  if (shortTerm) return shortTerm[1];
  const longTerm = rating.match(/(?:^|[^A-Z0-9])(AAA|AA\+|AA|AA-|A\+|A|A-|BBB\+|BBB|BBB-|BB\+|BB|BB-|B\+|B|B-)(?![A-Z0-9+-])/);
  return longTerm ? longTerm[1] : null;
}

function normalizedHoldingYield(value) {
  if (!Number.isFinite(value) || value <= 0) return null;
  const normalized = value > 1 ? value / 100 : value;
  return normalized >= 0.001 && normalized <= 0.5 ? normalized : null;
}

const debtPortfolioStats = computed(() => {
  if (!isDebtScheme.value || !holdingPortfolio.value) return null;
  const asOf = new Date(`${holdingPortfolio.value.as_of_date}T00:00:00Z`);
  let yieldWeight = 0;
  let weightedYield = 0;
  let maturityWeight = 0;
  let weightedYears = 0;
  let totalWeight = 0;
  let reportedNetWeight = 0;
  const ratings = new Map();
  for (const holding of holdings.value) {
    if (!Number.isFinite(holding.weight) || isDisclosureSummaryRow(holding) || isDerivativeDisclosureRow(holding)) continue;
    reportedNetWeight += holding.weight;
  }
  for (const holding of usableHoldings.value) {
    totalWeight += holding.weight;
    const holdingYield = normalizedHoldingYield(holding.yield);
    if (holdingYield !== null) {
      weightedYield += holdingYield * holding.weight;
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
    yieldCoverage: totalWeight > 0 ? yieldWeight / totalWeight : 0,
    weightedResidualMaturity: maturityWeight > 0 ? weightedYears / maturityWeight : null,
    reportedNetWeight,
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
function publishedTer(value) {
  // In AMFI's source, zero is used where that plan's TER is not published.
  // A displayed 0.00% would imply a free plan, so surface only positive,
  // plausible annual TER observations.
  return Number.isFinite(value) && value > 0 && value < 10 ? value : null;
}

const selectedTerHistory = computed(() => (fundSnapshot.value.ter || [])
  .map((point) => ({ ...point, value: publishedTer(point.plan_type === 'direct' ? point.direct_ter : point.regular_ter) }))
  .filter((point) => point.value !== null));
const latestTer = computed(() => selectedTerHistory.value.at(-1) || null);
const snapshotPlanLabel = computed(() => selectedTerHistory.value[0]?.plan_type === 'direct' ? 'Direct' : 'Regular');
const latestFactsheet = computed(() => fundSnapshot.value.factsheet || null);
const factsheetManagers = computed(() => latestFactsheet.value?.managers || []);
const officialDebtQuants = computed(() => latestFactsheet.value?.debt_quants || null);
const officialFactsheetRisk = computed(() => {
  const records = latestFactsheet.value?.risk_metrics || [];
  const metric = (field) => records.find((record) => Number.isFinite(Number(record[field])) && record[field] !== null) || null;
  return {
    sharpe: metric('sharpe_ratio'),
    beta: metric('beta'),
    trackingError: metric('tracking_error_percent'),
    upside: metric('upside_capture_percent'),
    downside: metric('downside_capture_percent'),
  };
});

function factsheetRiskValue(record, field, suffix = '', digits = 2) {
  if (!record || record[field] === null || !Number.isFinite(Number(record[field]))) return '—';
  return `${Number(record[field]).toFixed(digits)}${suffix}`;
}

function factsheetRiskSource(record) {
  if (!record) return 'Not stated in the imported factsheet';
  return `${record.metric_window || 'AMC methodology'} · AMC-reported`;
}
const isDebtScheme = computed(() => /^debt scheme\b/i.test(selected.value?.category || ''));
const isDistributionScheme = computed(() => /\b(idcw|dividend|payout|reinvestment|bonus)\b|income distribution/i.test(selected.value?.name || ''));
const debtSnapshot = computed(() => {
  if (!isDebtScheme.value || !selected.value) return null;
  return {
    totalAum: selected.value.total_aum_crore,
    totalAumDate: selected.value.total_aum_date,
    riskometer: selected.value.riskometer_scheme,
    directTer: publishedTer(latestTer.value?.direct_ter),
    regularTer: publishedTer(latestTer.value?.regular_ter),
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

function formatFactsheetMetric(value, suffix = '') {
  return Number.isFinite(value) ? `${value.toFixed(2)}${suffix}` : '—';
}

function buildRollingReturns(years) {
  const points = history.value;
  const results = [];
  for (const end of points) {
    const start = latestPointOnOrBefore(points, subtractCalendarYears(end.date, years));
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
  return history.value.filter((point) => point.date >= subtractPeriod(latestDate, months));
});

const chartPoints = computed(() => {
  const fundPoints = chartHistory.value;
  const benchmarkByDate = new Map((isDistributionScheme.value ? [] : benchmarkHistory.value).map((point) => [point.date, point.value]));
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
    points,
    xPositions: points.map((_, index) => x(index)),
    fundPolyline: points.map((point, index) => `${x(index).toFixed(1)},${y(point.fundValue).toFixed(1)}`).join(' '),
    benchmarkPolyline: comparison ? points.map((point, index) => `${x(index).toFixed(1)},${y(point.benchmarkValue).toFixed(1)}`).join(' ') : null,
    start: points[0], end: points.at(-1),
    endFundY: y(points.at(-1).fundValue),
    endBenchmarkY: comparison ? y(points.at(-1).benchmarkValue) : null,
  };
});

const chartHoverDetails = computed(() => {
  const value = chart.value;
  const index = chartHover.value;
  if (!value || !Number.isInteger(index) || index < 0 || index >= value.points.length) return null;
  const point = value.points[index];
  const x = value.xPositions[index];
  const plotHeight = value.height - value.padding.top - value.padding.bottom;
  const y = (metric) => value.padding.top + ((value.max - metric) / (value.max - value.min || Math.max(value.max * 0.02, 1))) * plotHeight;
  return {
    date: point.date,
    x,
    left: Math.min(84, Math.max(6, (x / value.width) * 100)),
    fundValue: point.fundValue,
    fundY: y(point.fundValue),
    benchmarkValue: value.comparison ? point.benchmarkValue : null,
    benchmarkY: value.comparison ? y(point.benchmarkValue) : null,
  };
});

function updateChartHover(event) {
  const value = chart.value;
  if (!value) return;
  const rect = event.currentTarget.getBoundingClientRect();
  const svgX = ((event.clientX - rect.left) / rect.width) * value.width;
  const plotWidth = value.width - value.padding.left - value.padding.right;
  const index = Math.round(((svgX - value.padding.left) / plotWidth) * (value.points.length - 1));
  chartHover.value = Math.max(0, Math.min(value.points.length - 1, index));
}

async function openScheme(schemeCode) {
  detailLoading.value = true;
  error.value = '';
  holdings.value = [];
  holdingPortfolio.value = null;
  holdingsLoading.value = true;
  fundSnapshot.value = { aaum: [], ter: [], factsheet: null };
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
    if (payload.scheme.category && !/\b(idcw|dividend|payout|reinvestment|bonus)\b|income distribution/i.test(payload.scheme.name)) {
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
  fundSnapshot.value = { aaum: [], ter: [], factsheet: null };
  debtQuartile.value = null;
  categoryPeerHistories.value = {};
}

onMounted(async () => {
  await Promise.all([checkSession(), checkAccessStatus()]);
  if (authenticatedUser.value) {
    await Promise.all([loadSchemes(), loadCategories()]);
    trackUsage('schemes');
  }
  document.documentElement.lang = interfaceLanguage.value === 'gu' ? 'gu' : 'en';
  translateInterface();
  interfaceObserver = new MutationObserver(() => {
    if (!translatingCopy) translateInterface();
  });
  interfaceObserver.observe(document.querySelector('#app'), { childList: true, subtree: true, characterData: true });
});
onBeforeUnmount(() => { clearTimeout(searchTimer); interfaceObserver?.disconnect(); });
watch(view, (section) => trackUsage(section));
watch(interfaceLanguage, () => {
  document.documentElement.lang = interfaceLanguage.value === 'gu' ? 'gu' : 'en';
  requestAnimationFrame(() => translateInterface());
});
</script>

<template>
  <main v-if="!authReady" class="login-shell"><p>Checking secure access…</p></main>
  <main v-else-if="!authenticatedUser" class="login-shell">
    <section class="login-card" aria-label="Sign in">
      <div class="language-switch" aria-label="Choose language"><button type="button" :class="{ active: interfaceLanguage === 'en' }" @click="setInterfaceLanguage('en')">English</button><button type="button" :class="{ active: interfaceLanguage === 'gu' }" @click="setInterfaceLanguage('gu')">ગુજરાતી</button></div>
      <p class="eyebrow"><span class="brand-mark">◆</span> Mutual fund analytics</p>
      <template v-if="authMode === 'sign-in'">
      <h1>From NAV<br><em>to Insights.</em></h1>
      <p>Sign in to open the research workspace.</p>
      <p v-if="accessStatus" :class="['access-status', accessStatus.status]"><template v-if="accessStatus.status === 'pending'">Your sign-up as <strong>@{{ accessStatus.username }}</strong> is pending Super Admin approval.</template><template v-else-if="accessStatus.status === 'approved'">Your access is approved. Sign in using <strong>@{{ accessStatus.username }}</strong>.</template><template v-else>Your access request is currently {{ accessStatus.status }}. Contact the Super Admin if you need help.</template></p>
      <form @submit.prevent="signIn">
        <label for="login-username">Username</label>
        <input id="login-username" v-model="loginUsername" autocomplete="username" required>
        <label for="login-password">Password</label>
        <input id="login-password" v-model="loginPassword" type="password" autocomplete="current-password" required>
        <p v-if="loginError" class="login-error">{{ loginError }}</p>
        <button :disabled="loginLoading" type="submit">{{ loginLoading ? 'Signing in…' : 'Sign in' }}</button>
      </form>
      <button class="text-button" type="button" @click="authMode = 'request'; loginError = ''">New here? Sign up</button>
      </template>
      <template v-else>
      <h1>Create your<br><em>account.</em></h1>
      <p>After sign-up, your account stays pending until the Super Admin approves it.</p>
      <form @submit.prevent="requestAccess">
        <label for="request-full-name">Full name</label>
        <input id="request-full-name" v-model="requestFullName" autocomplete="name" required>
        <label for="request-username">Username</label>
        <input id="request-username" v-model="requestUsername" autocomplete="username" required>
        <label for="request-email">Office email <small>(optional)</small></label>
        <input id="request-email" v-model="requestEmail" type="email" autocomplete="email">
        <label for="request-password">Choose password</label>
        <input id="request-password" v-model="requestPassword" type="password" autocomplete="new-password" minlength="10" required>
        <p v-if="requestError" class="login-error">{{ requestError }}</p>
        <p v-if="requestMessage" class="login-success">{{ requestMessage }}</p>
        <button :disabled="requestLoading" type="submit">{{ requestLoading ? 'Creating...' : 'Sign up' }}</button>
      </form>
      <button class="text-button" type="button" @click="authMode = 'sign-in'; requestError = ''; requestMessage = ''">Back to sign in</button>
      </template>
    </section>
  </main>
  <main v-if="authenticatedUser" class="shell">
    <header>
      <div class="app-header-top"><p class="eyebrow"><span class="brand-mark">◆</span> Mutual fund analytics</p><div class="header-actions"><div class="language-switch compact" aria-label="Choose language"><button type="button" :class="{ active: interfaceLanguage === 'en' }" @click="setInterfaceLanguage('en')">English</button><button type="button" :class="{ active: interfaceLanguage === 'gu' }" @click="setInterfaceLanguage('gu')">ગુજરાતી</button></div><button v-if="authenticatedRole === 'super_admin'" class="sign-out" @click="showAdminPanel">Admin</button><button class="sign-out" @click="signOut">Sign out · {{ authenticatedUser }}</button></div></div>
      <h1>Explore every scheme.<br><em>Start with its NAV.</em></h1>
      <div class="view-switch"><button :class="{ active: view === 'schemes' }" @click="showSchemes">Schemes</button><button :class="{ active: view === 'quartiles' }" @click="showQuartiles">Quartiles</button><button :class="{ active: view === 'peers' }" @click="showPeerAnalysis">Peer analysis</button><button :class="{ active: view === 'overlap' }" @click="showPortfolioOverlap">Portfolio overlap</button><button :class="{ active: view === 'changes' }" @click="showPortfolioChanges">Portfolio changes</button><button :class="{ active: view === 'drivers' }" @click="showNavDrivers">NAV movement analysis</button></div>
    </header>

    <section v-if="view === 'admin' && authenticatedRole === 'super_admin'" class="card admin-panel" aria-label="Access control">
      <div class="compare-intro"><div><p class="eyebrow">Super Admin</p><h2>Access control</h2><p>New accounts stay pending until you approve them. You can suspend approved accounts at any time.</p></div><button :disabled="adminLoading" @click="Promise.all([loadAdminUsers(), loadAdminUsage()])">{{ adminLoading ? 'Refreshing...' : 'Refresh' }}</button></div>
      <p v-if="adminError" class="message error">{{ adminError }}</p>
      <p v-else-if="adminLoading" class="message">Loading access requests...</p>
      <div v-else class="admin-user-list"><article v-for="user in adminUsers" :key="user.user_id"><div><span :class="`user-status ${user.status}`">{{ user.status }}</span><strong>{{ user.full_name }}</strong><small>@{{ user.username }}<template v-if="user.email"> · {{ user.email }}</template> · requested {{ user.requested_at }}</small></div><div class="admin-user-actions"><small v-if="user.role === 'super_admin'">Super Admin</small><template v-else-if="user.status === 'pending'"><button @click="updateUserAccess(user.user_id, 'approve')">Approve</button><button class="secondary-action" @click="updateUserAccess(user.user_id, 'reject')">Reject</button></template><template v-else-if="user.status === 'approved'"><button class="secondary-action" @click="updateUserAccess(user.user_id, 'suspend')">Suspend</button></template></div></article><p v-if="!adminUsers.length" class="message">No access requests yet.</p></div>
      <section class="usage-summary" aria-label="Basic usage log"><div class="change-heading"><div><p class="eyebrow">Usage log</p><h3>Last {{ adminUsage.days }} days</h3></div><p>Basic internal activity<small>No searches, scheme selections, passwords, or IP addresses stored</small></p></div><div class="usage-search"><input v-model="usageSearch" @keyup.enter="loadAdminUsage" placeholder="Search a user by name, username, or email"><button @click="loadAdminUsage">Search</button></div><div class="usage-metrics"><div><span>Active users</span><strong>{{ adminUsage.totals.active_users }}</strong><small>Logged in or opened a section</small></div><div><span>Logins</span><strong>{{ adminUsage.totals.logins }}</strong><small>Successful sign-ins</small></div><div><span>Recorded events</span><strong>{{ adminUsage.totals.events }}</strong><small>Login, logout, or section visit</small></div></div><div class="usage-event-grid"><section v-for="group in [{ key: 'login', label: 'Sign-ins', empty: 'No successful sign-ins.' }, { key: 'logout', label: 'Sign-outs', empty: 'No sign-outs recorded.' }, { key: 'page_view', label: 'Sections opened', empty: 'No section visits recorded.' }]" :key="group.key"><h4>{{ group.label }} <small>{{ adminUsage.events[group.key].length }}</small></h4><div class="usage-list"><div v-for="event in adminUsage.events[group.key]" :key="`${event.created_at}-${event.username}-${event.event_value || ''}`"><span><strong>{{ event.full_name }}</strong><small>@{{ event.username }}</small></span><span><strong>{{ event.event_value ? `Opened ${event.event_value}` : group.label.slice(0, -1) }}</strong><small>{{ event.created_at }}</small></span></div><p v-if="!adminUsage.events[group.key].length" class="message">{{ group.empty }}</p></div></section></div></section>
    </section>

    <section v-else-if="view === 'quartiles' && !selected" class="card category-browser quartile-browser" aria-label="Category quartiles">
      <div class="category-controls">
        <label for="quartile-main-category">Category</label>
        <select id="quartile-main-category" v-model="quartileMainCategory" @change="selectQuartileMainCategory"><option value="">Select a category</option><option v-for="category in quartileMainCategories" :key="category" :value="category">{{ category }}</option></select>
        <label for="quartile-subcategory">Subcategory</label>
        <select id="quartile-subcategory" v-model="quartileCategory" :disabled="!quartileMainCategory" @change="loadQuartiles"><option value="">Select a subcategory</option><option v-for="category in quartileSubcategories" :key="category.label" :value="category.label">{{ category.label }}</option></select>
        <label for="quartile-as-of">As of month</label>
        <input id="quartile-as-of" v-model="quartileAsOf" type="month" :max="latestNavMonth" @change="loadQuartiles">
        <div class="period-buttons" aria-label="Quartile return period"><button v-for="years in [1, 3, 5]" :key="years" type="button" :class="{ active: quartileYears === years }" :disabled="!quartileCategory" @click="setQuartileYears(years)">{{ years }}Y{{ years > 1 ? ' CAGR' : '' }}</button></div>
        <div class="quartile-return-mode" aria-label="Quartile return basis"><span>Return basis</span><div class="period-buttons"><button type="button" :class="{ active: quartileReturnMode === 'net' }" @click="setQuartileReturnMode('net')">Net return</button><button type="button" :class="{ active: quartileReturnMode === 'gross' }" @click="setQuartileReturnMode('gross')">Gross before TER</button></div></div>
      </div>
      <p v-if="error" class="message error">{{ error }}</p>
      <p v-else-if="!quartileCategory" class="message">Choose a category and subcategory to split paired Growth plans into performance quartiles.</p>
      <p v-else-if="quartileLoading" class="message">Loading raw NAV observations…</p>
      <template v-else>
        <button v-if="quartileTables.some((table) => table.rows.length)" class="download-button section-download" @click="downloadQuartiles">Download Excel</button>
        <p class="quartile-note"><template v-if="quartileReturnMode === 'net'">Net return is the investor return calculated directly from published NAV.</template><template v-else>Gross before TER is an estimate reconstructed by adding each plan's applicable daily expense drag back to NAV performance. {{ quartileGrossCoverage.covered }} of {{ quartileGrossCoverage.eligible }} eligible plan records have complete, unambiguous TER coverage; the rest are excluded.</template> All eligible AMCs are ranked and the best 20 representatives are displayed. Q1 holds the top 25% of the displayed set by Direct Growth return where available; Regular Growth is used only when a Direct plan does not exist.</p>
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
      <div class="compare-intro"><div><p class="eyebrow">Comparison workspace</p><h2>Compare up to five schemes</h2><p>Growth-plan returns and benchmark alpha are calculated from aligned source dates in your browser.</p></div><span>{{ compareSelection.length }} / 5 selected</span></div>
      <div class="compare-search"><input v-model="compareSearch" @keyup.enter="searchCompare" placeholder="Search a scheme to add"><button :disabled="compareLoading || compareSearch.trim().length < 2 || compareSelection.length >= 5" @click="searchCompare">{{ compareLoading ? 'Loading…' : 'Add scheme' }}</button></div>
      <p v-if="error" class="message error">{{ error }}</p>
      <div v-if="compareResults.length" class="compare-results"><button v-for="scheme in compareResults" :key="scheme.scheme_code" :disabled="compareSelection.some((item) => item.scheme.scheme_code === scheme.scheme_code) || compareSelection.length >= 5" @click="addToComparison(scheme)"><span><strong>{{ scheme.name }}</strong><small>{{ scheme.amc }} · {{ scheme.category || 'Category not supplied' }}</small></span><span>+ Add</span></button></div>
      <p v-else-if="!compareSelection.length" class="message">Search for the first scheme you would like to compare.</p>
      <button v-if="compareRows.length" class="download-button section-download" @click="downloadSelectedComparison">Download Excel</button>
      <section v-if="compareChart" class="chart-section compare-chart-section" aria-label="Selected-fund NAV growth chart">
        <div class="chart-header"><div><p class="eyebrow">NAV comparison</p><h3>Selected funds growth</h3><p class="chart-caption">All selected funds rebased to 100 on {{ compareChart.startDate }}</p></div><div><div class="range-controls"><button v-for="range in Object.keys(ranges)" :key="range" :class="{ active: compareChartRange === range }" @click="setCompareChartRange(range)">{{ range }}</button></div><div class="chart-legend compare-chart-legend"><span v-for="series in compareChart.series" :key="series.schemeCode"><i :style="{ background: series.color }"></i>{{ series.name }}</span></div></div></div>
        <div class="chart-wrap compare-chart-wrap"><svg class="nav-chart" :viewBox="`0 0 ${compareChart.width} ${compareChart.height}`" role="img" :aria-label="`Selected fund growth from ${compareChart.startDate} to ${compareChart.endDate}`" @pointermove="updateCompareChartHover" @pointerdown="updateCompareChartHover" @pointerleave="compareChartHover = null"><line v-for="fraction in [0, 0.5, 1]" :key="fraction" class="grid-line" :x1="compareChart.padding.left" :x2="compareChart.width - compareChart.padding.right" :y1="compareChart.padding.top + fraction * (compareChart.height - compareChart.padding.top - compareChart.padding.bottom)" :y2="compareChart.padding.top + fraction * (compareChart.height - compareChart.padding.top - compareChart.padding.bottom)" /><text class="axis-label" :x="compareChart.padding.left - 8" :y="compareChart.padding.top + 4" text-anchor="end">{{ compareChart.max.toFixed(1) }}</text><text class="axis-label" :x="compareChart.padding.left - 8" :y="compareChart.height - compareChart.padding.bottom + 4" text-anchor="end">{{ compareChart.min.toFixed(1) }}</text><polyline v-for="series in compareChart.series" :key="series.schemeCode" class="compare-series-line" :style="{ stroke: series.color }" :points="series.polyline" fill="none" /><line v-if="compareChartHoverDetails" class="compare-hover-guide" :x1="compareChartHoverDetails.x" :x2="compareChartHoverDetails.x" :y1="compareChart.padding.top" :y2="compareChart.height - compareChart.padding.bottom" /><circle v-for="series in compareChart.series" :key="`${series.schemeCode}-end`" class="compare-series-endpoint" :style="{ fill: series.color }" :cx="compareChart.width - compareChart.padding.right" :cy="series.endY" r="3.5" /><circle v-for="series in compareChartHoverDetails?.series || []" :key="`${series.schemeCode}-hover`" class="compare-hover-point" :style="{ fill: series.color }" :cx="compareChartHoverDetails.x" :cy="compareChart.padding.top + ((compareChart.max - series.value) / (compareChart.max - compareChart.min || Math.max(compareChart.max * 0.02, 1))) * (compareChart.height - compareChart.padding.top - compareChart.padding.bottom)" r="4" /><text class="axis-label" :x="compareChart.padding.left" :y="compareChart.height - 7">{{ compareChart.startDate }}</text><text class="axis-label" :x="compareChart.width - compareChart.padding.right" :y="compareChart.height - 7" text-anchor="end">{{ compareChart.endDate }}</text></svg><aside v-if="compareChartHoverDetails" class="compare-chart-tooltip" :style="{ left: `${compareChartHoverDetails.left}%` }"><strong>{{ compareChartHoverDetails.date }}</strong><div v-for="series in compareChartHoverDetails.series" :key="series.schemeCode"><span><i :style="{ background: series.color }"></i>{{ series.name }}</span><b>{{ series.value.toFixed(2) }} <small>{{ series.returnSinceStart >= 0 ? '+' : '' }}{{ series.returnSinceStart.toFixed(2) }}%</small></b></div></aside></div>
      </section>
      <div v-if="compareRows.length" class="compare-matrix-wrap"><div class="compare-matrix"><div class="compare-matrix-head"><span>Scheme</span><span>NAV</span><span>Total AUM</span><span>1Y</span><span>3Y CAGR</span><span>5Y CAGR</span><span>1Y alpha</span><span>3Y alpha</span><span>5Y alpha</span><span></span></div><div v-for="row in compareRows" :key="row.scheme.scheme_code" class="compare-matrix-row"><span class="compare-scheme"><strong>{{ row.scheme.name }}</strong><small>{{ row.scheme.amc }} · {{ row.scheme.category || 'Category not supplied' }}</small></span><strong data-label="NAV">{{ formatNav(row.latestNav) }}</strong><strong data-label="Total AUM">{{ row.scheme.total_aum_crore === null || row.scheme.total_aum_crore === undefined ? '—' : `₹${row.scheme.total_aum_crore.toLocaleString('en-IN', { maximumFractionDigits: 0 })} Cr` }}</strong><strong data-label="1Y" :class="{ positive: row.returns.oneYear > 0, negative: row.returns.oneYear < 0 }">{{ row.returns.oneYear === null ? '—' : `${row.returns.oneYear >= 0 ? '+' : ''}${row.returns.oneYear.toFixed(2)}%` }}</strong><strong data-label="3Y CAGR" :class="{ positive: row.returns.threeYear > 0, negative: row.returns.threeYear < 0 }">{{ row.returns.threeYear === null ? '—' : `${row.returns.threeYear >= 0 ? '+' : ''}${row.returns.threeYear.toFixed(2)}%` }}</strong><strong data-label="5Y CAGR" :class="{ positive: row.returns.fiveYear > 0, negative: row.returns.fiveYear < 0 }">{{ row.returns.fiveYear === null ? '—' : `${row.returns.fiveYear >= 0 ? '+' : ''}${row.returns.fiveYear.toFixed(2)}%` }}</strong><strong data-label="1Y alpha" :class="{ positive: row.benchmarkOutperformance.oneYear > 0, negative: row.benchmarkOutperformance.oneYear < 0 }">{{ row.benchmarkOutperformance.oneYear === null ? '—' : `${row.benchmarkOutperformance.oneYear >= 0 ? '+' : ''}${row.benchmarkOutperformance.oneYear.toFixed(2)}%` }}</strong><strong data-label="3Y alpha" :class="{ positive: row.benchmarkOutperformance.threeYear > 0, negative: row.benchmarkOutperformance.threeYear < 0 }">{{ row.benchmarkOutperformance.threeYear === null ? '—' : `${row.benchmarkOutperformance.threeYear >= 0 ? '+' : ''}${row.benchmarkOutperformance.threeYear.toFixed(2)}%` }}</strong><strong data-label="5Y alpha" :class="{ positive: row.benchmarkOutperformance.fiveYear > 0, negative: row.benchmarkOutperformance.fiveYear < 0 }">{{ row.benchmarkOutperformance.fiveYear === null ? '—' : `${row.benchmarkOutperformance.fiveYear >= 0 ? '+' : ''}${row.benchmarkOutperformance.fiveYear.toFixed(2)}%` }}</strong><button class="remove-compare" aria-label="Remove scheme" @click="removeFromComparison(row.scheme.scheme_code)">×</button></div></div></div>
      <p v-if="compareRows.length" class="compare-footnote">Alpha is fund return minus its mapped benchmark return.</p>
    </section>

    <section v-else-if="view === 'peers' && !selected" class="card peer-browser" aria-label="Peer analysis">
      <div class="analysis-mode-switch"><button :class="{ active: analysisMode === 'selected' }" @click="analysisMode = 'selected'">Selected funds</button><button :class="{ active: analysisMode === 'peers' }" @click="analysisMode = 'peers'">Category peers</button></div>
      <div class="compare-intro"><div><p class="eyebrow">Peer analysis</p><h2>Compare a whole category</h2><p>Average every possible holding period, then see which peers beat their benchmark most consistently.</p></div><span>{{ visiblePeerRows.length }} eligible plans</span></div>
      <div class="peer-controls">
        <div><label for="peer-main-category">Category</label><select id="peer-main-category" v-model="peerMainCategory" @change="selectPeerMainCategory"><option value="">Select a category</option><option v-for="category in peerMainCategories" :key="category" :value="category">{{ category }}</option></select></div>
        <div><label for="peer-category">Subcategory</label><select id="peer-category" v-model="peerCategory" :disabled="!peerMainCategory" @change="loadPeerAnalysis"><option value="">Select a subcategory</option><option v-for="category in peerSubcategories" :key="category.label" :value="category.label">{{ category.label }}</option></select></div>
        <div><label for="peer-plan">Plans</label><select id="peer-plan" v-model="peerPlan" :disabled="!peerCategory" @change="loadPeerAnalysis"><option value="direct">Direct Growth</option><option value="regular">Regular Growth</option><option value="all-growth">All Growth plans</option></select></div>
      </div>
      <div class="peer-period"><span>Holding period</span><div class="period-buttons"><button v-for="years in [1, 2, 3, 4, 5]" :key="years" type="button" :class="{ active: peerPeriod === years }" :disabled="!peerRows.length" @click="setPeerPeriod(years)">{{ years }}Y</button></div></div>
      <p v-if="peerBenchmark" class="peer-benchmark">Benchmark: <strong>{{ peerBenchmark.name }}</strong><small>{{ peerBenchmark.mapping_status }} category mapping · calculated in your browser from raw NAV and TRI observations<template v-if="peerBenchmarkMismatchCount"> · {{ peerBenchmarkMismatchCount }} selected-plan records are shown separately because AMFI reports a different benchmark</template></small></p>
      <p v-if="!peerCategory" class="message">Choose a category to analyse its peer funds.</p>
      <p v-else-if="peerLoading" class="message">Loading source histories and calculating rolling peer metrics…</p>
      <p v-else-if="!peerBenchmarkHistoryAvailable" class="message">The mapped benchmark's TRI history is not available from an approved source, so alpha and consistency are not calculated.</p>
      <p v-else-if="!visiblePeerRows.length" class="message">No eligible Growth plans have enough matching NAV and benchmark TRI history for this period.</p>
      <div v-else class="peer-table-wrap"><div class="peer-table"><div class="peer-head"><span>Scheme</span><span>Fund avg</span><span>Benchmark avg</span><button type="button" class="peer-sort" @click="togglePeerSort('alpha')">Alpha {{ peerSort.key === 'alpha' ? (peerSort.direction === 'desc' ? '↓' : '↑') : '↕' }}</button><button type="button" class="peer-sort" @click="togglePeerSort('consistency')">Consistency {{ peerSort.key === 'consistency' ? (peerSort.direction === 'desc' ? '↓' : '↑') : '↕' }}</button></div><button v-for="row in visiblePeerRows" :key="row.scheme_code" class="peer-row" @click="openScheme(row.scheme_code)"><span><strong>{{ row.name }}</strong><small>{{ row.amc }}</small></span><strong data-label="Fund avg" :class="{ positive: row.metrics[peerPeriod].averageFund > 0, negative: row.metrics[peerPeriod].averageFund < 0 }">{{ row.metrics[peerPeriod].averageFund.toFixed(2) }}%</strong><strong data-label="Benchmark avg" :class="{ positive: row.metrics[peerPeriod].averageBenchmark > 0, negative: row.metrics[peerPeriod].averageBenchmark < 0 }">{{ row.metrics[peerPeriod].averageBenchmark.toFixed(2) }}%</strong><strong data-label="Alpha" :class="{ positive: row.metrics[peerPeriod].alpha > 0, negative: row.metrics[peerPeriod].alpha < 0 }">{{ row.metrics[peerPeriod].alpha >= 0 ? '+' : '' }}{{ row.metrics[peerPeriod].alpha.toFixed(2) }}%</strong><strong data-label="Consistency">{{ row.metrics[peerPeriod].consistency.toFixed(1) }}%</strong></button></div></div>
      <section v-if="peerConsistencyTrend" class="peer-consistency-journey" aria-label="Fund consistency journey">
        <div class="peer-journey-heading"><div><p class="eyebrow">Consistency journey</p><h3>How one fund held up over time</h3><p>Share of rolling windows in which the fund beat its mapped benchmark.</p></div><label for="peer-inspected-scheme">Inspect a fund<select id="peer-inspected-scheme" v-model="peerInspectedScheme"><option v-for="row in peerInspectableRows" :key="row.scheme_code" :value="row.scheme_code">{{ row.name }}</option></select></label></div>
        <div class="peer-journey-summary"><div><span>{{ peerConsistencyTrend.interpretation }}</span><strong :class="{ positive: peerConsistencyTrend.change > 0, negative: peerConsistencyTrend.change < 0 }">{{ peerConsistencyTrend.change >= 0 ? '+' : '' }}{{ peerConsistencyTrend.change.toFixed(1) }} pp</strong><small>1Y to latest available holding period</small></div><div><span>Latest consistency</span><strong>{{ peerConsistencyTrend.points.at(-1).metric.consistency.toFixed(1) }}%</strong><small>{{ peerConsistencyTrend.points.at(-1).years }}Y holding period</small></div></div>
        <div class="peer-trend-chart-wrap"><svg class="peer-trend-chart" :viewBox="`0 0 ${peerConsistencyTrend.width} ${peerConsistencyTrend.height}`" role="img" :aria-label="`Consistency trend for ${peerConsistencyTrend.name}`"><line v-for="value in [0, 50, 100]" :key="value" class="grid-line" :x1="peerConsistencyTrend.padding.left" :x2="peerConsistencyTrend.width - peerConsistencyTrend.padding.right" :y1="peerConsistencyTrend.padding.top + ((100 - value) / 100) * (peerConsistencyTrend.height - peerConsistencyTrend.padding.top - peerConsistencyTrend.padding.bottom)" :y2="peerConsistencyTrend.padding.top + ((100 - value) / 100) * (peerConsistencyTrend.height - peerConsistencyTrend.padding.top - peerConsistencyTrend.padding.bottom)" /><text v-for="value in [100, 50, 0]" :key="`axis-${value}`" class="axis-label" :x="peerConsistencyTrend.padding.left - 8" :y="peerConsistencyTrend.padding.top + ((100 - value) / 100) * (peerConsistencyTrend.height - peerConsistencyTrend.padding.top - peerConsistencyTrend.padding.bottom) + 4" text-anchor="end">{{ value }}%</text><polyline class="peer-trend-line" :points="peerConsistencyTrend.polyline" fill="none" /><g v-for="point in peerConsistencyTrend.points" :key="point.years"><circle class="peer-trend-point" :cx="point.x" :cy="point.y" r="4" /><text class="peer-trend-value" :x="point.x" :y="point.y - 10" text-anchor="middle">{{ point.metric.consistency.toFixed(1) }}%</text><text class="axis-label" :x="point.x" :y="peerConsistencyTrend.height - 8" text-anchor="middle">{{ point.years }}Y</text></g></svg></div>
        <div class="peer-journey-values"><div v-for="point in peerConsistencyTrend.points" :key="point.years"><span>{{ point.years }}Y consistency</span><strong>{{ point.metric.consistency.toFixed(1) }}%</strong><small>{{ point.metric.observations.toLocaleString() }} rolling windows</small></div></div>
      </section>
      <section v-if="peerExcludedSchemes.length" class="peer-excluded-section" aria-label="Funds not included in category benchmark comparison">
        <div><p class="eyebrow">Reference only</p><h3>Not included in benchmark comparison</h3><p>These funds are shown for completeness, but their alpha and consistency are not calculated here because they report a different benchmark from the category comparison.</p></div>
        <div class="peer-excluded-list"><article v-for="scheme in peerExcludedSchemes" :key="scheme.scheme_code"><strong>{{ scheme.name }}</strong><small>Reports {{ scheme.reported_benchmark_name }} · category comparison uses {{ peerBenchmark?.name }}</small></article></div>
      </section>
      <button v-if="visiblePeerRows.length" class="download-button section-download" @click="downloadPeerCategory">Download Excel</button>
      <p v-if="visiblePeerRows.length" class="compare-footnote">Each window uses the same available fund NAV and benchmark TRI dates. Alpha means average fund return minus average benchmark return; consistency is the share of windows where the fund beat the benchmark.</p>
    </section>

    <section v-else-if="view === 'overlap' && !selected" class="card overlap-browser" aria-label="Portfolio overlap">
      <div class="compare-intro"><div><p class="eyebrow">Portfolio overlap</p><h2>See what two funds actually own together</h2><p>Compare only verified monthly disclosures. Common holdings are matched by ISIN, not by a fuzzy name match.</p></div><span>{{ overlapSelection.length }} / 2 selected</span></div>
      <div class="compare-search"><input v-model="overlapSearch" @keyup.enter="searchPortfolioOverlap" placeholder="Search a scheme with a portfolio disclosure"><button :disabled="overlapLoading || overlapSearch.trim().length < 2 || overlapSelection.length >= 2" @click="searchPortfolioOverlap">{{ overlapLoading ? 'Loading…' : 'Find scheme' }}</button></div>
      <p v-if="error" class="message error">{{ error }}</p>
      <div v-if="overlapResults.length" class="compare-results"><button v-for="scheme in overlapResults" :key="scheme.scheme_code" :disabled="overlapSelection.some((item) => item.scheme.scheme_code === scheme.scheme_code) || overlapSelection.length >= 2" @click="addToPortfolioOverlap(scheme)"><span><strong>{{ scheme.name }}</strong><small>{{ scheme.amc }} · {{ scheme.category || 'Category not supplied' }}</small></span><span>+ Add</span></button></div>
      <p v-else-if="!overlapSelection.length" class="message">Choose two schemes. A scheme can be compared once its latest monthly disclosure has been imported and mapped.</p>
      <div v-if="overlapSelection.length" class="overlap-selected">
        <article v-for="entry in overlapSelection" :key="entry.scheme.scheme_code"><div><strong>{{ entry.scheme.name }}</strong><small>{{ entry.portfolio.amc }} · disclosure {{ entry.portfolio.as_of_date }}</small></div><button class="remove-compare" :aria-label="`Remove ${entry.scheme.name}`" @click="removeFromPortfolioOverlap(entry.scheme.scheme_code)">×</button></article>
      </div>
      <template v-if="portfolioOverlap">
        <button class="download-button section-download" @click="downloadOverlap">Download Excel</button>
        <div class="overlap-metrics">
          <div><span>Common holding overlap</span><strong>{{ (portfolioOverlap.sharedWeight * 100).toFixed(2) }}%</strong><small>Sum of the lower weight for each shared ISIN</small></div>
          <div><span>Common sector overlap</span><strong>{{ (portfolioOverlap.sharedSectorWeight * 100).toFixed(2) }}%</strong><small>Sum of the lower disclosed sector weight</small></div>
          <div><span>Top-10 concentration</span><strong>{{ (portfolioOverlap.leftTopTen * 100).toFixed(1) }}% / {{ (portfolioOverlap.rightTopTen * 100).toFixed(1) }}%</strong><small>First fund / second fund</small></div>
        </div>
        <div class="overlap-coverage"><span>First fund</span><strong>{{ (portfolioOverlap.leftSharedWeight * 100).toFixed(2) }}% in common holdings</strong><span>Second fund</span><strong>{{ (portfolioOverlap.rightSharedWeight * 100).toFixed(2) }}% in common holdings</strong></div>
        <div class="overlap-list"><div class="overlap-list-head"><span>Common holding</span><span>First fund</span><span>Second fund</span></div><div v-for="holding in portfolioOverlap.commonHoldings" :key="holding.isin" class="overlap-list-row"><span><strong>{{ holding.name }}</strong><small>{{ holding.isin }}</small></span><strong>{{ (holding.leftWeight * 100).toFixed(2) }}%</strong><strong>{{ (holding.rightWeight * 100).toFixed(2) }}%</strong></div><p v-if="!portfolioOverlap.commonHoldings.length" class="message">No common ISINs were found in these two current disclosures.</p></div>
        <div class="fund-top-holdings">
          <section><h3>First fund: Top 10 holdings</h3><div class="holdings-list"><div v-for="holding in portfolioOverlap.leftTopHoldings" :key="`left-${holding.isin}-${holding.instrument_name}`"><span><strong>{{ holding.instrument_name }}</strong><small>{{ holding.isin }}</small></span><b>{{ (holding.weight * 100).toFixed(2) }}%</b></div></div></section>
          <section><h3>Second fund: Top 10 holdings</h3><div class="holdings-list"><div v-for="holding in portfolioOverlap.rightTopHoldings" :key="`right-${holding.isin}-${holding.instrument_name}`"><span><strong>{{ holding.instrument_name }}</strong><small>{{ holding.isin }}</small></span><b>{{ (holding.weight * 100).toFixed(2) }}%</b></div></div></section>
        </div>
        <p class="compare-footnote">Only positive, non-derivative positions with an ISIN are used. The disclosures may have different as-of dates; compare the dates above before drawing a conclusion.</p>
      </template>
    </section>

    <section v-else-if="view === 'changes' && !selected" class="card portfolio-changes" aria-label="Portfolio change tracker">
      <div class="compare-intro"><div><p class="eyebrow">Portfolio change tracker</p><h2>See what a fund manager changed</h2><p>Compare the latest two verified monthly disclosures for a single scheme.</p></div><span v-if="portfolioChangeScheme">{{ portfolioChangeSnapshots.length }} snapshots</span></div>
      <div class="compare-search"><input v-model="portfolioChangeSearch" @keyup.enter="searchPortfolioChanges" placeholder="Search a scheme with portfolio disclosures"><button :disabled="portfolioChangeLoading || portfolioChangeSearch.trim().length < 2" @click="searchPortfolioChanges">{{ portfolioChangeLoading ? 'Loading…' : 'Find scheme' }}</button></div>
      <p v-if="error" class="message error">{{ error }}</p>
      <div v-if="portfolioChangeResults.length" class="compare-results"><button v-for="scheme in portfolioChangeResults" :key="scheme.scheme_code" @click="selectPortfolioChangeScheme(scheme)"><span><strong>{{ scheme.name }}</strong><small>{{ scheme.amc }} · {{ scheme.category || 'Category not supplied' }}</small></span><span>View changes</span></button></div>
      <p v-else-if="!portfolioChangeScheme" class="message">Choose a scheme to inspect how its disclosed portfolio changed month to month.</p>
      <div v-if="portfolioChangeScheme" class="change-selected"><div><strong>{{ portfolioChangeScheme.scheme.name }}</strong><small>{{ portfolioChangeScheme.portfolio.amc }} monthly portfolio disclosure</small></div><button class="remove-compare" :aria-label="`Clear ${portfolioChangeScheme.scheme.name}`" @click="clearPortfolioChangeScheme">×</button></div>
      <p v-if="portfolioChangeScheme && !portfolioChangeLoading && portfolioChangeSnapshots.length < 2" class="message">Only one verified disclosure is available so far. The tracker will activate automatically after the next monthly portfolio refresh.</p>
      <template v-if="portfolioChanges">
        <button class="download-button section-download" @click="downloadPortfolioChanges">Download Excel</button>
        <div class="change-heading"><div><p class="eyebrow">Disclosure comparison</p><h3>{{ portfolioChanges.currentDate }} versus {{ portfolioChanges.previousDate }}</h3></div><p>Latest disclosure<small>Compared with the prior available month</small></p></div>
        <div class="portfolio-change-summary"><div><span>New holdings</span><strong>{{ portfolioChanges.newHoldingCount }}</strong><small>All additions shown below</small></div><div><span>Exited holdings</span><strong>{{ portfolioChanges.exitedHoldingCount }}</strong><small>All exits shown below</small></div><div><span>Top-10 concentration</span><strong :class="{ positive: portfolioChanges.topTenChange < 0, negative: portfolioChanges.topTenChange > 0 }">{{ portfolioChanges.topTenChange >= 0 ? '+' : '' }}{{ (portfolioChanges.topTenChange * 100).toFixed(2) }} pp</strong><small>Change in the largest ten positions</small></div></div>
        <div class="portfolio-change-grid">
          <div><h4>Added</h4><div class="holdings-list"><div v-for="holding in portfolioChanges.additions" :key="`add-${holding.isin}`"><span><strong>{{ holding.instrument_name }}</strong><small><i :class="['holding-type', holdingType(holding).className]">{{ holdingType(holding).label }}</i>{{ holding.isin }}</small></span><b>+{{ (holding.weight * 100).toFixed(2) }}%</b></div><p v-if="!portfolioChanges.additions.length" class="holdings-message">No new ISINs.</p></div></div>
          <div><h4>Exited</h4><div class="holdings-list"><div v-for="holding in portfolioChanges.exits" :key="`exit-${holding.isin}`"><span><strong>{{ holding.instrument_name }}</strong><small><i :class="['holding-type', holdingType(holding).className]">{{ holdingType(holding).label }}</i>{{ holding.isin }}</small></span><b class="negative">−{{ (holding.weight * 100).toFixed(2) }}%</b></div><p v-if="!portfolioChanges.exits.length" class="holdings-message">No exited ISINs.</p></div></div>
          <div><h4>Largest weight changes</h4><div class="holdings-list"><div v-for="holding in [...portfolioChanges.increases, ...portfolioChanges.reductions].sort((left, right) => Math.abs(right.change) - Math.abs(left.change)).slice(0, 5)" :key="`move-${holding.isin}`"><span><strong>{{ holding.instrument_name }}</strong><small><i :class="['holding-type', holdingType(holding).className]">{{ holdingType(holding).label }}</i>{{ holding.previousWeight ? `${(holding.previousWeight * 100).toFixed(2)}% to ${(holding.weight * 100).toFixed(2)}%` : holding.isin }}</small></span><b :class="{ positive: holding.change > 0, negative: holding.change < 0 }">{{ holding.change >= 0 ? '+' : '' }}{{ (holding.change * 100).toFixed(2) }} pp</b></div><p v-if="!portfolioChanges.increases.length && !portfolioChanges.reductions.length" class="holdings-message">No material weight changes.</p></div></div>
          <div><h4>Largest sector shifts</h4><div class="holdings-list"><div v-for="sector in portfolioChanges.sectorChanges" :key="sector.name"><span><strong>{{ sector.name }}</strong><small>{{ (sector.previousWeight * 100).toFixed(2) }}% to {{ (sector.currentWeight * 100).toFixed(2) }}%</small></span><b :class="{ positive: sector.change > 0, negative: sector.change < 0 }">{{ sector.change >= 0 ? '+' : '' }}{{ (sector.change * 100).toFixed(2) }} pp</b></div><p v-if="!portfolioChanges.sectorChanges.length" class="holdings-message">No disclosed sector shifts.</p></div></div>
        </div>
        <p class="holdings-note">Changes use positive, non-derivative positions with an ISIN. Sector shifts use disclosed sector labels and may be unavailable for debt or non-equity holdings.</p>
      </template>
    </section>

    <section v-else-if="view === 'drivers' && !selected" class="card portfolio-changes" aria-label="NAV movement analysis">
      <div class="compare-intro"><div><p class="eyebrow">NAV movement analysis</p><h2>What likely moved the fund today</h2><p>Uses the latest disclosed portfolio and official NSE closing prices; this is an estimate, not AMC attribution.</p></div><span v-if="navDrivers">{{ navDrivers.date }}</span></div>
      <div class="compare-search"><input v-model="navDriverSearch" @keyup.enter="searchNavDrivers" placeholder="Search an equity scheme"><button :disabled="navDriverLoading || navDriverSearch.trim().length < 2" @click="searchNavDrivers">{{ navDriverLoading ? 'Loading…' : 'Find scheme' }}</button></div>
      <p v-if="error" class="message error">{{ error }}</p><div v-if="navDriverResults.length" class="compare-results"><button v-for="scheme in navDriverResults" :key="scheme.scheme_code" @click="selectNavDriverScheme(scheme)"><span><strong>{{ scheme.name }}</strong><small>{{ scheme.amc }} · {{ scheme.category || 'Category not supplied' }}</small></span><span>Analyse</span></button></div>
      <p v-else-if="!navDrivers" class="message">Choose a scheme with a mapped equity portfolio and NSE price coverage.</p>
      <template v-if="navDrivers">
        <button class="download-button section-download" @click="downloadNavDrivers">Download Excel</button>
        <div class="change-selected"><div><strong>{{ navDrivers.scheme.name }}</strong><small>Portfolio disclosed {{ navDrivers.portfolio.as_of_date }} · NSE close {{ navDrivers.date }}</small></div><button class="remove-compare" @click="navDriverData = null">×</button></div>
        <section class="nav-driver-story" aria-label="NAV movement summary">
          <p class="eyebrow">In plain English</p>
          <p>{{ navDriverExplanation }}</p>
          <div><strong>How the estimate works</strong><span>Fund weight × one-day stock return = estimated impact on the fund NAV.</span></div>
        </section>
        <div class="portfolio-change-summary"><div><span>Actual NAV move</span><strong :class="{ positive: navDrivers.actual > 0, negative: navDrivers.actual < 0 }">{{ navDrivers.actual >= 0 ? '+' : '' }}{{ navDrivers.actual.toFixed(2) }}%</strong><small>{{ navDrivers.previous_nav.date }} to {{ navDrivers.date }}</small></div><div><span>Estimated holdings move</span><strong :class="{ positive: navDrivers.estimated > 0, negative: navDrivers.estimated < 0 }">{{ navDrivers.estimated >= 0 ? '+' : '' }}{{ navDrivers.estimated.toFixed(2) }}%</strong><small>{{ navDrivers.coverage.toFixed(1) }}% disclosed-weight coverage</small></div><div><span>Residual</span><strong :class="{ positive: navDrivers.residual > 0, negative: navDrivers.residual < 0 }">{{ navDrivers.residual >= 0 ? '+' : '' }}{{ navDrivers.residual.toFixed(2) }}%</strong><small>Actual NAV move minus the holdings estimate</small></div></div>
        <p class="nav-driver-reconciliation">A small residual means the disclosed priced holdings broadly explain the day. It will not be exactly zero because the fund may hold cash, debt, derivatives or unpriced positions, may trade after the disclosure date, and NAV also reflects daily expenses.</p>
        <div class="nav-driver-grid">
          <section><h4>Top positive drivers</h4><div class="nav-driver-table"><div class="nav-driver-head"><span>Holding</span><span>Weight</span><span>Price move</span><span>Stock return</span><span>NAV impact</span></div><div v-for="row in navDrivers.positive" :key="`positive-${row.isin}`" class="nav-driver-row"><span><strong>{{ row.instrument_name }}</strong><small>{{ row.symbol || row.isin }}</small></span><strong>{{ (row.weight * 100).toFixed(2) }}%</strong><strong>₹{{ row.previous_close_price.toFixed(2) }} → ₹{{ row.close_price.toFixed(2) }}</strong><strong class="positive">+{{ row.stockReturn.toFixed(2) }}%</strong><strong class="positive">+{{ row.contribution.toFixed(3) }} pp</strong></div><p v-if="!navDrivers.positive.length" class="holdings-message">No priced positive contributors for this date.</p></div></section>
          <section><h4>Top negative drivers</h4><div class="nav-driver-table"><div class="nav-driver-head"><span>Holding</span><span>Weight</span><span>Price move</span><span>Stock return</span><span>NAV impact</span></div><div v-for="row in navDrivers.negative" :key="`negative-${row.isin}`" class="nav-driver-row"><span><strong>{{ row.instrument_name }}</strong><small>{{ row.symbol || row.isin }}</small></span><strong>{{ (row.weight * 100).toFixed(2) }}%</strong><strong>₹{{ row.previous_close_price.toFixed(2) }} → ₹{{ row.close_price.toFixed(2) }}</strong><strong class="negative">{{ row.stockReturn.toFixed(2) }}%</strong><strong class="negative">{{ row.contribution.toFixed(3) }} pp</strong></div><p v-if="!navDrivers.negative.length" class="holdings-message">No priced negative contributors for this date.</p></div></section>
        </div>
        <p class="holdings-note">This is a daily, holdings-based estimate—not an official AMC attribution. It uses the latest portfolio disclosure available before the NAV date and official NSE closing prices only for mapped equity holdings.</p>
        <section v-if="marketSectorPulse" class="market-sector-pulse" aria-label="Overall market sector pulse">
          <div class="change-heading"><div><p class="eyebrow">Market sector pulse</p><h3>How the overall market’s sectors moved</h3></div><p>NSE closing report<small>{{ marketSectorPulse.date }}</small></p></div>
          <p>These are the daily moves of broad NSE sector indices, independent of this fund. They provide the market backdrop for the holdings analysis above.</p>
          <div class="market-sector-grid"><article v-for="sector in marketSectorPulse.sectors" :key="sector.index_name" :class="{ positive: sector.percent_change > 0, negative: sector.percent_change < 0 }"><strong>{{ sector.index_name }}</strong><span>{{ sector.percent_change >= 0 ? '+' : '' }}{{ sector.percent_change.toFixed(2) }}%</span><small>{{ sector.points_change >= 0 ? '+' : '' }}{{ sector.points_change.toFixed(2) }} points · close {{ sector.close_value.toLocaleString('en-IN', { maximumFractionDigits: 2 }) }}</small></article></div>
          <p class="nav-sector-news-note"><strong>Read the market context below.</strong> Headlines are useful context, not a proven cause of a sector or fund move.</p>
        </section>
        <section v-if="marketSectorNews" class="market-sector-news" aria-label="Sector news context">
          <div class="change-heading"><div><p class="eyebrow">Market context</p><h3>What was being discussed around the day’s biggest sector moves</h3></div><p>Headline context<small>{{ marketSectorNews.date }}</small></p></div>
          <p>These headlines provide context for the strongest and weakest sectors. They do not prove the reason for a sector move or this fund’s NAV change.</p>
          <div class="market-news-grid"><article v-for="sector in marketSectorNews.sectors" :key="sector.index_name"><header><strong>{{ sector.index_name }}</strong><span :class="{ positive: sector.percent_change > 0, negative: sector.percent_change < 0 }">{{ sector.percent_change >= 0 ? '+' : '' }}{{ sector.percent_change.toFixed(2) }}%</span></header><a v-for="article in sector.articles" :key="article.url" :href="article.url" target="_blank" rel="noreferrer"><strong>{{ article.title }}</strong><small>{{ article.publisher }} · {{ article.published_at }}</small></a><p v-if="!sector.articles.length">No dated sector-specific headline was available from the news feed.</p></article></div>
        </section>
      </template>
    </section>

    <section v-else-if="selected" class="detail card" aria-label="Scheme detail">
      <button class="download-button detail-download" @click="downloadSchemeDetail">Download Excel</button>
      <button class="back" @click="closeDetail">← All schemes</button>
      <div class="detail-heading">
        <div><p class="eyebrow">{{ selected.category || selected.amc || 'AMFI scheme' }} · {{ selected.scheme_code }}</p><h2>{{ selected.name }}</h2><p class="scheme-category">{{ selected.amc }}<template v-if="selected.category"> · {{ selected.category }}</template></p><p v-if="selected.benchmark_name" class="benchmark-note"><span>Reference benchmark</span>{{ selected.benchmark_name }} <em>{{ selected.benchmark_mapping_status }}</em></p></div>
        <div class="nav"><strong>{{ formatNav(selected.latest_nav) }}</strong><span>NAV · {{ selected.latest_nav_date }}</span></div>
      </div>
      <section v-if="fundSnapshotLoading || latestAaum || latestTer || latestFactsheet || holdingPortfolio" class="fund-snapshot" aria-label="Fund snapshot">
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
      <section v-if="latestFactsheet" class="fund-snapshot factsheet-section" aria-label="Fund management and exit load">
        <div class="snapshot-heading"><div><p class="eyebrow">AMC factsheet</p><h3>Fund management & exit load</h3></div><p>{{ latestFactsheet.as_of_date }}<small>Official {{ latestFactsheet.source_amc }} disclosure</small></p></div>
        <div class="factsheet-grid">
          <div class="factsheet-exit-load"><span>Exit load</span><strong>{{ latestFactsheet.exit_load_text || 'Not stated in the imported factsheet' }}</strong><small>Always check the current scheme information document before transacting.</small></div>
          <div class="factsheet-managers"><span>Fund manager{{ factsheetManagers.length === 1 ? '' : 's' }}</span><div v-if="factsheetManagers.length" class="manager-list"><div v-for="manager in factsheetManagers" :key="manager.manager_name"><strong>{{ manager.manager_name }}</strong><small>{{ [manager.managing_since ? `Managing this fund since ${manager.managing_since}` : null, Number.isFinite(manager.experience_years) ? `${manager.experience_years.toFixed(1)} years managing funds` : null].filter(Boolean).join(' · ') || 'Details not stated' }}</small></div></div><strong v-else>Not stated</strong><small v-if="!factsheetManagers.length">No manager record was found in this factsheet.</small></div>
        </div>
        <p class="snapshot-note">The details above are reported by the AMC, plan-linked to the scheme, and retained with their factsheet date.</p>
      </section>
      <section v-if="!isDistributionScheme" class="returns" aria-label="Point-to-point returns">
        <div class="returns-heading"><div><p class="eyebrow">Return snapshot</p><h3>Point-to-point returns</h3></div><p>Latest NAV date<small>{{ selected.latest_nav_date }}</small></p></div>
        <div v-for="period in returnPeriods" :key="period.label" class="return-item">
          <span>{{ period.label }}<small v-if="period.annualised">annualised</small></span><strong :class="{ positive: period.value > 0, negative: period.value < 0 }">{{ period.value === null ? '—' : `${period.value >= 0 ? '+' : ''}${period.value.toFixed(2)}%` }}</strong>
        </div>
      </section>
      <section v-else class="returns comparison-unavailable" aria-label="IDCW return availability">
        <div class="returns-heading"><div><p class="eyebrow">Return snapshot</p><h3>Total return unavailable</h3></div></div>
        <p class="benchmark-unavailable">An IDCW plan’s NAV falls when cash is distributed. Correct investor returns require the complete distribution cash-flow history, so NAV change alone is not presented as return.</p>
      </section>
      <section v-if="benchmarkComparison" class="comparison-section" aria-label="Fund versus benchmark comparison">
        <div class="comparison-heading"><div><p class="eyebrow">Fund vs benchmark</p><h3>{{ selected.benchmark_name }}</h3></div><p>Aligned to {{ benchmarkComparison.asOf }}<small>{{ selected.benchmark_mapping_status }}</small></p></div>
        <div class="comparison-table">
          <div class="comparison-row comparison-labels"><span>Period</span><span>Fund</span><span>Benchmark</span><span>Outperformance</span></div>
          <div v-for="period in benchmarkComparison.periods" :key="period.label" class="comparison-row"><span>{{ period.label }}<small v-if="period.annualised">CAGR</small></span><strong :class="{ positive: period.fund > 0, negative: period.fund < 0 }">{{ period.fund === null ? '—' : `${period.fund >= 0 ? '+' : ''}${period.fund.toFixed(2)}%` }}</strong><strong :class="{ positive: period.benchmark > 0, negative: period.benchmark < 0 }">{{ period.benchmark === null ? '—' : `${period.benchmark >= 0 ? '+' : ''}${period.benchmark.toFixed(2)}%` }}</strong><strong :class="{ positive: period.outperformance > 0, negative: period.outperformance < 0 }">{{ period.outperformance === null ? '—' : `${period.outperformance >= 0 ? '+' : ''}${period.outperformance.toFixed(2)}%` }}</strong></div>
        </div>
        <p class="comparison-note">Fund NAV and benchmark TRI are source observations; all returns and outperformance are calculated in your browser.</p>
      </section>
      <section v-else class="comparison-section comparison-unavailable" aria-label="Fund versus benchmark availability">
        <div class="comparison-heading"><div><p class="eyebrow">Fund vs benchmark</p><h3>Benchmark comparison</h3></div></div>
        <p class="benchmark-unavailable">{{ isDistributionScheme ? 'Benchmark outperformance is not calculated for IDCW plans until distribution cash flows are available.' : selected.benchmark_mapping_status === 'AMFI reported; TRI unavailable' ? `AMFI reports ${selected.benchmark_name} for this scheme, but its TRI history is not available from an approved source. A different category index is not substituted.` : selected.benchmark_name ? `${selected.benchmark_name} is mapped as a ${selected.benchmark_mapping_status} category default, but its TRI history is not available from the approved source.` : 'No category-wide benchmark is assigned to this scheme. Sectoral and thematic funds need their individually stated benchmark; a broad-market substitute would be misleading.' }}</p>
      </section>
      <section v-if="riskMetrics" class="risk-section" aria-label="Risk and resilience analysis">
        <div class="risk-heading"><div><p class="eyebrow">Risk & resilience</p><h3>How the fund behaved on the way</h3></div><div class="range-controls"><button v-for="years in [1, 3, 5]" :key="years" :class="{ active: riskYears === years }" @click="riskYears = years">{{ years }}Y</button></div></div>
        <div class="risk-grid">
          <div><span>Maximum drawdown</span><strong class="negative">{{ riskMetrics.fundDrawdown === null ? '—' : `${riskMetrics.fundDrawdown.toFixed(2)}%` }}</strong><small>Fund’s largest fall from a prior peak</small></div>
          <div><span>Benchmark drawdown</span><strong class="negative">{{ riskMetrics.benchmarkDrawdown === null ? '—' : `${riskMetrics.benchmarkDrawdown.toFixed(2)}%` }}</strong><small>On the same aligned date range</small></div>
          <div><span>Annualised volatility</span><strong>{{ riskMetrics.annualVolatility.toFixed(2) }}%</strong><small>How much the fund’s daily returns moved</small></div>
          <div><span>Sharpe ratio</span><strong :class="{ positive: officialFactsheetRisk.sharpe && Number(officialFactsheetRisk.sharpe.sharpe_ratio) > 0, negative: officialFactsheetRisk.sharpe && Number(officialFactsheetRisk.sharpe.sharpe_ratio) < 0 }">{{ factsheetRiskValue(officialFactsheetRisk.sharpe, 'sharpe_ratio') }}</strong><small>{{ factsheetRiskSource(officialFactsheetRisk.sharpe) }}</small></div>
          <div><span>Beta</span><strong>{{ factsheetRiskValue(officialFactsheetRisk.beta, 'beta') }}</strong><small>{{ factsheetRiskSource(officialFactsheetRisk.beta) }}</small></div>
          <div><span>Tracking error</span><strong>{{ factsheetRiskValue(officialFactsheetRisk.trackingError, 'tracking_error_percent', '%') }}</strong><small>{{ factsheetRiskSource(officialFactsheetRisk.trackingError) }}</small></div>
          <div><span>Upside capture</span><strong :class="{ positive: officialFactsheetRisk.upside && Number(officialFactsheetRisk.upside.upside_capture_percent) > 100 }">{{ factsheetRiskValue(officialFactsheetRisk.upside, 'upside_capture_percent', '%', 0) }}</strong><small>{{ factsheetRiskSource(officialFactsheetRisk.upside) }}</small></div>
          <div><span>Downside capture</span><strong :class="{ positive: officialFactsheetRisk.downside && Number(officialFactsheetRisk.downside.downside_capture_percent) < 100, negative: officialFactsheetRisk.downside && Number(officialFactsheetRisk.downside.downside_capture_percent) > 100 }">{{ factsheetRiskValue(officialFactsheetRisk.downside, 'downside_capture_percent', '%', 0) }}</strong><small>{{ factsheetRiskSource(officialFactsheetRisk.downside) }}</small></div>
          <div><span>Category upside capture</span><strong :class="{ positive: categoryCapture?.upside > 100 }">{{ categoryCaptureLoading ? '…' : categoryCapture?.upside === null || !categoryCapture ? '—' : `${categoryCapture.upside.toFixed(0)}%` }}</strong><small>Versus same-category {{ selectedCategoryPlan(selected.name).includes('direct') ? 'Direct' : 'Regular' }} peers</small></div>
          <div><span>Category downside capture</span><strong :class="{ positive: categoryCapture?.downside < 100, negative: categoryCapture?.downside > 100 }">{{ categoryCaptureLoading ? '…' : categoryCapture?.downside === null || !categoryCapture ? '—' : `${categoryCapture.downside.toFixed(0)}%` }}</strong><small>Below 100% means less of the category fall</small></div>
        </div>
        <p class="risk-note">{{ riskMetrics.observations.toLocaleString() }} daily NAV observations. Drawdown, annualised volatility and category capture are calculated from stored NAV history. Sharpe, beta, tracking error and benchmark capture are shown only when the AMC has reported them in an imported factsheet.</p>
      </section>
      <section v-else class="risk-section risk-unavailable" aria-label="Risk and resilience availability">
        <div class="risk-heading"><div><p class="eyebrow">Risk & resilience</p><h3>How the fund behaved on the way</h3></div></div>
        <p class="benchmark-unavailable">{{ isDistributionScheme ? 'Return-based risk measures are not calculated for IDCW plans until distribution cash flows are available.' : 'Risk measures versus a benchmark need matched daily fund NAV and benchmark TRI observations. They will appear once an approved benchmark TRI series is available for this scheme.' }}</p>
      </section>
      <section v-if="debtSnapshot" class="fund-snapshot debt-snapshot" aria-label="Debt fund snapshot">
        <div class="snapshot-heading"><div><p class="eyebrow">Debt snapshot</p><h3>Rate, credit & cost view</h3></div><p>Current source data<small>Latest mapped portfolio disclosure</small></p></div>
        <div class="snapshot-grid debt-snapshot-grid">
          <div><span>Total AUM</span><strong>{{ formatTotalAum(debtSnapshot.totalAum) }}</strong><small>{{ debtSnapshot.totalAumDate ? `AMFI as of ${debtSnapshot.totalAumDate}` : 'No AMFI Total AUM linked yet' }}</small></div>
          <div><span>SEBI Risk-o-meter</span><strong>{{ debtSnapshot.riskometer || '—' }}</strong><small>{{ debtSnapshot.riskometer ? 'Latest AMFI scheme disclosure' : 'No AMFI risk label linked yet' }}</small></div>
          <div><span>Direct TER</span><strong>{{ debtSnapshot.directTer === null ? '—' : `${debtSnapshot.directTer.toFixed(2)}%` }}</strong><small>Latest AMFI daily disclosure</small></div>
          <div><span>Regular TER</span><strong>{{ debtSnapshot.regularTer === null ? '—' : `${debtSnapshot.regularTer.toFixed(2)}%` }}</strong><small>Latest AMFI daily disclosure</small></div>
          <div><span>1Y category quartile</span><strong>{{ debtQuartileLoading ? '…' : debtSnapshot.quartile ? `Q${debtSnapshot.quartile.value}` : '—' }}</strong><small>{{ debtSnapshot.quartile ? `Rank ${debtSnapshot.quartile.rank} of ${debtSnapshot.quartile.total} same-plan peers` : 'Direct/Regular Growth peers only' }}</small></div>
          <div><span>1Y volatility</span><strong>{{ debtOneYearRisk ? `${debtOneYearRisk.annualVolatility.toFixed(2)}%` : '—' }}</strong><small>Annualised daily NAV volatility</small></div>
          <div><span>1Y Sharpe</span><strong :class="{ positive: debtOneYearRisk?.sharpe > 0, negative: debtOneYearRisk?.sharpe < 0 }">{{ debtOneYearRisk?.sharpe === null || !debtOneYearRisk ? '—' : debtOneYearRisk.sharpe.toFixed(2) }}</strong><small>Uses the RBI Repo Rate baseline</small></div>
        </div>
        <p class="snapshot-note">Holding-level yield, residual maturity and credit quality are calculated below when a mapped monthly portfolio disclosure is available.</p>
      </section>
      <section v-if="isDebtScheme && officialDebtQuants" class="fund-snapshot debt-snapshot official-debt-quants" aria-label="Official debt quants">
        <div class="snapshot-heading"><div><p class="eyebrow">AMC factsheet</p><h3>Official debt quants</h3></div><p>{{ latestFactsheet.as_of_date }}<small>Reported by {{ latestFactsheet.source_amc }}</small></p></div>
        <div class="snapshot-grid debt-snapshot-grid">
          <div><span>Modified duration</span><strong>{{ formatFactsheetMetric(officialDebtQuants.modified_duration_years, ' years') }}</strong><small>Interest-rate sensitivity</small></div>
          <div><span>{{ officialDebtQuants.residual_maturity_years === null ? 'Average maturity' : 'Residual maturity' }}</span><strong>{{ formatFactsheetMetric(officialDebtQuants.residual_maturity_years ?? officialDebtQuants.average_maturity_years, ' years') }}</strong><small>{{ officialDebtQuants.residual_maturity_years === null ? 'Average time until securities mature' : 'Weighted time remaining to maturity' }}</small></div>
          <div><span>Yield to maturity</span><strong>{{ formatFactsheetMetric(officialDebtQuants.yield_to_maturity_percent, '%') }}</strong><small>Portfolio yield reported by the AMC</small></div>
          <div><span>Macaulay duration</span><strong>{{ formatFactsheetMetric(officialDebtQuants.macaulay_duration_years, ' years') }}</strong><small>Weighted time to receive cash flows</small></div>
          <div><span>Standard deviation</span><strong>{{ formatFactsheetMetric(officialDebtQuants.standard_deviation_percent, '%') }}</strong><small>AMC-reported volatility measure</small></div>
        </div>
        <p class="snapshot-note">These are factsheet values, not estimates from the holdings table. Their calculation methodology is the AMC’s published methodology.</p>
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
          <div class="holdings-grid">
            <div><h4>Top 10 holdings</h4><div class="holdings-list"><div v-for="holding in topHoldings" :key="`${holding.isin}-${holding.instrument_name}`"><span><strong>{{ holding.instrument_name }}</strong><small>{{ holding.industry_or_rating || holding.asset_class || 'Portfolio holding' }}</small></span><b>{{ (holding.weight * 100).toFixed(2) }}%</b></div></div></div>
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
          <div v-if="chart" class="chart-wrap interactive-chart-wrap">
            <svg class="nav-chart" :viewBox="`0 0 ${chart.width} ${chart.height}`" role="img" :aria-label="chart.comparison ? `Fund and benchmark growth from ${chart.start.date} to ${chart.end.date}` : `NAV history from ${chart.start.date} to ${chart.end.date}`" @pointermove="updateChartHover" @pointerdown="updateChartHover" @pointerleave="chartHover = null">
              <line v-for="fraction in [0, 0.5, 1]" :key="fraction" class="grid-line" :x1="chart.padding.left" :x2="chart.width - chart.padding.right" :y1="chart.padding.top + fraction * (chart.height - chart.padding.top - chart.padding.bottom)" :y2="chart.padding.top + fraction * (chart.height - chart.padding.top - chart.padding.bottom)" />
              <text class="axis-label" :x="chart.padding.left - 8" :y="chart.padding.top + 4" text-anchor="end">{{ chart.comparison ? chart.max.toFixed(1) : formatNav(chart.max) }}</text>
              <text class="axis-label" :x="chart.padding.left - 8" :y="chart.height - chart.padding.bottom + 4" text-anchor="end">{{ chart.comparison ? chart.min.toFixed(1) : formatNav(chart.min) }}</text>
              <polyline v-if="chart.benchmarkPolyline" class="benchmark-line" :points="chart.benchmarkPolyline" fill="none" />
              <polyline class="nav-line" :points="chart.fundPolyline" fill="none" />
              <line v-if="chartHoverDetails" class="compare-hover-guide" :x1="chartHoverDetails.x" :x2="chartHoverDetails.x" :y1="chart.padding.top" :y2="chart.height - chart.padding.bottom" />
              <circle v-if="chartHoverDetails" class="compare-hover-point" :cx="chartHoverDetails.x" :cy="chartHoverDetails.fundY" r="4" />
              <circle v-if="chartHoverDetails && chartHoverDetails.benchmarkY !== null" class="benchmark-hover-point" :cx="chartHoverDetails.x" :cy="chartHoverDetails.benchmarkY" r="4" />
              <circle class="endpoint" :cx="chart.width - chart.padding.right" :cy="chart.endFundY" r="4" />
              <circle v-if="chart.endBenchmarkY !== null" class="benchmark-endpoint" :cx="chart.width - chart.padding.right" :cy="chart.endBenchmarkY" r="3.5" />
              <text class="axis-label" :x="chart.padding.left" :y="chart.height - 7">{{ chart.start.date }}</text>
              <text class="axis-label" :x="chart.width - chart.padding.right" :y="chart.height - 7" text-anchor="end">{{ chart.end.date }}</text>
            </svg>
            <aside v-if="chartHoverDetails" class="compare-chart-tooltip scheme-chart-tooltip" :style="{ left: `${chartHoverDetails.left}%` }">
              <strong>{{ chartHoverDetails.date }}</strong>
              <template v-if="chart.comparison">
                <div><span><i class="fund-swatch"></i>Fund</span><b>{{ chartHoverDetails.fundValue.toFixed(2) }}</b></div>
                <div><span><i class="benchmark-swatch"></i>{{ selected.benchmark_name }}</span><b>{{ chartHoverDetails.benchmarkValue.toFixed(2) }}</b></div>
                <div class="chart-tooltip-gap"><span>Fund lead</span><b :class="{ positive: chartHoverDetails.fundValue - chartHoverDetails.benchmarkValue > 0, negative: chartHoverDetails.fundValue - chartHoverDetails.benchmarkValue < 0 }">{{ chartHoverDetails.fundValue - chartHoverDetails.benchmarkValue >= 0 ? '+' : '' }}{{ (chartHoverDetails.fundValue - chartHoverDetails.benchmarkValue).toFixed(2) }} pts</b></div>
              </template>
              <div v-else><span><i class="fund-swatch"></i>NAV</span><b>{{ formatNav(chartHoverDetails.fundValue) }}</b></div>
            </aside>
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
          <label><span>Plan</span><select v-model="schemePlan" :disabled="loading" @change="updateSchemeFilter"><option value="all">All plans</option><option value="direct">Direct Growth</option><option value="regular">Regular Growth</option><option value="idcw">IDCW</option></select></label>
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
