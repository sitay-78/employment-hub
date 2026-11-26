// Fetches public vacancies for the areas in search-config.json and writes data/vacancies.json.
// Runs in GitHub Actions every morning. Sources:
//  - NHS Jobs public XML search feed (no key needed): every NHS Jobs vacancy near each area.
//  - Reed and Adzuna only if API keys are ever added as repository secrets (optional; not required).
// Only place names and generic job titles are sent to the job sites. No profile data is used here.
import fs from "node:fs";

const cfg = JSON.parse(fs.readFileSync("search-config.json", "utf8"));
const REED = process.env.REED_API_KEY || "";
const AZ_ID = process.env.ADZUNA_APP_ID || "", AZ_KEY = process.env.ADZUNA_APP_KEY || "";
const areas = (cfg.areas || []).map(s => String(s).trim()).filter(Boolean);
const roles = (cfg.roles || []).map(s => String(s).trim()).filter(Boolean);
const radius = +cfg.radiusMiles || 15, maxDays = +cfg.maxDaysOld || 14;
const out = {updatedAt: new Date().toISOString(), areas, sources: [], errors: [], items: []};
const seen = new Set();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clean = s => String(s || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const hourly = (min, max) => { const v = +(min || max || 0); if (!v) return null; return v >= 1000 ? +(v / 52 / 37.5).toFixed(2) : v <= 100 ? +v.toFixed(2) : null; };
const payText = (min, max, predicted) => { if (!min && !max) return ""; const f = n => "£" + Math.round(n).toLocaleString("en-GB"); const unit = (min || max) >= 1000 ? " a year" : " an hour"; const r = min && max && min !== max ? `${f(min)}–${f(max)}` : f(min || max); return r + unit + (predicted ? " (estimated)" : ""); };
const ukDate = s => { const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s || ""); return m ? `${m[3]}-${m[2]}-${m[1]}` : ""; };
function add(item) {
  const key = (item.title + "|" + item.employer + "|" + item.location).toLowerCase().replace(/\s+/g, " ");
  if (seen.has(key)) return;
  seen.add(key); const {role, ...rest} = item; out.items.push({key, ...rest});
}
async function getJSON(url, headers = {}) {
  for (let i = 0; i < 3; i++) {
    const r = await fetch(url, {headers: {"User-Agent": "employment-research-hub", ...headers}});
    if (r.status === 429 || r.status >= 500) { await sleep(2000 * (i + 1)); continue; }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }
  throw new Error("gave up after retries");
}
async function reed(area, role) {
  const u = `https://www.reed.co.uk/api/1.0/search?keywords=${encodeURIComponent(role)}&locationName=${encodeURIComponent(area)}&distanceFromLocation=${radius}&resultsToTake=100`;
  const j = await getJSON(u, {Authorization: "Basic " + Buffer.from(REED + ":").toString("base64")});
  const cutoff = Date.now() - maxDays * 86400000;
  for (const x of j.results || []) {
    const posted = ukDate(x.date); if (posted && Date.parse(posted) < cutoff) continue;
    add({id: "reed-" + x.jobId, source: "Reed", role, searchArea: area, title: clean(x.jobTitle), employer: clean(x.employerName), location: clean(x.locationName),
      payText: payText(x.minimumSalary, x.maximumSalary), payHourly: hourly(x.minimumSalary, x.maximumSalary), closingDate: ukDate(x.expirationDate), posted,
      description: clean(x.jobDescription).slice(0, 600), url: x.jobUrl && x.jobUrl.startsWith("https://") ? x.jobUrl : `https://www.reed.co.uk/jobs/${x.jobId}`});
  }
}
async function adzuna(area, group) {
  for (let page = 1; page <= 2; page++) {
    const u = `https://api.adzuna.com/v1/api/jobs/gb/search/${page}?app_id=${AZ_ID}&app_key=${AZ_KEY}&what_or=${encodeURIComponent(group.join(" "))}&where=${encodeURIComponent(area)}&distance=${Math.round(radius * 1.609)}&max_days_old=${maxDays}&results_per_page=50&sort_by=date&content-type=application/json`;
    const j = await getJSON(u);
    for (const x of j.results || []) {
      const t = clean(x.title), role = group.find(g => t.toLowerCase().includes(g.split(" ")[0])) || group[0];
      add({id: "adzuna-" + x.id, source: "Adzuna", role, searchArea: area, title: t, employer: clean(x.company && x.company.display_name), location: clean(x.location && x.location.display_name),
        payText: payText(x.salary_min, x.salary_max, x.salary_is_predicted === "1"), payHourly: x.salary_is_predicted === "1" ? null : hourly(x.salary_min, x.salary_max),
        hoursType: x.contract_time === "part_time" ? "Part-time" : x.contract_time === "full_time" ? "Full-time" : "Unknown",
        contract: x.contract_type === "permanent" ? "Permanent" : x.contract_type === "contract" ? "Fixed-term" : "Unknown",
        closingDate: "", posted: (x.created || "").slice(0, 10), description: clean(x.description).slice(0, 600), url: String(x.redirect_url || "").startsWith("https://") ? x.redirect_url : ""});
    }
    if ((j.results || []).length < 50) break;
    await sleep(1200);
  }
}
const xmlTag = (block, tag) => { const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(block); return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&").trim() : ""; };
async function nhs(area) {
  const maxPages = +cfg.nhsMaxPagesPerArea || 80; const cutoff = Date.now() - maxDays * 86400000;
  for (let page = 1; page <= maxPages; page++) {
    const u = `https://www.jobs.nhs.uk/api/v1/search_xml?location=${encodeURIComponent(area)}&distance=${radius}&page=${page}`;
    let xml = "";
    for (let i = 0; i < 3; i++) { const r = await fetch(u, {headers: {"User-Agent": "employment-research-hub (GitHub Actions; daily)"}}); if (r.ok) { xml = await r.text(); break; } await sleep(3000 * (i + 1)); }
    if (!xml) throw new Error("no response");
    const blocks = xml.split("<vacancyDetails>").slice(1);
    for (const b of blocks) {
      const desc = clean(xmlTag(b, "description")); const sal = xmlTag(b, "salary"); let nums = (sal.match(/[\d,]+(?:\.\d+)?/g) || []).map(n => +n.replace(/,/g, "")).filter(n => n > 5);
      if (!nums.length) nums = (desc.match(/£\s?[\d,]+(?:\.\d+)?/g) || []).map(n => +n.replace(/[£,\s]/g, "")).filter(n => n > 5).slice(0, 2);
      const posted = xmlTag(b, "postDate").slice(0, 10); if (posted && Date.parse(posted) < cutoff) continue;
      const type = xmlTag(b, "type"); const txt = (desc + " " + type).toLowerCase(); const url = xmlTag(b, "url");
      add({id: "nhs-" + xmlTag(b, "id"), source: "NHS Jobs", role: "", searchArea: area, title: clean(xmlTag(b, "title")), employer: clean(xmlTag(b, "employer")),
        location: clean(xmlTag(b, "location")).replace(/,?\s*[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i, ""),
        payText: /\d/.test(sal) ? sal.replace(/(\d)\.00\b/g, "$1").replace(/\b(\d{4,})\b/g, n => "£" + (+n).toLocaleString("en-GB")).replace(/££/g, "£") : sal, payHourly: nums.length ? hourly(nums[0], nums[1]) : null,
        hoursType: /part[- ]time/.test(txt) ? "Part-time" : /full[- ]time/.test(txt) ? "Full-time" : "Unknown",
        contract: /permanent/i.test(type) ? "Permanent" : /fixed/i.test(type) ? "Fixed-term" : /bank/i.test(type) ? "Zero-hours" : /apprentice/i.test(type) ? "Apprenticeship" : "Unknown",
        closingDate: xmlTag(b, "closeDate").slice(0, 10), posted, description: desc.slice(0, 600), url: url.startsWith("https://") ? url : ""});
    }
    const total = +xmlTag(xml, "totalPages") || 1; if (page >= total || !blocks.length) break;
    await sleep(1000);
  }
}
if (!areas.length) out.errors.push("No areas set in search-config.json yet.");
for (const area of areas) {
  try { await nhs(area); } catch (e) { out.errors.push(`NHS Jobs in ${area}: ${e.message}`); }
  if (REED) { for (const role of roles) { try { await reed(area, role); } catch (e) { out.errors.push(`Reed ${role} in ${area}: ${e.message}`); } await sleep(400); } }
  if (AZ_ID && AZ_KEY) { const words = roles.flatMap(r => r.split(" ")).filter((w, i, a) => w.length > 3 && a.indexOf(w) === i); for (let i = 0; i < words.length; i += 12) { try { await adzuna(area, words.slice(i, i + 12)); } catch (e) { out.errors.push(`Adzuna in ${area}: ${e.message}`); } await sleep(1200); } }
}
out.sources.push("NHS Jobs"); if (REED) out.sources.push("Reed"); if (AZ_ID && AZ_KEY) out.sources.push("Adzuna");
const today = new Date().toISOString().slice(0, 10);
out.items = out.items.filter(x => !x.closingDate || x.closingDate >= today).map(({key, ...x}) => x).slice(0, 6000);
out.errors = out.errors.slice(0, 50);
fs.mkdirSync("data", {recursive: true});
fs.writeFileSync("data/vacancies.json", JSON.stringify(out));
console.log(`Saved ${out.items.length} vacancies for ${areas.length} areas from ${out.sources.join(", ") || "no sources"}. ${out.errors.length} warnings.`);
