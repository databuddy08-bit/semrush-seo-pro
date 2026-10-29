// Semrush API (api.semrush.com, needs a Semrush API key with API units). Answers are ";"-separated text tables.
import { ProviderError, Pacer, sleep } from './provider-base.js';
import { codeList, semrushTrend, num } from './rows.js';

/** API units per returned line (Semrush price list) — used for the cost estimate in RUN_SUMMARY. */
const UNITS = { phrase_fullsearch: 20, phrase_related: 40, phrase_questions: 40, phrase_this: 10, phrase_kdi: 50, domain_organic_organic: 40, domain_organic: 10, domain_rank: 10, domain_rank_history: 10, backlinks: 40, backlinks_overview: 40 };
const KW_COLUMNS = ['Ph', 'Nq', 'Cp', 'Co', 'Kd', 'In', 'Nr', 'Fk', 'Td'];
const KW_COLUMNS_BASIC = ['Ph', 'Nq', 'Cp', 'Co', 'Nr', 'Fk', 'Td'];
const REPORT = { phrase: 'phrase_fullsearch', exact: 'phrase_fullsearch', broad: 'phrase_fullsearch', related: 'phrase_related', questions: 'phrase_questions' };

/** Splits a Semrush text table. Extra ";" inside a text column (titles, anchors) is glued back into that column. */
export function parseTable(text, columns, textColumn = 0) {
    const lines = String(text ?? '').split(/\r?\n/).filter((l) => l.trim());
    if (lines.length < 2) return [];
    return lines.slice(1).map((line) => {
        let cells = line.split(';');
        if (cells.length > columns.length) {
            const extra = cells.length - columns.length;
            cells = [...cells.slice(0, textColumn), cells.slice(textColumn, textColumn + extra + 1).join(';'), ...cells.slice(textColumn + extra + 1)];
        }
        return Object.fromEntries(columns.map((c, i) => [c, cells[i] === undefined ? '' : cells[i].trim()]));
    });
}

/** Semrush display_filter: [['+', 'Ph', 'Co', 'shoes'], …] -> "+|Ph|Co|shoes|+|…" (max 25 conditions). */
export const displayFilter = (conds) => conds.slice(0, 25).map((c) => c.join('|')).join('|');

export class SemrushApi {
    constructor({ key, base, stats }) {
        this.key = key || null;
        this.base = (base ?? 'https://api.semrush.com').replace(/\/$/, '');
        this.stats = stats;
        this.pacer = new Pacer(Number(process.env.SEMRUSH_PER_SECOND ?? 8)); // Semrush allows 10 requests/second
        this.down = null;
        this.basicColumns = false; // set when the key's plan rejects the Kd/In columns
    }

    get configured() {
        return Boolean(this.key);
    }

    /** One report call. Returns the raw text table ('' when Semrush found nothing). */
    async call(params, path = '/') {
        if (this.down) throw new ProviderError(this.down, 'down');
        const url = `${this.base}${path}?${new URLSearchParams({ key: this.key, ...params })}`;
        let last;
        for (let attempt = 0; attempt < 5; attempt++) {
            await this.pacer.take();
            this.stats.semrushCalls += 1;
            let res;
            let text;
            try {
                res = await fetch(url, { signal: AbortSignal.timeout(60000) });
                text = await res.text();
            } catch (err) {
                last = new ProviderError(`Semrush network error: ${err.message}`, 'retry');
                await sleep(1500 * (attempt + 1));
                continue;
            }
            const m = text.match(/^\s*ERROR\s+(\d+)\s*::\s*(.*)/);
            const code = m ? Number(m[1]) : null;
            const msg = m ? `ERROR ${m[1]} :: ${m[2].trim()}` : `HTTP ${res.status}`;
            if (code === 50) return '';
            if (res.status === 429 || code === 429) {
                last = new ProviderError(`Semrush rate limit (${msg})`, 'retry');
                await sleep(2000 * 2 ** attempt);
                continue;
            }
            if (code !== null && code >= 110 && code <= 136 && !/column/i.test(msg)) {
                this.down = `Semrush API refused the key: ${msg}`;
                throw new ProviderError(this.down, 'down');
            }
            if (res.status === 401 || res.status === 403) {
                this.down = `Semrush API refused the key (${msg})`;
                throw new ProviderError(this.down, 'down');
            }
            if (res.status >= 500 || code === 500) {
                last = new ProviderError(`Semrush server error (${msg})`, 'retry');
                await sleep(2000 * (attempt + 1));
                continue;
            }
            if (code !== null || !res.ok) throw new ProviderError(`Semrush: ${msg}`, /column/i.test(msg) ? 'columns' : 'other');
            const lines = Math.max(0, text.split(/\r?\n/).filter((l) => l.trim()).length - 1);
            this.stats.semrushUnits += params.type === 'backlinks_overview' ? UNITS.backlinks_overview : lines * (UNITS[params.type] ?? 10); // overview is billed per request
            return text;
        }
        throw last;
    }

    // ---------- keywords ----------
    /** One page of keyword ideas. matchType: phrase | exact | broad | related | questions */
    async keywords({ phrase, db, matchType, limit, offset, filter }) {
        const conds = [];
        if (matchType === 'phrase') for (const w of phrase.split(/\s+/).filter(Boolean).slice(0, 10)) conds.push(['+', 'Ph', 'Co', w]);
        if (matchType === 'exact') conds.push(['+', 'Ph', 'Co', phrase]);
        if (filter.minVolume !== null) conds.push(['+', 'Nq', 'Gt', String(Math.max(0, filter.minVolume - 1))]);
        if (filter.maxVolume !== null) conds.push(['+', 'Nq', 'Lt', String(filter.maxVolume + 1)]);
        if (!this.basicColumns) {
            if (filter.maxDifficulty !== null) conds.push(['+', 'Kd', 'Lt', String(filter.maxDifficulty + 1)]);
            if (filter.minDifficulty !== null) conds.push(['+', 'Kd', 'Gt', String(Math.max(0, filter.minDifficulty - 1))]);
        }
        for (const w of filter.excludeWords.slice(0, 10)) conds.push(['-', 'Ph', 'Co', w]);
        const type = REPORT[matchType] ?? 'phrase_fullsearch';
        const req = async (cols) => parseTable(await this.call({
            type, phrase, database: db.db, export_columns: cols.join(','), display_limit: String(offset + limit), display_offset: String(offset),
            ...(type !== 'phrase_related' ? { display_sort: 'nq_desc' } : {}),
            ...(conds.length ? { display_filter: displayFilter(conds) } : {}),
        }), cols);
        let rows;
        if (!this.basicColumns) {
            try {
                rows = await req(KW_COLUMNS);
            } catch (err) {
                if (err.kind !== 'columns') throw err;
                this.basicColumns = true; // older plans: no Kd/In columns -> fetch difficulty separately
            }
        }
        if (this.basicColumns) {
            rows = await req(KW_COLUMNS_BASIC);
            await this.addDifficulty(rows, db);
        }
        return rows.map((r) => this.mapKeyword(r));
    }

    /** The seed keyword itself (phrase_this). */
    async seed({ phrase, db }) {
        const cols = this.basicColumns ? KW_COLUMNS_BASIC : KW_COLUMNS;
        const rows = parseTable(await this.call({ type: 'phrase_this', phrase, database: db.db, export_columns: cols.join(',') }), cols);
        if (this.basicColumns) await this.addDifficulty(rows, db);
        return rows.map((r) => ({ ...this.mapKeyword(r), isSeed: true }));
    }

    async addDifficulty(rows, db) {
        for (let i = 0; i < rows.length; i += 100) {
            const chunk = rows.slice(i, i + 100);
            const kd = parseTable(await this.call({ type: 'phrase_kdi', phrase: chunk.map((r) => r.Ph).join(';'), database: db.db, export_columns: 'Ph,Kd' }), ['Ph', 'Kd']);
            const by = new Map(kd.map((k) => [k.Ph.toLowerCase(), k.Kd]));
            for (const r of chunk) r.Kd = by.get(r.Ph.toLowerCase()) ?? '';
        }
    }

    mapKeyword(r) {
        return {
            phrase: r.Ph,
            volume: num(r.Nq),
            cpc: num(r.Cp),
            competition: num(r.Co),
            difficulty: num(r.Kd),
            intents: codeList(r.In),
            results: num(r.Nr),
            serpFeatures: r.Fk !== undefined ? codeList(r.Fk) : null,
            trend: semrushTrend(r.Td),
            snapshotDate: null,
        };
    }

    // ---------- competitors ----------
    async competitors({ domain, db, limit, offset, sortBy }) {
        const cols = ['Dn', 'Cr', 'Np', 'Or', 'Ot', 'Oc', 'Ad'];
        const rows = parseTable(await this.call({
            type: 'domain_organic_organic', domain, database: db.db, export_columns: cols.join(','), display_limit: String(offset + limit), display_offset: String(offset),
            display_sort: sortBy === 'common_keywords' ? 'np_desc' : 'cr_desc',
        }), cols);
        return rows.map((r) => ({ domain: r.Dn, level: num(r.Cr), common: num(r.Np), keywords: num(r.Or), traffic: num(r.Ot), cost: num(r.Oc), paid: num(r.Ad) }));
    }

    // ---------- backlinks ----------
    async backlinks({ target, targetType, limit, offset, followOnly, status }) {
        const cols = ['page_ascore', 'source_title', 'source_url', 'target_url', 'anchor', 'external_num', 'internal_num', 'first_seen', 'last_seen', 'nofollow', 'image', 'form', 'frame', 'sitewide', 'newlink', 'lostlink'];
        const conds = [];
        if (followOnly) conds.push(['+', 'type', '', 'follow']);
        if (status === 'new') conds.push(['+', 'type', '', 'newlink']);
        if (status === 'lost') conds.push(['+', 'type', '', 'lostlink']);
        const rows = parseTable(await this.call({
            type: 'backlinks', target, target_type: targetType, export_columns: cols.join(','), display_limit: String(offset + limit), display_offset: String(offset), display_sort: 'page_ascore_desc',
            ...(conds.length ? { display_filter: displayFilter(conds) } : {}),
        }, '/analytics/v1/'), cols, 1);
        const yes = (v) => v === 'true' || v === '1';
        return rows.map((r) => ({
            pageScore: num(r.page_ascore), sourceTitle: r.source_title, sourceUrl: r.source_url, targetUrl: r.target_url, anchor: r.anchor,
            external: num(r.external_num), internal: num(r.internal_num), firstSeen: r.first_seen, lastSeen: r.last_seen,
            nofollow: yes(r.nofollow), linkType: yes(r.image) ? 'image' : yes(r.form) ? 'form' : yes(r.frame) ? 'frame' : 'text',
            sitewide: yes(r.sitewide), isNew: yes(r.newlink), isLost: yes(r.lostlink),
        }));
    }

    // ---------- domain overview (for domains without a public Semrush page) ----------
    async domain({ domain, db }) {
        const rank = parseTable(await this.call({ type: 'domain_rank', domain, database: db.db, export_columns: 'Dn,Rk,Or,Ot,Oc,Ad,At,Ac' }), ['Dn', 'Rk', 'Or', 'Ot', 'Oc', 'Ad', 'At', 'Ac'])[0];
        const hist = parseTable(await this.call({ type: 'domain_rank_history', domain, database: db.db, display_limit: '12', export_columns: 'Dt,Or,Ot,Ad,At' }), ['Dt', 'Or', 'Ot', 'Ad', 'At']);
        const bl = parseTable(await this.call({ type: 'backlinks_overview', target: domain, target_type: 'root_domain', export_columns: 'ascore,total,domains_num' }, '/analytics/v1/'), ['ascore', 'total', 'domains_num'])[0];
        const kws = parseTable(await this.call({ type: 'domain_organic', domain, database: db.db, display_limit: '10', display_sort: 'tr_desc', export_columns: 'Ph,Po,Nq,Cp,Ur,Tr,In' }), ['Ph', 'Po', 'Nq', 'Cp', 'Ur', 'Tr', 'In']);
        const comps = parseTable(await this.call({ type: 'domain_organic_organic', domain, database: db.db, display_limit: '10', export_columns: 'Dn,Cr,Np,Or' }), ['Dn', 'Cr', 'Np', 'Or']);
        if (!rank && !bl && !kws.length) return null;
        const day = (d) => (/^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : d);
        return {
            database: db.db,
            authority_score: num(bl?.ascore),
            number_of_backlinks: num(bl?.total),
            referring_domains_count: num(bl?.domains_num),
            organic_keywords: num(rank?.Or),
            organic_traffic: num(rank?.Ot),
            organic_traffic_cost: num(rank?.Oc),
            paid_keywords: num(rank?.Ad),
            paid_traffic: num(rank?.At),
            semrush_rank: num(rank?.Rk),
            search_traffic: Object.fromEntries(hist.map((h) => [day(h.Dt), num(h.Ot)])),
            search_traffic_history: hist.map((h) => ({ date: day(h.Dt), organic: num(h.Ot), paid: num(h.At), organic_keywords: num(h.Or), paid_keywords: num(h.Ad) })),
            competitors: comps.map((c) => ({ domain: c.Dn, level: num(c.Cr), common_keywords: num(c.Np), positions: num(c.Or) })),
            top_keywords: kws.map((k) => ({ phrase: k.Ph, intents: codeList(k.In), cpc: num(k.Cp), position: num(k.Po), traffic_percent: num(k.Tr), volume: num(k.Nq), url: k.Ur || null })),
        };
    }
}
