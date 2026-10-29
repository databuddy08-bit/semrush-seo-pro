// Fake Semrush API, DataForSEO API and Semrush public pages (response shapes follow the real services).
import http from 'node:http';
import { readFileSync } from 'node:fs';

const NIKE = readFileSync(new URL('fixtures/page-nike.html', import.meta.url), 'utf8');
const hash = (s) => [...String(s)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
const WORDS = ['best', 'cheap', 'for women', 'for men', 'near me', 'sale', 'reviews', 'trail', 'waterproof', 'wide', 'kids', 'brands', 'nike', 'adidas', 'how to choose', 'what are', 'vs', 'store', 'online', '2026'];

/** Deterministic keyword universe for a seed: 250 ideas, all containing the seed words. */
function ideas(seed) {
    const out = [];
    for (let i = 0; out.length < 250; i++) {
        const w = WORDS[i % WORDS.length];
        const w2 = WORDS[(i * 7 + 3) % WORDS.length];
        const kw = i < WORDS.length ? (i % 3 === 0 ? `${w} ${seed}` : `${seed} ${w}`) : `${w} ${seed} ${w2} ${i}`;
        const h = hash(kw);
        out.push({ kw, nq: 10 + (h % 50000), cp: (h % 300) / 100, co: (h % 100) / 100, kd: h % 101, in: [h % 4, (h >> 3) % 4].filter((x, j, a) => a.indexOf(x) === j).join(','), nr: h % 1000000, fk: [3, 6, 11, 21].filter((x) => (h >> x) & 1).join(','), td: Array.from({ length: 12 }, (_, m) => ((h >> m) % 100) / 100).join(',') });
    }
    out.push({ kw: `${seed}; weird`, nq: 5, cp: 0, co: 0, kd: 1, in: '', nr: 1, fk: '', td: '' });
    return out.sort((a, b) => b.nq - a.nq);
}

function semrushFilter(rows, f) {
    if (!f) return rows;
    const p = f.split('|');
    const conds = [];
    for (let i = 0; i + 3 < p.length + 1; i += 4) conds.push(p.slice(i, i + 4));
    return rows.filter((r) => conds.every(([sign, col, op, val]) => {
        const field = { Ph: r.kw, Nq: r.nq, Kd: r.kd }[col];
        let ok = true;
        if (op === 'Co') ok = String(field).toLowerCase().includes(val.toLowerCase());
        if (op === 'Gt') ok = field > Number(val);
        if (op === 'Lt') ok = field < Number(val);
        return sign === '-' ? !ok : ok;
    }));
}

export async function startMocks() {
    const hits = { semrush: {}, dfs: {}, pages: 0, semrushKeys: new Set() };
    const count = (o, k) => { o[k] = (o[k] ?? 0) + 1; };

    // ---------- Semrush API ----------
    const semrush = http.createServer((req, res) => {
        const u = new URL(req.url, 'http://x');
        const q = Object.fromEntries(u.searchParams);
        const send = (t) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(t); };
        count(hits.semrush, q.type);
        hits.semrushKeys.add(q.key);
        if (q.key === 'bad') return send('ERROR 120 :: WRONG KEY - ID PAIR');
        if (q.key === 'empty') return send('ERROR 132 :: API UNITS BALANCE IS ZERO');
        const cols = (q.export_columns ?? '').split(',');
        if (q.key === 'oldplan' && (cols.includes('Kd') || cols.includes('In')) && q.type !== 'phrase_kdi') return send('ERROR 136 :: WRONG EXPORT COLUMNS');
        const end = Number(q.display_limit || 10000);
        const off = Number(q.display_offset || 0);
        const table = (head, rows) => send([head.join(';'), ...rows.map((r) => r.join(';'))].join('\r\n'));
        const kwCell = (r, c) => ({ Ph: r.kw, Nq: r.nq, Cp: r.cp, Co: r.co, Kd: r.kd, In: r.in, Nr: r.nr, Fk: r.fk, Td: r.td }[c]);
        if (['phrase_fullsearch', 'phrase_related', 'phrase_questions'].includes(q.type)) {
            if (q.phrase === 'nothing found') return send('ERROR 50 :: NOTHING FOUND');
            let rows = ideas(q.phrase);
            if (q.type === 'phrase_questions') rows = rows.filter((r) => /^(how|what)/.test(r.kw));
            rows = semrushFilter(rows, q.display_filter).slice(off, end);
            return table(cols, rows.map((r) => cols.map((c) => kwCell(r, c))));
        }
        if (q.type === 'phrase_this' && q.phrase === 'nothing found') return send('ERROR 50 :: NOTHING FOUND');
        if (q.type === 'phrase_this') return table(cols, [cols.map((c) => kwCell({ kw: q.phrase, nq: 246000, cp: 0.88, co: 1, kd: 71, in: '2', nr: 238, fk: '3,6,9', td: '0.81,0.44,0.66,0.66,0.54,0.66,0.44,0.54,0.44,0.81,1.00,0.81' }, c))]);
        if (q.type === 'phrase_kdi') return table(['Keyword', 'Keyword Difficulty Index'], q.phrase.split(';').map((p) => [p, hash(p) % 101]));
        if (q.type === 'domain_organic_organic') {
            const all = Array.from({ length: 30 }, (_, i) => [`comp${i}.com`, (0.9 - i * 0.02).toFixed(2), 5000 - i * 100, 20000 + (hash(i) % 9000), 100000 - i * 1000 + (i === 7 ? 500000 : 0), 50000, i]);
            return table(cols, all.slice(off, end));
        }
        if (q.type === 'backlinks') {
            const all = Array.from({ length: 150 }, (_, i) => [90 - (i % 50), i === 0 ? 'Best; tools of the year' : `Page ${i}`, `https://site${i % 60}.org/p${i}`, `https://${q.target}/`, `anchor ${i}`, 37, 112, 1718236800 + i, 1727222400, i % 5 === 0 ? 'true' : 'false', 'false', 'false', 'false', 'false', 'false', 'false']);
            return table(cols, all.slice(off, end));
        }
        if (q.type === 'backlinks_overview') return table(cols, [[44, 9999, 321]]);
        if (q.type === 'domain_rank') return table(cols, [[q.domain, 12345, 800, 15000, 9000, 12, 300, 200]]);
        if (q.type === 'domain_rank_history') return table(cols, [['20260915', 800, 15000, 12, 300], ['20260815', 780, 14000, 10, 250]]);
        if (q.type === 'domain_organic') return table(cols, [['apify scraper', 1, 5400, 1.2, 'https://apify.com/', 12.5, '1']]);
        return send('ERROR 40 :: MANDATORY PARAMETER "type" NOT SET');
    });

    // ---------- DataForSEO ----------
    const kwItem = (k, i) => {
        const h = hash(k);
        return {
            keyword: k,
            keyword_info: { last_updated_time: '2026-10-20 03:43:39 +00:00', competition: (h % 100) / 100, cpc: (h % 400) / 100, search_volume: 100 + (h % 9000) - i, monthly_searches: Array.from({ length: 12 }, (_, m) => ({ year: m < 9 ? 2026 : 2025, month: m < 9 ? 9 - m : 21 - m, search_volume: 100 * (1 + ((h >> m) % 9)) })) },
            keyword_properties: { keyword_difficulty: h % 100 },
            serp_info: { se_results_count: h % 5000000, serp_item_types: ['organic', 'people_also_ask', 'images'] },
            search_intent_info: { main_intent: ['informational', 'commercial', 'transactional', 'navigational'][h % 4], foreign_intent: h % 2 ? ['commercial'] : null },
        };
    };
    const dfs = http.createServer(async (req, res) => {
        let body = '';
        for await (const c of req) body += c;
        const path = new URL(req.url, 'http://x').pathname;
        count(hits.dfs, path.replace('/v3/', ''));
        const login = Buffer.from(String(req.headers.authorization ?? '').replace('Basic ', ''), 'base64').toString().split(':')[0];
        const out = (code, msg, result, cost = 0.01) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ status_code: 20000, tasks: [{ status_code: code, status_message: msg, cost, result }] })); };
        if (login === 'wrong') { res.writeHead(401, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ status_code: 40100, status_message: 'You are not authorized' })); }
        const t = JSON.parse(body)[0];
        if (path.startsWith('/v3/backlinks/') && login === 'nobl') return out(40204, 'Access denied. Visit Plans and Subscriptions to activate your subscription and get access to this API', null, 0);
        const lim = t.limit ?? 100;
        const off = t.offset ?? 0;
        const minVol = (t.filters ?? []).find((f) => Array.isArray(f) && /search_volume$/.test(f[0]) && f[1] === '>=')?.[2] ?? 0;
        if (path.endsWith('/keyword_suggestions/live') || path.endsWith('/keyword_ideas/live')) {
            const seed = t.keyword ?? t.keywords[0];
            const items = Array.from({ length: 180 }, (_, i) => kwItem(`${seed} idea ${i}`, i)).filter((x) => x.keyword_info.search_volume >= minVol);
            return out(20000, 'Ok.', [{ items: items.slice(off, off + lim) }]);
        }
        if (path.endsWith('/related_keywords/live')) {
            const items = Array.from({ length: 70 }, (_, i) => ({ depth: i < 8 ? 1 : 2, keyword_data: kwItem(`${t.keyword} related ${i}`, i) }));
            return out(20000, 'Ok.', [{ items: items.slice(off, off + lim) }]);
        }
        if (path.endsWith('/keyword_overview/live')) return out(20000, 'Ok.', [{ items: [kwItem(t.keywords[0], 0)] }]);
        if (path.endsWith('/competitors_domain/live')) {
            const items = [{ domain: t.target, intersections: 10000, full_domain_metrics: { organic: { count: 10000, etv: 50000 } } }, ...Array.from({ length: 40 }, (_, i) => ({ domain: `rival${i}.com`, intersections: 4000 - i * 50, full_domain_metrics: { organic: { count: 20000 - i, etv: 1000 * (i === 5 ? 999 : 40 - i), estimated_paid_traffic_cost: 777 }, paid: { count: 3 } } }))];
            return out(20000, 'Ok.', [{ items: items.slice(0, lim) }]);
        }
        if (path.endsWith('/backlinks/backlinks/live')) {
            const items = Array.from({ length: 120 }, (_, i) => ({ type: 'backlink', domain_from: `ref${i}.net`, url_from: `https://ref${i}.net/a`, url_to: `https://${t.target}/`, page_from_rank: 80 - (i % 40), page_from_title: `Ref ${i}`, page_from_external_links: 5, page_from_internal_links: 9, anchor: `a${i}`, dofollow: i % 3 !== 0, item_type: 'anchor', first_seen: '2024-01-02 10:00:00 +00:00', last_seen: '2026-10-01 10:00:00 +00:00', is_new: false, is_lost: false, backlink_spam_score: 3 }));
            return out(20000, 'Ok.', [{ items: items.slice(off, off + lim) }], 0.02);
        }
        if (path.endsWith('/domain_rank_overview/live')) return out(20000, 'Ok.', t.target === 'unknown-site.io' ? [{ items: [] }] : [{ items: [{ metrics: { organic: { count: 900, etv: 12345.6, estimated_paid_traffic_cost: 4000 }, paid: { count: 4, etv: 50 } } }] }]);
        if (path.endsWith('/ranked_keywords/live')) return out(20000, 'Ok.', [{ metrics: { organic: { etv: 1000 } }, items: [{ keyword_data: { keyword: 'apify', keyword_info: { search_volume: 9900, cpc: 2 }, search_intent_info: { main_intent: 'navigational' } }, ranked_serp_element: { serp_item: { rank_group: 1, url: 'https://apify.com/', etv: 250 } } }] }]);
        if (path.endsWith('/historical_rank_overview/live')) return out(20000, 'Ok.', [{ items: [{ year: 2026, month: 9, metrics: { organic: { etv: 12000, count: 900 }, paid: { etv: 40 } } }, { year: 2026, month: 8, metrics: { organic: { etv: 11000, count: 850 } } }] }]);
        if (path.endsWith('/backlinks/summary/live')) return out(20000, 'Ok.', [{ rank: 61, backlinks: 54321, referring_domains: 1234 }]);
        return out(40400, 'Not Found.', null);
    });

    // ---------- public pages ----------
    const pages = http.createServer((req, res) => {
        hits.pages += 1;
        const m = req.url.match(/^\/website\/([^/]+)\/overview\/$/);
        if (m && decodeURIComponent(m[1]) === 'nike.com') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(NIKE); }
        res.writeHead(404, { 'content-type': 'text/html' });
        res.end('<html>Page not found</html>');
    });

    const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${s.address().port}`)));
    return { semrush: await listen(semrush), dfs: await listen(dfs), pages: await listen(pages), hits, close: () => [semrush, dfs, pages].forEach((s) => s.close()) };
}
