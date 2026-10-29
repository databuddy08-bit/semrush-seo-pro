// Semrush SEO API Pro — keyword research, domain overview, organic competitors and backlinks.
// Data sources: Semrush's free public domain pages (domain mode), the Semrush API and DataForSEO (developer keys).
import { Actor, log } from 'apify';
import { Client, Session, BlockedError, StoppedError, HTML_HEADERS } from './http.js';
import { resolveDb } from './dbs.js';
import { ResultCache } from './provider-base.js';
import { SemrushApi } from './semrush.js';
import { DataForSeo } from './dataforseo.js';
import { pageData, domainFromPage, publicUrl } from './publicpage.js';
import { keywordRow, competitorRow, backlinkRow, makeKeywordFilter, cleanDomain } from './rows.js';

// Pay-per-event names — must match the Monetization settings exactly.
export const EVENTS = { keyword: 'keyword', competitors: 'competitor', backlinks: 'backlink', domain: 'domain-report' };

const MODES = ['keyword', 'domain', 'competitors', 'backlinks'];
const MATCH_TYPES = ['phrase', 'exact', 'broad', 'related', 'questions'];
const STOP_BEFORE_TIMEOUT_MS = 45000;
const CONCURRENCY = 3;
const INT32 = 2147483647;
const env = process.env;
const MAX_QUERIES = Number(env.MAX_QUERIES_PER_RUN ?? 1000);
const MAX_PAGES = Number(env.MAX_PAGES_PER_RUN ?? 200); // shared 100-row page budget per run (keeps API spend bounded)

await Actor.init();
const input = (await Actor.getInput()) ?? {};
const num = (v, d, min, max) => Math.min(max, INT32, Math.max(min, Number.isFinite(Number(v)) && v !== '' && v !== null ? Math.floor(Number(v)) : d));
const list = (v) => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(/\n/) : []).map((x) => String(x ?? '').trim()).filter(Boolean);
const failInput = async (msg) => {
    await Actor.pushData({ mode: input.mode ?? null, error: msg, errorCode: 'INVALID_INPUT' });
    await Actor.fail(msg);
};

// ---------- Options ----------
let o;
try {
    const mode = String(input.mode || 'keyword').toLowerCase();
    if (!MODES.includes(mode)) throw new Error(`Unknown mode "${input.mode}". Use keyword, domain, competitors or backlinks.`);
    const type = String(input.type || 'phrase').toLowerCase();
    if (!MATCH_TYPES.includes(type)) throw new Error(`Unknown match type "${input.type}". Use phrase, exact, broad, related or questions.`);
    const rawQueries = list(input.queries).length ? list(input.queries) : list(input.q);
    if (mode === 'backlinks' && input.target) rawQueries.splice(0, rawQueries.length, String(input.target).trim());
    const seen = new Set();
    const queries = [];
    for (const raw of rawQueries) {
        const value = mode === 'keyword' ? raw.replace(/\s+/g, ' ') : mode === 'backlinks' && (input.target || input.target_type === 'url') ? raw : cleanDomain(raw);
        const key = value.toLowerCase();
        if (!value || seen.has(key)) continue;
        seen.add(key);
        queries.push(value);
    }
    if (!queries.length) throw new Error(mode === 'keyword' ? 'Enter a keyword in "Query" or a list in "Queries".' : 'Enter a domain in "Query" or a list in "Queries".');
    if (queries.length > MAX_QUERIES) throw new Error(`Too many queries (${queries.length}). The limit is ${MAX_QUERIES} per run — split the list across runs.`);
    const targetType = input.target ? 'url' : ['root_domain', 'domain', 'url'].includes(input.target_type) ? input.target_type : 'root_domain';
    o = {
        mode, type, queries,
        db: resolveDb(input.db, input.language),
        pages: num(input.pages, 1, 1, 100),
        sortBy: ['competition_level', 'common_keywords', 'traffic'].includes(input.sort_by) ? input.sort_by : 'competition_level',
        targetType,
        dataSource: ['auto', 'semrush', 'dataforseo'].includes(input.dataSource) ? input.dataSource : 'auto',
        domainSource: ['auto', 'public', 'api'].includes(input.domainSource) ? input.domainSource : 'auto',
        includeSeed: Boolean(input.includeSeed),
        filter: makeKeywordFilter(input),
        followOnly: Boolean(input.followOnly),
        backlinkStatus: ['live', 'new', 'lost'].includes(input.backlinkStatus) ? input.backlinkStatus : 'live',
        onePerDomain: Boolean(input.onePerDomain),
        maxItems: num(input.maxItems, 0, 0, INT32),
        useCache: input.useCache !== false,
        cacheHours: num(input.cacheHours, 168, 0, 24 * 90),
    };
    if (o.targetType === 'url') {
        for (const q of o.queries) if (!/^https?:\/\/[^/\s]+\.[^/\s]+/i.test(q)) throw new Error(`"${q}" is not a full URL. With Target type = url, use https://example.com/page.`);
    }
} catch (err) {
    await failInput(err.message);
}

// ---------- Deadline, sources, pricing ----------
const startedAt = Date.now();
const { timeoutAt } = Actor.getEnv();
const deadline = timeoutAt ? new Date(timeoutAt).getTime() - STOP_BEFORE_TIMEOUT_MS : Infinity;
let stopReason = null;
const stop = (r) => {
    if (!stopReason) {
        stopReason = r;
        log.info(`Stopping: ${r}`);
    }
};
const msLeft = () => {
    if (!stopReason && Date.now() >= deadline) stop('timeout_approaching (stopped 45 s early so data is saved)');
    return stopReason ? 0 : deadline - Date.now();
};

const stats = { semrushCalls: 0, semrushUnits: 0, dataforseoCalls: 0, dataforseoCost: 0, dataforseoRateLimited: 0, cacheHits: 0, publicPages: 0, publicPagesMissing: 0, requests: 0, blocked: 0, networkErrors: 0 };
const semrush = new SemrushApi({ key: env.SEMRUSH_API_KEY, base: env.SEMRUSH_API_BASE, stats });
semrush.name = 'semrush_api';
const dfs = new DataForSeo({ login: env.DATAFORSEO_LOGIN, password: env.DATAFORSEO_PASSWORD, base: env.DATAFORSEO_BASE, stats });
dfs.name = 'dataforseo';
const providers = (o.dataSource === 'semrush' ? [semrush] : o.dataSource === 'dataforseo' ? [dfs] : [semrush, dfs]).filter((p) => p.configured);
const needsApi = o.mode !== 'domain' || o.domainSource === 'api';
if (needsApi && !providers.length) {
    const missing = o.dataSource === 'semrush' ? ['SEMRUSH_API_KEY'] : o.dataSource === 'dataforseo' ? ['DATAFORSEO_LOGIN', 'DATAFORSEO_PASSWORD'] : ['SEMRUSH_API_KEY', 'or DATAFORSEO_LOGIN + DATAFORSEO_PASSWORD'];
    log.error(`No data source configured. Missing environment variables: ${missing.join(' ')}. Add them under Source → Environment variables (mark them Secret) and rebuild.`);
    const msg = 'This Actor has no data source configured (developer setting). Domain mode still works. Please report it in the Issues tab.';
    await Actor.pushData({ mode: o.mode, error: msg, errorCode: 'NO_DATA_SOURCE' });
    await Actor.fail(msg);
}

const cache = o.useCache && o.cacheHours > 0 ? new ResultCache(await Actor.openKeyValueStore('semrush-seo-pro-cache').catch(() => null), o.cacheHours, stats) : null;
const cached = (p, method, args) => (cache ? cache.wrap([p.name, method, o.db.language, args], () => p[method](args)) : p[method](args));

// Public pages: user proxy → Apify datacenter → residential → server IP.
const proxyInput = input.proxyConfiguration ?? input.proxy;
const routes = [];
let userProxy;
if (proxyInput?.useApifyProxy || proxyInput?.proxyUrls?.length) {
    try {
        userProxy = await Actor.createProxyConfiguration(proxyInput);
    } catch (err) {
        log.warning(`Proxy could not be configured (${err.message}). Continuing without it.`);
    }
}
const userLabel = !userProxy ? 'no proxy (server IP)' : proxyInput?.useApifyProxy ? `Apify proxy (${proxyInput.apifyProxyGroups?.length ? proxyInput.apifyProxyGroups.join(', ') : 'datacenter'})` : 'custom proxy';
routes.push({ label: userLabel, proxy: userProxy });
if (o.mode === 'domain' && o.domainSource !== 'api' && input.proxyFallback !== false && (Actor.isAtHome() || env.APIFY_PROXY_PASSWORD)) {
    for (const g of [[], ['RESIDENTIAL']]) {
        const label = `Apify proxy (${g.length ? g[0] : 'datacenter'})`;
        if (label === userLabel) continue;
        try {
            const pc = await Actor.createProxyConfiguration({ useApifyProxy: true, ...(g.length ? { apifyProxyGroups: g } : {}) });
            if (pc) routes.push({ label, proxy: pc });
        } catch { /* group not on this plan */ }
    }
    if (userProxy) routes.push({ label: 'no proxy (server IP)', proxy: undefined });
}
const web = new Client({ routes, msLeft, stats });

const charging = Actor.getChargingManager();
const pricing = charging.getPricingInfo();
const event = EVENTS[o.mode];
const summary = {
    startedAt: new Date(startedAt).toISOString(), finishedAt: null, durationSec: null, stopReason: null,
    settings: { mode: o.mode, database: o.db.db, matchType: o.mode === 'keyword' ? o.type : undefined, pages: o.pages, dataSource: o.dataSource, domainSource: o.mode === 'domain' ? o.domainSource : undefined },
    queries: o.queries.length, queriesWithResults: 0, queriesEmpty: 0, queriesFailed: 0,
    rows: 0, charged: 0, skippedByFilters: 0, skipReasons: {}, pagesUsed: 0, pageBudget: MAX_PAGES,
    rowsBySource: {}, fillRates: {}, sources: null, routes: [],
};
log.info(`Mode ${o.mode}, ${o.queries.length} quer${o.queries.length === 1 ? 'y' : 'ies'}, database ${o.db.db}${o.mode === 'keyword' ? `, ${o.type} match` : ''}. Sources: ${o.mode === 'domain' && o.domainSource !== 'api' ? 'Semrush public pages' : ''}${providers.length ? `${o.mode === 'domain' && o.domainSource !== 'api' ? ' → ' : ''}${providers.map((p) => p.name).join(' → ')}` : ''}.`);

// ---------- Output ----------
let chain = Promise.resolve();
let saved = 0;
const filled = {};
function track(row) {
    const keys = { keyword: ['volume', 'cpc', 'difficulty', 'competition_level', 'intents', 'trend', 'results'], competitors: ['common_keywords', 'traffic', 'se_keywords'], backlinks: ['source_title', 'page_ascore', 'first_seen'], domain: ['authority_score', 'number_of_backlinks', 'organic_traffic', 'top_keywords', 'competitors'] }[o.mode];
    for (const k of keys) {
        const val = row[k];
        filled[k] = (filled[k] ?? 0) + (val === null || val === undefined || (Array.isArray(val) && !val.length) ? 0 : 1);
    }
}
function save(row, charge) {
    const p = chain.then(async () => {
        if (charge && stopReason) return false;
        if (charge && o.maxItems && saved >= o.maxItems) {
            stop('max_items_reached');
            return false;
        }
        if (charge && pricing.isPayPerEvent && charging.calculateMaxEventChargeCountWithinLimit(event) <= 0) {
            stop('max_cost_per_run_reached');
            return false;
        }
        row.scrapedAt = new Date().toISOString();
        if (charge) {
            const res = await Actor.pushData(row, event);
            summary.charged += res?.chargedCount ?? 0;
            saved += 1;
            summary.rows += 1;
            summary.rowsBySource[row.source] = (summary.rowsBySource[row.source] ?? 0) + 1;
            track(row);
            if (res?.eventChargeLimitReached) stop('max_cost_per_run_reached');
        } else await Actor.pushData(row); // errors and empty results are free
        return true;
    });
    chain = p.then(() => {}, () => {});
    return p;
}
const errorRow = (query, error, errorCode) => save({ mode: o.mode, query, database: o.db.db, error, errorCode }, false);

/** Runs fn(provider) on the first source that can do it; moves on when a source is down or can't do this. */
async function withProvider(fn) {
    let last;
    for (const p of providers) {
        if (p.down) {
            last = new Error(p.down);
            continue;
        }
        try {
            return { result: await fn(p), source: p.name };
        } catch (err) {
            if (err instanceof StoppedError) throw err;
            last = err;
            if (['down', 'unsupported', 'bad_market'].includes(err.kind) && p !== providers.at(-1)) {
                log.warning(`${p.name}: ${err.message}. Trying the next data source.`);
                continue;
            }
            throw err;
        }
    }
    throw last ?? new Error('No data source available');
}

/** Takes up to `want` pages from the run's page budget. */
let pageBudgetHit = false;
function takePages(want) {
    const n = Math.max(0, Math.min(want, MAX_PAGES - summary.pagesUsed));
    summary.pagesUsed += n;
    return n;
}

// ---------- Modes ----------
async function keywordQuery(query) {
    const pages = takePages(o.pages);
    if (!pages) {
        pageBudgetHit = true; // queries already running finish normally
        await errorRow(query, `Run page budget used up (${MAX_PAGES} pages of 100 keywords). Start another run for the rest.`, 'PAGE_BUDGET');
        return -1;
    }
    const ctxBase = { query, db: o.db, matchType: o.type };
    const { result, source } = await withProvider(async (p) => {
        const out = [];
        if (o.includeSeed) out.push(...(await cached(p, 'seed', { phrase: query, db: o.db })));
        const chunk = p === dfs ? 1000 : 2000;
        const want = pages * 100;
        for (let offset = 0; offset < want && !stopReason; offset += chunk) {
            const limit = Math.min(chunk, want - offset);
            const rows = await cached(p, 'keywords', { phrase: query, db: o.db, matchType: o.type, limit, offset, filter: o.filter });
            out.push(...rows);
            if (rows.length < limit) break;
        }
        return out;
    });
    const seen = new Set();
    let n = 0;
    for (const k of result) {
        const key = String(k.phrase ?? '').toLowerCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        const row = keywordRow(k, { ...ctxBase, source });
        const why = row.is_seed ? null : o.filter.reject(row);
        if (why) {
            summary.skippedByFilters += 1;
            summary.skipReasons[why] = (summary.skipReasons[why] ?? 0) + 1;
            continue;
        }
        if (await save(row, true)) n += 1;
        if (stopReason) break;
    }
    return n;
}

async function competitorsQuery(domain) {
    const pages = takePages(o.pages);
    if (!pages) {
        pageBudgetHit = true; // queries already running finish normally
        await errorRow(domain, `Run page budget used up (${MAX_PAGES} pages of 100 rows). Start another run for the rest.`, 'PAGE_BUDGET');
        return -1;
    }
    const { result, source } = await withProvider((p) => cached(p, 'competitors', { domain, db: o.db, limit: pages * 100, offset: 0, sortBy: o.sortBy }));
    const rows = [...result];
    if (o.sortBy === 'traffic') rows.sort((a, b) => (b.traffic ?? 0) - (a.traffic ?? 0));
    if (o.sortBy === 'common_keywords') rows.sort((a, b) => (b.common ?? 0) - (a.common ?? 0));
    if (o.sortBy === 'competition_level') rows.sort((a, b) => (b.level ?? 0) - (a.level ?? 0));
    let n = 0;
    for (const [i, c] of rows.entries()) {
        if (await save(competitorRow({ ...c, rank: i + 1 }, { query: domain, db: o.db, source }), true)) n += 1;
        if (stopReason) break;
    }
    return n;
}

async function backlinksQuery(target) {
    const pages = takePages(o.pages);
    if (!pages) {
        pageBudgetHit = true; // queries already running finish normally
        await errorRow(target, `Run page budget used up (${MAX_PAGES} pages of 100 rows). Start another run for the rest.`, 'PAGE_BUDGET');
        return -1;
    }
    const { result, source } = await withProvider(async (p) => {
        const out = [];
        const chunk = p === dfs ? 1000 : 2000;
        for (let offset = 0; offset < pages * 100 && !stopReason; offset += chunk) {
            const limit = Math.min(chunk, pages * 100 - offset);
            const rows = await cached(p, 'backlinks', { target, targetType: o.targetType, limit, offset, followOnly: o.followOnly, status: o.backlinkStatus, onePerDomain: o.onePerDomain });
            out.push(...rows);
            if (rows.length < limit) break;
        }
        return out;
    });
    let n = 0;
    const seen = new Set();
    for (const b of result) {
        const key = `${b.sourceUrl}|${b.targetUrl}|${b.anchor}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (o.onePerDomain && source === 'semrush_api') { // Semrush has no "one per domain" switch: keep the best link per referring domain
            const host = (() => {
                try {
                    return new URL(b.sourceUrl).hostname.replace(/^www\./, '');
                } catch {
                    return b.sourceUrl;
                }
            })();
            if (seen.has(`host:${host}`)) continue;
            seen.add(`host:${host}`);
        }
        if (await save(backlinkRow(b, { query: target, targetType: o.targetType, source }), true)) n += 1;
        if (stopReason) break;
    }
    return n;
}

async function publicReport(domain) {
    const session = new Session();
    const res = await web.fetch({ url: publicUrl(domain), headers: HTML_HEADERS, attempts: 6 }, session);
    if (res.status === 404) return null;
    const data = res.status === 200 ? pageData(res.body) : null;
    if (!data) return null;
    stats.publicPages += 1;
    return domainFromPage(data);
}

async function domainQuery(domain) {
    let report = null;
    let source = null;
    if (o.domainSource !== 'api') {
        try {
            report = await publicReport(domain);
            if (report) source = 'semrush_public_page';
            else stats.publicPagesMissing += 1;
        } catch (err) {
            if (err instanceof StoppedError) throw err;
            log.warning(`Public page for ${domain} failed: ${err.message}`);
        }
    }
    if (!report && o.domainSource !== 'public' && providers.length) {
        const r = await withProvider((p) => cached(p, 'domain', { domain, db: o.db }));
        report = r.result;
        source = r.source;
    }
    if (!report) {
        const why = o.domainSource === 'public' || !providers.length ? 'Semrush has no free public page for this domain (only popular sites have one)' : 'No data for this domain in the selected database';
        await errorRow(domain, why, 'NO_DATA');
        return 0;
    }
    const row = { mode: 'domain', query: domain, domain, ...report, source };
    return (await save(row, true)) ? 1 : 0;
}

const handlers = { keyword: keywordQuery, competitors: competitorsQuery, backlinks: backlinksQuery, domain: domainQuery };

// ---------- Run ----------
let next = 0;
let done = 0;
async function worker() {
    while (!stopReason && next < o.queries.length) {
        const q = o.queries[next++];
        if (msLeft() <= 0) break;
        try {
            const n = await handlers[o.mode](q);
            if (n > 0) summary.queriesWithResults += 1;
            else if (n === 0 && !stopReason) {
                summary.queriesEmpty += 1;
                if (o.mode !== 'domain') await errorRow(q, o.filter.active && o.mode === 'keyword' ? 'No results matched your filters' : 'No results found', 'NO_RESULTS');
            }
        } catch (err) {
            if (err instanceof StoppedError) break;
            summary.queriesFailed += 1;
            const msg = err instanceof BlockedError ? `Semrush refused the request: ${err.message}` : err.message;
            log.warning(`"${q}" failed: ${msg}`);
            await errorRow(q, msg, err.kind === 'down' ? 'SOURCE_UNAVAILABLE' : err.kind === 'unsupported' ? 'NOT_AVAILABLE' : 'QUERY_FAILED');
        }
        done += 1;
        if (done % 5 === 0 || done === o.queries.length) await Actor.setStatusMessage(`${done}/${o.queries.length} queries, ${saved} results`);
    }
}
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, o.queries.length) }, worker));
await chain;

// ---------- Summary ----------
stop(pageBudgetHit ? 'page_budget_reached' : 'completed');
summary.stopReason = stopReason;
summary.finishedAt = new Date().toISOString();
summary.durationSec = Math.round((Date.now() - startedAt) / 1000);
summary.fillRates = Object.fromEntries(Object.entries(filled).map(([k, n]) => [k, summary.rows ? `${Math.round((n / summary.rows) * 100)}%` : '0%']));
summary.sources = {
    semrushApi: semrush.configured ? { calls: stats.semrushCalls, estimatedUnits: stats.semrushUnits, status: semrush.down ?? 'ok' } : 'not configured',
    dataforseo: dfs.configured ? { calls: stats.dataforseoCalls, costUsd: Math.round(stats.dataforseoCost * 10000) / 10000, rateLimited: stats.dataforseoRateLimited, status: dfs.down ?? dfs.backlinksDown ?? 'ok' } : 'not configured',
    publicPages: o.mode === 'domain' ? { found: stats.publicPages, missing: stats.publicPagesMissing, requests: stats.requests, blocked: stats.blocked } : undefined,
    cacheHits: stats.cacheHits,
};
summary.routes = o.mode === 'domain' ? web.routesSummary() : [];
await Actor.setValue('RUN_SUMMARY', summary);
const msg = `${summary.rows} results from ${summary.queriesWithResults}/${o.queries.length} queries${summary.queriesFailed ? `, ${summary.queriesFailed} failed (not charged)` : ''}${summary.skippedByFilters ? `, ${summary.skippedByFilters} filtered out` : ''}. Stop reason: ${summary.stopReason}.`;
log.info(msg);
await Actor.setStatusMessage(msg, { isStatusMessageTerminal: true });
if (!summary.rows && summary.queriesFailed === o.queries.length) await Actor.fail(`All queries failed. ${msg}`);
else await Actor.exit();
