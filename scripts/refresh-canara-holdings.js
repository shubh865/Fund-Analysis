const XLSX = require('xlsx');
const db = require('../server/db');

const AMC = 'Canara Robeco Mutual Fund';
const SOURCE_PAGE = 'https://www.canararobeco.com/documents/statutory-disclosures/scheme-dashboard/scheme-monthly-portfolio/';
const FETCH_OPTIONS = { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FundAnalytics/1.0)', Referer: SOURCE_PAGE } };

function targetMonth() { const d = new Date(); d.setDate(0); return { year: d.getFullYear(), month: String(d.getMonth() + 1).padStart(2, '0') }; }
function text(value) { return value == null ? '' : String(value).replace(/\s+/g, ' ').trim(); }
function number(value) { const parsed = typeof value === 'number' ? value : Number(text(value).replace(/,/g, '').replace(/%$/, '')); return Number.isFinite(parsed) ? parsed : null; }
function dateFromText(value) { const m=text(value).match(/([A-Z][a-z]+)\s+(\d{1,2}),\s+(\d{4})/i); if(!m)return null; const d=new Date(`${m[1]} ${m[2]}, ${m[3]} UTC`); return Number.isNaN(d.getTime())?null:d.toISOString().slice(0,10); }
function family(name) { return text(name).toUpperCase().split('(')[0].replace(/\b(CANARA|ROBECO|DIRECT|REGULAR|PLAN|GROWTH|OPTION|IDCW|DIVIDEND|REINVESTMENT|FUND)\b/g,' ').replace(/[^A-Z0-9]+/g,' ').replace(/\s+/g,' ').trim(); }
function isTotal(value) { return /^(sub\s*total|total|grand\s*total|net current assets|total net assets)/i.test(value); }
function isSection(value) { return /^(equity|debt|money market|derivatives|units of|cash|other current assets|foreign securities|government bonds|treasury bill|commercial paper|certificate of deposit|corporate debt|mutual fund units|repo)/i.test(value); }

const portfolioUpsert=db.prepare(`INSERT INTO holding_portfolios(amc,source_fund_code,name,description)VALUES(?,?,?,?) ON CONFLICT(amc,source_fund_code)DO UPDATE SET name=excluded.name,description=excluded.description`);
const portfolioFind=db.prepare('SELECT portfolio_id FROM holding_portfolios WHERE amc=? AND source_fund_code=?');
const deletePositions=db.prepare('DELETE FROM portfolio_holdings WHERE portfolio_id=? AND as_of_date=?');
const positionInsert=db.prepare(`INSERT INTO portfolio_holdings(portfolio_id,as_of_date,position_order,asset_class,holding_group,instrument_name,isin,industry_or_rating,quantity,market_value_lakh,weight,yield,yield_to_call)VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`);
const importUpsert=db.prepare(`INSERT INTO holding_imports(amc,as_of_date,source_file,source_url)VALUES(?,?,?,?) ON CONFLICT(amc,as_of_date,source_file)DO UPDATE SET source_url=excluded.source_url,imported_at=CURRENT_TIMESTAMP`);
const mappingUpsert=db.prepare(`INSERT INTO scheme_portfolio_mappings(scheme_code,portfolio_id,mapping_status,source_url)VALUES(?,?,'provisional',?) ON CONFLICT(scheme_code)DO UPDATE SET portfolio_id=excluded.portfolio_id,mapping_status=excluded.mapping_status,source_url=excluded.source_url,updated_at=CURRENT_TIMESTAMP`);

function parseWorkbook(bytes, sourceUrl) {
  const workbook=XLSX.read(bytes,{type:'buffer',cellDates:false});
  const sheetName=workbook.SheetNames[0];
  const rows=XLSX.utils.sheet_to_json(workbook.Sheets[sheetName],{header:1,defval:null,raw:true});
  const name=text(rows[0]?.[0]); const date=dateFromText(rows[2]?.[0]);
  const headerIndex=rows.findIndex(row=>/name of the instrument/i.test(text(row[0]))&&/%\s*to\s*net assets/i.test(text(row[5])));
  if(!name||!date||headerIndex<0)return null;
  const holdings=[];let assetClass=null;let holdingGroup=null;
  for(const row of rows.slice(headerIndex+1)){
    const instrumentName=text(row[0]);const isin=text(row[1]);const industryOrRating=text(row[2]);const quantity=number(row[3]);const marketValueLakh=number(row[4]);const publishedWeight=number(row[5]);
    if(!instrumentName||isTotal(instrumentName))continue;
    if(isSection(instrumentName)&&quantity==null&&marketValueLakh==null&&publishedWeight==null){assetClass=instrumentName;holdingGroup=null;continue;}
    if(quantity==null&&marketValueLakh==null&&publishedWeight==null){holdingGroup=instrumentName;continue;}
    holdings.push({assetClass,holdingGroup,instrumentName,isin:isin||null,industryOrRating:industryOrRating||null,quantity,marketValueLakh,weight:publishedWeight==null?null:publishedWeight/100,yield:number(row[6]),yieldToCall:null});
  }
  return holdings.length?{sourceFundCode:sheetName,name,date,holdings,sourceUrl}:null;
}

async function fetchPortfolios(){
  const target=targetMonth();const links=new Set();
  for(let page=1;page<=10;page++){
    const url=`${SOURCE_PAGE}?filteryear=${target.year}&filtermonth=${target.month}&pagination=${page}`;
    const response=await fetch(url,FETCH_OPTIONS);if(!response.ok)throw new Error(`Canara disclosure page returned ${response.status}`);
    const html=await response.text();const found=[...html.matchAll(/href=["'](https:\/\/www\.canararobeco\.com\/wp-content\/uploads\/[^"']+\.xlsx)["']/gi)].map(m=>m[1].replace(/&#8211;|&ndash;/g,'–').replace(/&amp;/g,'&'));
    if(!found.length)break;found.forEach(link=>links.add(link));
  }
  if(!links.size)throw new Error('Canara Robeco has not published usable monthly portfolio workbooks.');
  const portfolios=[];
  for(const url of links){const response=await fetch(url,FETCH_OPTIONS);if(!response.ok)throw new Error(`Canara portfolio workbook returned ${response.status}: ${url}`);const portfolio=parseWorkbook(Buffer.from(await response.arrayBuffer()),url);if(portfolio)portfolios.push(portfolio);}
  return portfolios;
}

function savePortfolios(portfolios){
  const asOfDate=portfolios[0]?.date;if(!asOfDate||portfolios.some(p=>p.date!==asOfDate))throw new Error('Canara returned mixed or unreadable disclosure dates.');
  return db.transaction(()=>{let holdingCount=0;
    for(const p of portfolios){portfolioUpsert.run(AMC,p.sourceFundCode,p.name,'Canara Robeco monthly portfolio disclosure');const {portfolio_id:id}=portfolioFind.get(AMC,p.sourceFundCode);deletePositions.run(id,asOfDate);p.holdings.forEach((h,i)=>positionInsert.run(id,asOfDate,i+1,h.assetClass,h.holdingGroup,h.instrumentName,h.isin,h.industryOrRating,h.quantity,h.marketValueLakh,h.weight,h.yield,h.yieldToCall));holdingCount+=p.holdings.length;}
    importUpsert.run(AMC,asOfDate,`canara-portfolios-${asOfDate}.xlsx`,SOURCE_PAGE);
    const byFamily=new Map(db.prepare('SELECT portfolio_id,name FROM holding_portfolios WHERE amc=?').all(AMC).map(p=>[family(p.name),p]));let mappedCount=0;
    for(const s of db.prepare("SELECT scheme_code,name FROM schemes WHERE amc=? AND LOWER(name) LIKE '%growth%'").all(AMC)){const p=byFamily.get(family(s.name));if(!p)continue;mappingUpsert.run(s.scheme_code,p.portfolio_id,SOURCE_PAGE);mappedCount++;}
    return{asOfDate,holdingCount,portfolioCount:portfolios.length,mappedCount};
  })();
}

async function main(){console.log('Fetching Canara Robeco monthly portfolio disclosures...');const result=savePortfolios(await fetchPortfolios());console.log(`Imported ${result.holdingCount} raw holdings from ${result.portfolioCount} Canara Robeco portfolios as of ${result.asOfDate}; mapped ${result.mappedCount} Growth plans.`);}
main().catch(error=>{console.error(error.stack||error.message);process.exit(1);});
