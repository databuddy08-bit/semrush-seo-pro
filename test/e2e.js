// End-to-end tests: the real actor against fake Semrush / DataForSEO / public pages. `npm run test:e2e [scenario...]`
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { startMocks } from './mock-apis.js';

const ROOT = new URL('..', import.meta.url).pathname;
const PRICE = (p) => JSON.stringify({ pricingModel: 'PAY_PER_EVENT', pricingPerEvent: { actorChargeEvents: { keyword: { eventPriceUsd: p, eventTitle: 'k' }, competitor: { eventPriceUsd: p, eventTitle: 'c' }, backlink: { eventPriceUsd: p, eventTitle: 'b' }, 'domain-report': { eventPriceUsd: p * 5, eventTitle: 'd' } } } });
const readDir = (d) => (existsSync(d) ? readdirSync(d).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(readFileSync(join(d, f), 'utf8'))) : []);

let mock;
async function run(name, input, env = {}, { keep = false } = {}) {
    const dir = join(ROOT, 'storage-test', name);
    if (!keep) rmSync(dir, { recursive: true, force: true });
    rmSync(join(dir, 'datasets'), { recursive: true, force: true });
    rmSync(join(dir, 'key_value_stores', 'default'), { recursive: true, force: true });
    mkdirSync(join(dir, 'key_value_stores', 'default'), { recursive: true });
    writeFileSync(join(dir, 'key_value_stores', 'default', 'INPUT.json'), JSON.stringify(input));
    const child = spawn('node', ['src/main.js'], {
        cwd: ROOT,
        env: {
            ...process.env, HTTPS_PROXY: '', HTTP_PROXY: '', https_proxy: '', http_proxy: '', APIFY_PROXY_PASSWORD: '',
            SEMRUSH_API_BASE: mock.semrush, DATAFORSEO_BASE: mock.dfs, SEMRUSH_WEB_BASE: mock.pages, HTTP_RATE_SCALE: '100', HTTP_BACKOFF_SCALE: '0.01',
            SEMRUSH_API_KEY: 'good', DATAFORSEO_LOGIN: 'user', DATAFORSEO_PASSWORD: 'pw',
            CRAWLEE_STORAGE_DIR: dir, APIFY_LOCAL_STORAGE_DIR: dir, CRAWLEE_PURGE_ON_START: '0',
            ACTOR_TEST_PAY_PER_EVENT: 'true', ACTOR_USE_CHARGING_LOG_DATASET: 'true', APIFY_ACTOR_PRICING_INFO: PRICE(0.002), APIFY_CHARGED_ACTOR_EVENT_COUNTS: '{}',
            ...env,
        },
    });
    let logs = '';
    child.stdout.on('data', (d) => { logs += d; });
    child.stderr.on('data', (d) => { logs += d; });
    const code = await new Promise((r) => child.on('close', r));
    const rows = readDir(join(dir, 'datasets', 'default'));
    const charges = readDir(join(dir, 'datasets', 'charging_log'));
    const charged = charges.reduce((s, c) => s + (c.chargedCount ?? 1), 0);
    const sf = join(dir, 'key_value_stores', 'default', 'RUN_SUMMARY.json');
    return { code, rows, data: rows.filter((r) => !r.error), errors: rows.filter((r) => r.error), charged, events: [...new Set(charges.map((c) => c.eventName))], summary: existsSync(sf) ? JSON.parse(readFileSync(sf, 'utf8')) : null, logs };
}
const results = [];
const check = (label, pass, detail = '') => {
    results.push(Boolean(pass));
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};
const only = process.argv.slice(2);
const want = (s) => !only.length || only.includes(s);
mock = await startMocks();

if (want('keyword')) {
    console.log('\n=== 1. KEYWORD MODE via the Semrush API ===');
    const r = await run('keyword', { mode: 'keyword', queries: ['running shoes', 'Running  Shoes', 'nothing found'], db: 'uk', type: 'phrase', pages: 3, includeSeed: true, maxDifficulty: 80 });
    const seed = r.data.find((x) => x.is_seed);
    const ideas = r.data.filter((x) => !x.is_seed && x.query === 'running shoes');
    check('duplicate query removed; seed keyword row first', r.summary.queries === 2 && seed?.phrase === 'running shoes' && seed.volume === 246000 && seed.difficulty === 71);
    check('original fields: phrase, database, volume, cpc, competition_level, difficulty, intents, results, serp_features, trend', ideas[0].database === 'uk' && typeof ideas[0].volume === 'number' && Array.isArray(ideas[0].intents) && Array.isArray(ideas[0].serp_features) && ideas[0].trend.length === 12 && ideas[0].trend.every((v) => v >= 0 && v <= 100));
    check('trend 0.81 -> 81 (0–100 scale) and intent labels added', seed.trend[0] === 81 && seed.trend[10] === 100 && seed.intent_labels[0] === 'navigational');
    check('phrase match: every idea contains all seed words; max difficulty respected', ideas.every((x) => /running/.test(x.phrase) && /shoes/.test(x.phrase) && x.difficulty <= 80), `${ideas.length} ideas`);
    check('";" inside a keyword kept intact', ideas.some((x) => x.phrase === 'running shoes; weird'));
    check('nothing found: free row, run continues', r.errors.some((e) => e.query === 'nothing found' && e.errorCode === 'NO_RESULTS'));
    check('charged once per keyword row (event "keyword")', r.charged === r.data.length && r.events.join() === 'keyword', `${r.charged} charged / ${r.data.length} rows`);
    check('server-side filters used (fewer Semrush units)', /Kd%7CLt|Kd\|Lt/.test(r.logs) || r.summary.sources.semrushApi.estimatedUnits <= r.data.length * 20 + 10, JSON.stringify(r.summary.sources.semrushApi));
}

if (want('oldplan')) {
    console.log('\n=== 2. Semrush plan without Kd/In columns -> difficulty fetched separately ===');
    const r = await run('oldplan', { mode: 'keyword', q: 'trail shoes', pages: 1 }, { SEMRUSH_API_KEY: 'oldplan' });
    check('rows still have difficulty (phrase_kdi)', r.data.length === 100 && r.data.every((x) => x.difficulty !== null) && mock.hits.semrush.phrase_kdi >= 1, `${r.data.length} rows`);
}

if (want('dfs')) {
    console.log('\n=== 3. KEYWORD MODE via DataForSEO (related + questions) ===');
    const r = await run('dfs', { mode: 'keyword', q: 'seo tools', type: 'related', pages: 1, dataSource: 'dataforseo' });
    const k = r.data[0];
    check('same row shape from DataForSEO: monthly trend, snapshot date, SERP feature names, intents', r.data.length === 70 && k.source === 'dataforseo' && k.trend.length === 12 && k.monthly_searches[0].month === '2025-10' && k.snapshot_date === '20261020' && k.serp_feature_names.includes('people_also_ask') && k.intents.length >= 1 && k.related_depth >= 1);
    const q = await run('dfs-min', { mode: 'keyword', q: 'seo tools', minVolume: 5000, dataSource: 'dataforseo' });
    check('min volume filter applied (server + local)', q.data.length > 0 && q.data.every((x) => x.volume >= 5000), `${q.data.length} rows`);
}

if (want('fallback')) {
    console.log('\n=== 4. AUTO SOURCE: Semrush key rejected -> DataForSEO ===');
    const r = await run('fallback', { mode: 'keyword', queries: ['crm software', 'email marketing'] }, { SEMRUSH_API_KEY: 'bad' });
    check('all rows from DataForSEO, both queries answered', r.data.length === 200 && r.data.every((x) => x.source === 'dataforseo') && r.summary.queriesWithResults === 2, JSON.stringify(r.summary.rowsBySource));
    check('Semrush tried only once (marked down)', (mock.hits.semrush.phrase_fullsearch ?? 0) >= 1 && r.summary.sources.semrushApi.status.includes('WRONG KEY'));
}

if (want('competitors')) {
    console.log('\n=== 5. COMPETITORS ===');
    const r = await run('competitors', { mode: 'competitors', queries: ['nike.com', 'https://www.adidas.com/us'], db: 'us', sort_by: 'traffic' });
    const n = r.data.filter((x) => x.query === 'nike.com');
    check('original fields + sorted by traffic', n.length === 30 && n[0].domain === 'comp7.com' && n[0].rank === 1 && 'common_keywords' in n[0] && 'se_keywords' in n[0] && 'traffic_cost' in n[0] && 'paid_keywords' in n[0]);
    check('URL input cleaned to adidas.com; event "competitor"', r.data.some((x) => x.query === 'adidas.com') && r.events.join() === 'competitor');
    const d = await run('competitors-dfs', { mode: 'competitors', q: 'nike.com', dataSource: 'dataforseo', pages: 1 });
    check('DataForSEO: own domain removed, level = shared keywords / own keywords', d.data.length === 40 && !d.data.some((x) => x.domain === 'nike.com') && d.data[0].competition_level === 0.4 && d.data[0].common_keywords === 4000);
}

if (want('backlinks')) {
    console.log('\n=== 6. BACKLINKS ===');
    const r = await run('backlinks', { mode: 'backlinks', q: 'example.com', pages: 1, onePerDomain: true });
    const b = r.data[0];
    check('original fields + extras; ";" in title kept', b.page_ascore === 90 && b.source_title === 'Best; tools of the year' && b.target_anchor === 'anchor 0' && b.first_seen === 1718236800 && b.first_seen_date === '2024-06-13' && b.source_domain === 'site0.org' && b.nofollow === true);
    check('one link per referring domain', r.data.length === 60 && new Set(r.data.map((x) => x.source_domain)).size === 60);
    const d = await run('backlinks-nosub', { mode: 'backlinks', q: 'example.com', pages: 1, dataSource: 'auto' }, { SEMRUSH_API_KEY: '', DATAFORSEO_LOGIN: 'nobl' });
    check('DataForSEO without Backlinks subscription -> free NOT_AVAILABLE row, nothing charged', d.data.length === 0 && d.errors[0]?.errorCode === 'NOT_AVAILABLE' && d.charged === 0);
    const f = await run('backlinks-fallback', { mode: 'backlinks', target: 'https://example.com/page' }, { DATAFORSEO_LOGIN: 'nobl', SEMRUSH_API_KEY: 'good' });
    check('target URL works (target_type url)', f.data.length === 100 && f.data[0].target_type === 'url');
    const g = await run('backlinks-dfs', { mode: 'backlinks', q: 'example.com', followOnly: true, dataSource: 'dataforseo' });
    check('DataForSEO backlinks mapped (rank, dates, spam score)', g.data.length > 0 && g.data[0].page_ascore === 80 && g.data[0].first_seen_date === '2024-01-02' && g.data[0].spam_score === 3);
}

if (want('domain')) {
    console.log('\n=== 7. DOMAIN MODE ===');
    const r = await run('domain', { mode: 'domain', queries: ['nike.com', 'apify.com'] });
    const n = r.data.find((x) => x.query === 'nike.com');
    const a = r.data.find((x) => x.query === 'apify.com');
    check('public page: authority score, backlinks, traffic history, top keywords, competitors, AI traffic', n.source === 'semrush_public_page' && n.authority_score === 99 && n.number_of_backlinks > 1e6 && Object.keys(n.search_traffic).length === 6 && n.top_keywords[0].phrase === 'nike' && n.competitors.length === 3 && n.ai_traffic.length > 0 && n.traffic_by_country.length > 0);
    check('no public page -> API report (Semrush)', a.source === 'semrush_api' && a.authority_score === 44 && a.organic_traffic === 15000 && a.top_keywords[0].traffic_percent === 12.5 && a.search_traffic['2026-09-15'] === 15000);
    check('event "domain-report", charged 2', r.charged === 2 && r.events.join() === 'domain-report');
    const p = await run('domain-public', { mode: 'domain', queries: ['nike.com', 'tiny-site.dev'], domainSource: 'public' }, { SEMRUSH_API_KEY: '', DATAFORSEO_LOGIN: '' });
    check('no keys at all: domain mode still works; missing page = free NO_DATA row', p.code === 0 && p.data.length === 1 && p.errors[0]?.errorCode === 'NO_DATA' && p.charged === 1);
    const d = await run('domain-dfs', { mode: 'domain', q: 'apify.com', domainSource: 'api', dataSource: 'dataforseo' });
    check('DataForSEO domain report', d.data[0]?.source === 'dataforseo' && d.data[0].authority_score === 61 && d.data[0].organic_traffic === 12346 && d.data[0].top_keywords[0].traffic_percent === 25 && d.data[0].competitors.length === 10);
}

if (want('limits')) {
    console.log('\n=== 8. LIMITS, CACHE, INPUT ERRORS ===');
    const none = await run('nosource', { mode: 'keyword', q: 'x' }, { SEMRUSH_API_KEY: '', DATAFORSEO_LOGIN: '' });
    check('no data source -> clear failure + log of missing variables', none.code !== 0 && none.rows[0]?.errorCode === 'NO_DATA_SOURCE' && /SEMRUSH_API_KEY/.test(none.logs));
    const bad = await run('badmode', { mode: 'keywords', q: 'x' });
    check('unknown mode -> INVALID_INPUT', bad.code !== 0 && bad.rows[0]?.errorCode === 'INVALID_INPUT');
    const baddb = await run('baddb', { mode: 'keyword', q: 'x', db: 'zz' });
    check('unknown database -> INVALID_INPUT', baddb.code !== 0 && /Unknown database/.test(baddb.rows[0]?.error));
    const budget = await run('budget', { mode: 'keyword', queries: ['a shoes', 'b shoes', 'c shoes'], pages: 2 }, { MAX_PAGES_PER_RUN: '3' });
    check('page budget per run (3 pages = 300 rows max)', budget.data.length <= 300 && budget.errors.some((e) => e.errorCode === 'PAGE_BUDGET') && budget.summary.stopReason === 'page_budget_reached', `${budget.data.length} rows`);
    const cost = await run('maxcost', { mode: 'keyword', q: 'hiking boots' }, { ACTOR_MAX_TOTAL_CHARGE_USD: '5', APIFY_ACTOR_PRICING_INFO: PRICE(1) });
    check('max cost per run respected ($1 per row, $5 limit)', cost.charged === 5 && cost.summary.stopReason === 'max_cost_per_run_reached', `${cost.charged} charged`);
    const items = await run('maxitems', { mode: 'competitors', q: 'nike.com', maxItems: 7 });
    check('max results', items.data.length === 7 && items.charged === 7);
    const before = mock.hits.semrush.phrase_fullsearch ?? 0;
    await run('cache', { mode: 'keyword', q: 'yoga mats' });
    const mid = mock.hits.semrush.phrase_fullsearch ?? 0;
    const again = await run('cache', { mode: 'keyword', q: 'yoga mats' }, {}, { keep: true });
    check('second identical run served from cache (no API call), still charged per row', mid === before + 1 && (mock.hits.semrush.phrase_fullsearch ?? 0) === mid && again.summary.sources.cacheHits === 1 && again.charged === 100);
    const url = await run('badurl', { mode: 'backlinks', q: 'example.com', target_type: 'url' });
    check('target type url needs a full URL', url.code !== 0 && /full URL/.test(url.rows[0]?.error));
}

mock.close();
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
