// Unit tests: parsers and mappers. `npm test`
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseTable, displayFilter, SemrushApi } from '../src/semrush.js';
import { DataForSeo } from '../src/dataforseo.js';
import { resolveDb } from '../src/dbs.js';
import { pageData, domainFromPage, decodeIsland } from '../src/publicpage.js';
import { monthlyTrend, semrushTrend, codeList, cleanDomain, makeKeywordFilter, keywordRow, unix, yyyymmdd } from '../src/rows.js';

test('Semrush text tables, including ";" inside a text column', () => {
    const t = 'Keyword;Search Volume\r\nrunning shoes;246000\r\nshoes; cheap;10\r\n';
    assert.deepEqual(parseTable(t, ['Ph', 'Nq']), [{ Ph: 'running shoes', Nq: '246000' }, { Ph: 'shoes; cheap', Nq: '10' }]);
    const b = 'page_ascore;source_title;source_url\n54;A; B; C;https://x.org';
    assert.equal(parseTable(b, ['page_ascore', 'source_title', 'source_url'], 1)[0].source_title, 'A; B; C');
    assert.deepEqual(parseTable('', ['Ph']), []);
    assert.equal(displayFilter([['+', 'Ph', 'Co', 'seo'], ['-', 'Ph', 'Co', 'free'], ['+', 'type', '', 'follow']]), '+|Ph|Co|seo|-|Ph|Co|free|+|type||follow');
});

test('Semrush keyword mapping', () => {
    const k = new SemrushApi({ key: 'x', stats: {} }).mapKeyword({ Ph: 'running shoes', Nq: '246000', Cp: '0.88', Co: '1', Kd: '71', In: '2', Nr: '238', Fk: '3,6,9', Td: '0.81,1.00' });
    assert.deepEqual(k.intents, [2]);
    assert.deepEqual(k.serpFeatures, [3, 6, 9]);
    assert.deepEqual(k.trend, [81, 100]);
    assert.equal(k.difficulty, 71);
    const row = keywordRow(k, { query: 'running shoes', db: resolveDb('us'), matchType: 'phrase', source: 'semrush_api' });
    assert.deepEqual(row.intent_labels, ['navigational']);
    assert.equal(row.word_count, 2);
});

test('databases: Semrush codes, names, DataForSEO location codes and languages', () => {
    assert.deepEqual(resolveDb('uk'), { db: 'uk', iso: 'GB', location_code: 2826, name: 'United Kingdom', language: 'en', listed: true });
    assert.equal(resolveDb('United_States').location_code, 2840);
    assert.equal(resolveDb('de').language, 'de');
    assert.equal(resolveDb('').db, 'us');
    assert.equal(resolveDb('jp', 'en').language, 'en');
    assert.equal(resolveDb('ke').listed, false);
    assert.throws(() => resolveDb('zz'), /Unknown database/);
});

test('DataForSEO keyword mapping (intents to Semrush codes, monthly trend oldest→newest)', () => {
    const k = new DataForSeo({ stats: {} }).mapKeyword({
        keyword: 'seo tools',
        keyword_info: { search_volume: 1000, cpc: 3.1, competition: 0.4, last_updated_time: '2026-10-20 03:43:39 +00:00', monthly_searches: [{ year: 2026, month: 9, search_volume: 200 }, { year: 2026, month: 8, search_volume: 100 }] },
        keyword_properties: { keyword_difficulty: 55 },
        serp_info: { se_results_count: 999, serp_item_types: ['organic', 'people_also_ask'] },
        search_intent_info: { main_intent: 'commercial', foreign_intent: ['transactional', 'commercial'] },
    });
    assert.deepEqual(k.intents, [0, 3]);
    assert.deepEqual(k.trend, [50, 100]);
    assert.deepEqual(k.monthly, [{ month: '2026-08', volume: 100 }, { month: '2026-09', volume: 200 }]);
    assert.equal(k.snapshotDate, '20261020');
    assert.equal(k.serpFeatures, null);
});

test('small helpers', () => {
    assert.deepEqual(semrushTrend(''), null);
    assert.deepEqual(codeList('0,2'), [0, 2]);
    assert.deepEqual(codeList(''), []);
    assert.equal(cleanDomain('https://www.Nike.com/en/x?y=1'), 'nike.com');
    assert.equal(cleanDomain('blog.example.org'), 'blog.example.org');
    assert.equal(cleanDomain(''), '');
    assert.equal(unix('1718236800'), 1718236800);
    assert.equal(unix('2024-01-02 10:00:00 +00:00'), 1704189600);
    assert.equal(yyyymmdd('2026-09-20 03:43:39 +00:00'), '20260920');
    assert.deepEqual(monthlyTrend([]), { trend: null, monthly: null });
});

test('keyword filters', () => {
    const f = makeKeywordFilter({ minVolume: 100, maxDifficulty: 50, excludeWords: 'free, cheap', includeWords: ['best', 'top'], intents: ['commercial'] });
    const base = { phrase: 'best seo tools', volume: 500, difficulty: 40, cpc: 1, intents: [0] };
    assert.equal(f.active, true);
    assert.equal(f.reject(base), null);
    assert.equal(f.reject({ ...base, volume: 50 }), 'volume_below_minimum');
    assert.equal(f.reject({ ...base, difficulty: null }), 'difficulty_above_maximum');
    assert.equal(f.reject({ ...base, phrase: 'best free seo tools' }), 'contains_excluded_word');
    assert.equal(f.reject({ ...base, phrase: 'seo tools' }), 'missing_included_word');
    assert.equal(f.reject({ ...base, intents: [1] }), 'intent_not_selected');
    assert.equal(makeKeywordFilter({}).active, false);
});

test('public domain page (real nike.com page)', () => {
    assert.deepEqual(decodeIsland([1, [[0, 1], [0, { a: [0, 'x'] }]]]), [1, { a: 'x' }]);
    const d = pageData(readFileSync(new URL('fixtures/page-nike.html', import.meta.url), 'utf8'));
    assert.ok(d);
    const r = domainFromPage(d);
    assert.equal(r.database, 'us');
    assert.equal(r.authority_score, 99);
    assert.ok(r.number_of_backlinks > 1e7 && r.referring_domains_count > 1e5);
    assert.equal(Object.keys(r.search_traffic).length, 6);
    assert.ok(r.search_traffic_history[0].date < r.search_traffic_history.at(-1).date, 'oldest first');
    assert.equal(r.top_keywords[0].phrase, 'nike');
    assert.deepEqual(r.top_keywords[0].intents, [0, 2]);
    assert.ok(r.top_keywords[0].traffic_percent > 0);
    assert.equal(r.competitors.length, 3);
    assert.ok(r.competitors[0].level > 0 && r.competitors[0].visits > 0);
    assert.ok(r.ai_traffic.some((a) => a.assistant === 'ChatGPT'));
    assert.ok(r.bounce_rate_pct > 0 && r.bounce_rate_pct < 100);
    assert.equal(pageData('<html>404</html>'), null);
});
