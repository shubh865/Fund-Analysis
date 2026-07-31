const XLSX=require('xlsx');
const db=require('../server/db');
const {normalizeHoldings}=require('./lib/portfolio-normalization');
const AMC='Quantum Mutual Fund';
const SOURCE_PAGE='https://www.quantumamc.com/portfolio/combined/-1/1/0/0';

function text(v){return v==null?'':String(v).replace(/\s+/g,' ').trim();}
function number(v){const n=typeof v==='number'?v:Number(text(v).replace(/,/g,'').replace(/%$/,''));return Number.isFinite(n)?n:null;}
function yieldPercent(v){const n=number(v);return n!=null&&n>0&&n<1?n*100:n;}
function dateFromText(v){const m=text(v).match(/([A-Z][a-z]+)\s+(\d{1,2}),\s+(\d{4})/i);if(!m)return null;const d=new Date(`${m[1]} ${m[2]}, ${m[3]} UTC`);return Number.isNaN(d.getTime())?null:d.toISOString().slice(0,10);}
function family(name){return text(name).toUpperCase().split('(')[0].replace(/\b(QUANTUM|DIRECT|REGULAR|PLAN|GROWTH|OPTION|IDCW|DIVIDEND|REINVESTMENT|FUND)\b/g,' ').replace(/[^A-Z0-9]+/g,' ').replace(/\s+/g,' ').trim();}
function isTotal(v){return/^(sub\s*total|total|grand\s*total|net current assets|total net assets)/i.test(v);}
function isSection(v){return/^(equity|debt|money market|derivatives|units of|cash|other current assets|foreign securities|government securities|treasury bill|commercial paper|certificate of deposit|mutual fund units|repo)/i.test(v);}

const portfolioUpsert=db.prepare(`INSERT INTO holding_portfolios(amc,source_fund_code,name,description)VALUES(?,?,?,?) ON CONFLICT(amc,source_fund_code)DO UPDATE SET name=excluded.name,description=excluded.description`);
const portfolioFind=db.prepare('SELECT portfolio_id FROM holding_portfolios WHERE amc=? AND source_fund_code=?');
const deletePositions=db.prepare('DELETE FROM portfolio_holdings WHERE portfolio_id=? AND as_of_date=?');
const positionInsert=db.prepare(`INSERT INTO portfolio_holdings(portfolio_id,as_of_date,position_order,asset_class,holding_group,instrument_name,isin,industry_or_rating,quantity,market_value_lakh,weight,yield,yield_to_call)VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`);
const importUpsert=db.prepare(`INSERT INTO holding_imports(amc,as_of_date,source_file,source_url)VALUES(?,?,?,?) ON CONFLICT(amc,as_of_date,source_file)DO UPDATE SET source_url=excluded.source_url,imported_at=CURRENT_TIMESTAMP`);
const mappingUpsert=db.prepare(`INSERT INTO scheme_portfolio_mappings(scheme_code,portfolio_id,mapping_status,source_url)VALUES(?,?,'provisional',?) ON CONFLICT(scheme_code)DO UPDATE SET portfolio_id=excluded.portfolio_id,mapping_status=excluded.mapping_status,source_url=excluded.source_url,updated_at=CURRENT_TIMESTAMP`);

function parseWorkbook(bytes){
 const workbook=XLSX.read(bytes,{type:'buffer',cellDates:false});const portfolios=[];
 for(const sourceFundCode of workbook.SheetNames.filter(n=>n!=='Index')){
  const rows=XLSX.utils.sheet_to_json(workbook.Sheets[sourceFundCode],{header:1,defval:null,raw:true});const name=text(rows[6]?.[0]);const date=dateFromText(rows[8]?.[0]);
  const headerIndex=rows.findIndex(r=>r.some(cell=>/name of instrument/i.test(text(cell)))&&r.some(cell=>/%\s*to\s*nav/i.test(text(cell))));if(!name||!date||headerIndex<0)continue;
  const header=rows[headerIndex].map(text);const instrumentIndex=header.findIndex(v=>/name of instrument/i.test(v));const isinIndex=header.findIndex(v=>/^isin$/i.test(v));const industryIndex=header.findIndex(v=>/industry/i.test(v));const quantityIndex=header.findIndex(v=>/^quantity$/i.test(v));const valueIndex=header.findIndex(v=>/market.*fair value/i.test(v));const weightIndex=header.findIndex(v=>/%\s*to\s*nav/i.test(v));const yieldIndex=header.findIndex(v=>/yield to maturity/i.test(v));
  const holdings=[];let assetClass=null;let holdingGroup=null;
  for(const row of rows.slice(headerIndex+1)){const instrumentName=text(row[instrumentIndex]);const isin=isinIndex<0?'':text(row[isinIndex]);const industryOrRating=industryIndex<0?'':text(row[industryIndex]);const quantity=number(row[quantityIndex]);const marketValueLakh=number(row[valueIndex]);const weight=number(row[weightIndex]);if(!instrumentName||isTotal(instrumentName))continue;if(isSection(instrumentName)&&quantity==null&&marketValueLakh==null&&weight==null){assetClass=instrumentName;holdingGroup=null;continue;}if(quantity==null&&marketValueLakh==null&&weight==null){holdingGroup=instrumentName;continue;}holdings.push({assetClass,holdingGroup,instrumentName,isin:isin||null,industryOrRating:industryOrRating||null,quantity,marketValueLakh,weight,yield:yieldIndex<0?null:yieldPercent(row[yieldIndex]),yieldToCall:null});}
  const normalizedHoldings=normalizeHoldings(holdings,name);
  if(normalizedHoldings.length)portfolios.push({sourceFundCode,name,date,holdings:normalizedHoldings});
 }
 return portfolios;
}

async function fetchPortfolios(){const page=await fetch(SOURCE_PAGE);if(!page.ok)throw new Error(`Quantum disclosure page returned ${page.status}`);const html=await page.text();const match=html.match(/href=["'](https:\/\/www\.quantumamc\.com\/FileCDN\/FactSheet\/[^"']+\.xlsx)["'][\s\S]{0,700}?All Funds/i);if(!match)throw new Error('Quantum has not published a usable All Funds workbook.');const response=await fetch(match[1]);if(!response.ok)throw new Error(`Quantum workbook returned ${response.status}`);return{portfolios:parseWorkbook(Buffer.from(await response.arrayBuffer())),sourceUrl:match[1]};}

function savePortfolios(portfolios,sourceUrl){const asOfDate=portfolios[0]?.date;if(!asOfDate||portfolios.some(p=>p.date!==asOfDate))throw new Error('Quantum returned mixed or unreadable disclosure dates.');return db.transaction(()=>{let holdingCount=0;for(const p of portfolios){portfolioUpsert.run(AMC,p.sourceFundCode,p.name,'Quantum monthly portfolio disclosure');const{portfolio_id:id}=portfolioFind.get(AMC,p.sourceFundCode);deletePositions.run(id,asOfDate);p.holdings.forEach((h,i)=>positionInsert.run(id,asOfDate,i+1,h.assetClass,h.holdingGroup,h.instrumentName,h.isin,h.industryOrRating,h.quantity,h.marketValueLakh,h.weight,h.yield,h.yieldToCall));holdingCount+=p.holdings.length;}importUpsert.run(AMC,asOfDate,`quantum-portfolios-${asOfDate}.xlsx`,sourceUrl);const byFamily=new Map(db.prepare('SELECT portfolio_id,name FROM holding_portfolios WHERE amc=?').all(AMC).map(p=>[family(p.name),p]));let mappedCount=0;for(const s of db.prepare("SELECT scheme_code,name FROM schemes WHERE amc=? AND LOWER(name) LIKE '%growth%'").all(AMC)){const p=byFamily.get(family(s.name));if(!p)continue;mappingUpsert.run(s.scheme_code,p.portfolio_id,SOURCE_PAGE);mappedCount++;}return{asOfDate,holdingCount,portfolioCount:portfolios.length,mappedCount};})();}

async function main(){console.log('Fetching Quantum monthly portfolio disclosures...');const fetched=await fetchPortfolios();const result=savePortfolios(fetched.portfolios,fetched.sourceUrl);console.log(`Imported ${result.holdingCount} raw holdings from ${result.portfolioCount} Quantum portfolios as of ${result.asOfDate}; mapped ${result.mappedCount} Growth plans.`);}
main().catch(error=>{console.error(error.stack||error.message);process.exit(1);});
