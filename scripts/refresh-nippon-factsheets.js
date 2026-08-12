const db = require('../server/db');
const AMC = 'Nippon India Mutual Fund';
const DISCLOSURES_URL = 'https://mf.nipponindiaim.com/investor-service/downloads/factsheet-portfolio-and-other-disclosures';
const clean = (x) => String(x || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#8377;/g, ' ').replace(/\s+/g, ' ').trim();
const norm = (x) => clean(x).toUpperCase().replace(/NIPPON INDIA/g,'').replace(/\b(DIRECT|REGULAR|PLAN|OPTION|GROWTH|IDCW|DIVIDEND|PAYOUT|REINVESTMENT)\b/g,'').replace(/[^A-Z0-9]+/g,' ').trim();
const n = (x) => { const m = clean(x).match(/\d+(?:\.\d+)?/); return m ? Number(m[0]) : null; };
const years = (x) => /days?/i.test(x) ? n(x) / 365.2425 : n(x);
function matchValue(html, label) { return html.match(new RegExp(`${label}[\\s\\S]{0,500}?<td[^>]*>\\s*([^<]+)`, 'i'))?.[1]; }
async function main() {
  console.log('Discovering the latest Nippon India digital factsheet...');
  const disclosures = await (await fetch(DISCLOSURES_URL)).text();
  const relativeRoot = disclosures.match(/href="([^"?#]*Fundamentals-[^"?#/]+\/index\.html)"/i)?.[1];
  if (!relativeRoot) throw new Error('Could not find the latest E-Factsheet link on Nippon India’s official disclosures page.');
  let ROOT = new URL(relativeRoot, DISCLOSURES_URL).href.replace(/index\.html$/i, '');
  console.log(`Using ${ROOT}`);
  let index = await (await fetch(`${ROOT}index.html`)).text();
  let links = [...new Set([...index.matchAll(/href="(Innerpage\/[^"?]+\.html)"/gi)].map((m) => m[1]))];
  if (!links.length) {
    const alternatives = [...new Set([...disclosures.matchAll(/href="([^"?#]*Fundamentals-[^"?#/]+\/index\.html)"/gi)].map((m) => m[1]))];
    for (const alternative of alternatives) {
      const candidateRoot = new URL(alternative, DISCLOSURES_URL).href.replace(/index\.html$/i, '');
      if (candidateRoot === ROOT) continue;
      const candidateIndex = await (await fetch(`${candidateRoot}index.html`)).text();
      const candidateLinks = [...new Set([...candidateIndex.matchAll(/href="(Innerpage\/[^"?]+\.html)"/gi)].map((m) => m[1]))];
      if (candidateLinks.length) { ROOT = candidateRoot; index = candidateIndex; links = candidateLinks; console.log(`Falling back to latest complete directory: ${ROOT}`); break; }
    }
  }
  if (!links.length) throw new Error('Nippon India has not published a complete usable digital factsheet directory.');
  const families = new Map();
  for (const s of db.prepare('SELECT scheme_code,name FROM schemes WHERE amc=?').all(AMC)) { const key=norm(s.name); if(key.length>5) families.set(key,[...(families.get(key)||[]),s.scheme_code]); }
  const snapshot=db.prepare(`INSERT INTO scheme_factsheet_snapshots (scheme_code,as_of_date,source_amc,exit_load_text,source_url,source_file) VALUES (?,?,?,?,?,?) ON CONFLICT(scheme_code,as_of_date) DO UPDATE SET exit_load_text=excluded.exit_load_text,source_url=excluded.source_url,source_file=excluded.source_file`);
  const dm=db.prepare('DELETE FROM scheme_factsheet_managers WHERE scheme_code=? AND as_of_date=?');
  const im=db.prepare('INSERT INTO scheme_factsheet_managers (scheme_code,as_of_date,manager_name,managing_since,experience_years,source_url) VALUES (?,?,?,?,?,?)');
  const iq=db.prepare(`INSERT INTO scheme_debt_quant_snapshots (scheme_code,as_of_date,modified_duration_years,average_maturity_years,yield_to_maturity_percent,macaulay_duration_years,source_url) VALUES (?,?,?,?,?,?,?) ON CONFLICT(scheme_code,as_of_date) DO UPDATE SET modified_duration_years=excluded.modified_duration_years,average_maturity_years=excluded.average_maturity_years,yield_to_maturity_percent=excluded.yield_to_maturity_percent,macaulay_duration_years=excluded.macaulay_duration_years,source_url=excluded.source_url`);
  let imported=0, debts=0;
  for (const link of links) {
    const url=ROOT+link, html=await (await fetch(url)).text();
    const title=clean(html.match(/<title>([^<]+)/i)?.[1]); const family=[...families.entries()].find(([k])=>norm(title).includes(k)); if(!family) continue;
    const date=clean(html.match(/NAV as on\s+([A-Za-z]+\s+\d{1,2},\s+\d{4})/i)?.[1]); const parsed=new Date(`${date} UTC`); if(Number.isNaN(parsed.getTime())) continue;
    const asOf=parsed.toISOString().slice(0,10); const exit=clean(html.match(/Exit Load:[\s\S]{0,1800}(?=<\/table>)/i)?.[0]);
    const managers=[...html.matchAll(/<div[^>]*>Fund Manager\(s\)<\/div>[\s\S]{0,1000}?<p>([\s\S]*?)<\/p>/gi)].flatMap((m)=>clean(m[1]).split(/Total Experience[^\d]*(?:more than )?\d+ years?/i)[0].split(/\s{2,}|\(Managing Since/).map(clean).filter((v)=>/^[A-Z][A-Za-z. ]+$/.test(v)));
    const avg=matchValue(html,'Average Maturity'), mod=matchValue(html,'Modified Duration'), ytm=matchValue(html,'(?:Annualized portfolio )?YTM'), mac=matchValue(html,'Macaulay Duration');
    db.transaction(()=>{for(const code of family[1]) {snapshot.run(code,asOf,AMC,exit||null,url,link);dm.run(code,asOf);for(const name of [...new Set(managers)]) im.run(code,asOf,name,null,null,url);if(avg&&mod&&ytm&&mac){iq.run(code,asOf,years(mod),years(avg),n(ytm),years(mac),url);debts++;}imported++;}})();
  }
  console.log(`Imported Nippon factsheet observations for ${imported} NAV plans (${debts} debt-plan quant snapshots).`);
}
main().catch(e=>{console.error(e.stack||e.message);process.exit(1)});
