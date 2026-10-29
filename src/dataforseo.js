// DataForSEO (Labs + Backlinks APIs, login/password). Results are mapped to the same row shapes as the Semrush API.
import { ProviderError, Pacer, sleep } from './provider-base.js';
import { intentCode, monthlyTrend, yyyymmdd, num } from './rows.js';

const QUESTION_REGEX = '^(how|what|why|when|where|who|whom|whose|which|can|could|does|do|did|is|are|was|were|should|will|would)\\s';

export class DataForSeo {
    constructor({ login, password, base, stats }) {
        this.base = (base ?? 'https://api.dataforseo.com').replace(/\/$/, '');
        this.auth = login && password ? `Basic ${Buffer.from(`${login}:${password}`).toString('base64')}` : null;
        this.stats = stats;
        this.pacer = new Pacer(Number(process.env.DATAFORSEO_PER_SECOND ?? 20));
        this.down = null;
        this.backlinksDown = null; // the Backlinks API is a separate subscription
    }

    get configured() {
        return Boolean(this.auth);
    }

    /** One Live task; returns tasks[0].result[0] (or null). */
    async task(path, task) {
        const isBacklinks = path.startsWith('/v3/backlinks/');
        if (this.down) throw new ProviderError(this.down, 'down');
        if (isBacklinks && this.backlinksDown) throw new ProviderError(this.backlinksDown, 'unsupported');
        let last;
        for (let attempt = 0; attempt < 5; attempt++) {
            await this.pacer.take();
            this.stats.dataforseoCalls += 1;
            let res;
            let body;
            try {
                res = await fetch(`${this.base}${path}`, { method: 'POST', headers: { authorization: this.auth, 'content-type': 'application/json' }, body: JSON.stringify([task]), signal: AbortSignal.timeout(120000) });
                body = await res.json().catch(() => null);
            } catch (err) {
                last = new ProviderError(`DataForSEO network error: ${err.message}`, 'retry');
                await sleep(2000 * (attempt + 1));
                continue;
            }
            const top = body?.status_code;
            const t = body?.tasks?.[0];
            const code = t?.status_code ?? top;
            const msg = `${t?.status_message ?? body?.status_message ?? `HTTP ${res.status}`} (${code ?? res.status})`;
            if (res.status === 401 || [40100, 40101, 40102, 40103, 40104].includes(top)) {
                this.down = `DataForSEO login rejected: ${msg}`;
                throw new ProviderError(this.down, 'down');
            }
            if (res.status === 402 || [40200, 40201, 40210].includes(top) || [40200, 40201, 40210].includes(code)) {
                this.down = `DataForSEO account balance is empty: ${msg}`;
                throw new ProviderError(this.down, 'down');
            }
            if ([40204, 40203].includes(code) || [40204, 40203].includes(top) || (isBacklinks && /subscri|access denied|not active/i.test(msg))) {
                if (isBacklinks) {
                    this.backlinksDown = `DataForSEO Backlinks API is not active on this account: ${msg}`;
                    throw new ProviderError(this.backlinksDown, 'unsupported');
                }
                this.down = `DataForSEO refused access: ${msg}`;
                throw new ProviderError(this.down, 'down');
            }
            if (res.status === 429 || [40202, 40209, 50301].includes(code) || [40202, 40209].includes(top)) {
                this.stats.dataforseoRateLimited += 1;
                last = new ProviderError(`DataForSEO rate limit: ${msg}`, 'retry');
                await sleep(Math.min(60000, 3000 * 2 ** attempt));
                continue;
            }
            if (res.status >= 500 || (code >= 50000 && code < 60000)) {
                last = new ProviderError(`DataForSEO server error: ${msg}`, 'retry');
                await sleep(3000 * (attempt + 1));
                continue;
            }
            if (code === 20000) {
                this.stats.dataforseoCost += Number(t?.cost ?? 0);
                return t.result?.[0] ?? null;
            }
            if (code === 40102 || /no search results/i.test(msg)) return null; // nothing found
            throw new ProviderError(`DataForSEO error: ${msg}`, /location|language/i.test(msg) ? 'bad_market' : 'other');
        }
        throw last;
    }

    market(db) {
        return { location_code: db.location_code, language_code: db.language };
    }

    // ---------- keywords ----------
    async keywords({ phrase, db, matchType, limit, offset, filter }) {
        const cond = (prefix) => {
            const c = [];
            if (filter.minVolume !== null) c.push([`${prefix}keyword_info.search_volume`, '>=', filter.minVolume]);
            if (filter.maxVolume !== null) c.push([`${prefix}keyword_info.search_volume`, '<=', filter.maxVolume]);
            if (filter.maxDifficulty !== null) c.push([`${prefix}keyword_properties.keyword_difficulty`, '<=', filter.maxDifficulty]);
            if (filter.minDifficulty !== null) c.push([`${prefix}keyword_properties.keyword_difficulty`, '>=', filter.minDifficulty]);
            if (filter.minCpc !== null) c.push([`${prefix}keyword_info.cpc`, '>=', filter.minCpc]);
            for (const w of filter.excludeWords) c.push([`${prefix}keyword`, 'not_like', `%${w}%`]);
            if (matchType === 'questions') c.push([`${prefix}keyword`, 'regex', QUESTION_REGEX]);
            const out = [];
            c.slice(0, 8).forEach((x, i) => out.push(...(i ? ['and', x] : [x])));
            return out;
        };
        const base = { ...this.market(db), limit, offset, include_serp_info: true };
        let r;
        let items;
        if (matchType === 'related') {
            const depth = offset + limit <= 8 ? 1 : offset + limit <= 72 ? 2 : offset + limit <= 584 ? 3 : 4;
            const f = cond('keyword_data.');
            r = await this.task('/v3/dataforseo_labs/google/related_keywords/live', { keyword: phrase, depth, ...base, ...(f.length ? { filters: f } : {}), order_by: ['keyword_data.keyword_info.search_volume,desc'] });
            items = (r?.items ?? []).map((i) => ({ ...i.keyword_data, depth: i.depth }));
        } else if (matchType === 'broad') {
            const f = cond('');
            r = await this.task('/v3/dataforseo_labs/google/keyword_ideas/live', { keywords: [phrase], ...base, ...(f.length ? { filters: f } : {}), order_by: ['keyword_info.search_volume,desc'] });
            items = r?.items ?? [];
        } else {
            const f = cond('');
            r = await this.task('/v3/dataforseo_labs/google/keyword_suggestions/live', { keyword: phrase, exact_match: matchType === 'exact', ...base, ...(f.length ? { filters: f } : {}), order_by: ['keyword_info.search_volume,desc'] });
            items = r?.items ?? [];
        }
        return items.map((i) => this.mapKeyword(i));
    }

    async seed({ phrase, db }) {
        const r = await this.task('/v3/dataforseo_labs/google/keyword_overview/live', { keywords: [phrase], ...this.market(db), include_serp_info: true });
        return (r?.items ?? []).map((i) => ({ ...this.mapKeyword(i), isSeed: true }));
    }

    mapKeyword(i) {
        const ki = i.keyword_info ?? {};
        const { trend, monthly } = monthlyTrend(ki.monthly_searches);
        const si = i.search_intent_info ?? {};
        const intents = [si.main_intent, ...(si.foreign_intent ?? [])].map(intentCode).filter((x) => x !== null);
        return {
            phrase: i.keyword,
            volume: num(ki.search_volume),
            cpc: num(ki.cpc),
            competition: num(ki.competition),
            difficulty: num(i.keyword_properties?.keyword_difficulty),
            intents: [...new Set(intents)],
            results: num(i.serp_info?.se_results_count),
            serpFeatures: null,
            serpFeatureNames: i.serp_info?.serp_item_types ?? null,
            trend,
            monthly,
            snapshotDate: yyyymmdd(ki.last_updated_time),
            ...(i.depth !== undefined ? { depth: i.depth } : {}),
        };
    }

    // ---------- competitors ----------
    async competitors({ domain, db, limit, offset, sortBy }) {
        const order = sortBy === 'traffic' ? 'full_domain_metrics.organic.etv,desc' : 'intersections,desc';
        const r = await this.task('/v3/dataforseo_labs/google/competitors_domain/live', { target: domain, ...this.market(db), limit: Math.min(1000, offset + limit + 1), offset: 0, exclude_top_domains: false, order_by: [order] });
        const items = r?.items ?? [];
        const self = items.find((i) => i.domain === domain);
        const own = self?.full_domain_metrics?.organic?.count ?? Math.max(1, ...items.map((i) => i.intersections ?? 0));
        return items.filter((i) => i.domain !== domain).slice(offset, offset + limit).map((i) => ({
            domain: i.domain,
            level: own ? (i.intersections ?? 0) / own : null,
            common: i.intersections,
            keywords: i.full_domain_metrics?.organic?.count,
            traffic: Math.round(i.full_domain_metrics?.organic?.etv ?? 0),
            cost: Math.round(i.full_domain_metrics?.organic?.estimated_paid_traffic_cost ?? 0),
            paid: i.full_domain_metrics?.paid?.count ?? 0,
        }));
    }

    // ---------- backlinks ----------
    async backlinks({ target, targetType, limit, offset, followOnly, status, onePerDomain }) {
        const filters = [];
        if (followOnly) filters.push(['dofollow', '=', true]);
        if (status === 'new') filters.push(['is_new', '=', true]);
        const r = await this.task('/v3/backlinks/backlinks/live', {
            target: targetType === 'url' ? target : target.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, ''),
            mode: onePerDomain ? 'one_per_domain' : 'as_is',
            include_subdomains: targetType !== 'domain',
            backlinks_status_type: status === 'lost' ? 'lost' : 'live',
            rank_scale: 'one_hundred',
            limit, offset,
            order_by: ['page_from_rank,desc'],
            ...(filters.length ? { filters: filters.flatMap((f, i) => (i ? ['and', f] : [f])) } : {}),
        });
        return (r?.items ?? []).map((b) => ({
            pageScore: b.page_from_rank, sourceTitle: b.page_from_title ?? null, sourceUrl: b.url_from, targetUrl: b.url_to, anchor: b.anchor ?? '',
            external: b.page_from_external_links, internal: b.page_from_internal_links, firstSeen: b.first_seen, lastSeen: b.last_seen,
            nofollow: b.dofollow === false, linkType: b.item_type === 'anchor' ? 'text' : b.item_type ?? null, isNew: Boolean(b.is_new), isLost: Boolean(b.is_lost),
            spamScore: b.backlink_spam_score ?? null,
        }));
    }

    // ---------- domain overview (for domains without a public Semrush page) ----------
    async domain({ domain, db }) {
        const m = this.market(db);
        const safe = async (fn) => {
            try {
                return await fn();
            } catch (err) {
                if (err.kind === 'down') throw err;
                return null;
            }
        };
        const [overview, ranked, history, summary, comps] = await Promise.all([
            this.task('/v3/dataforseo_labs/google/domain_rank_overview/live', { target: domain, ...m }),
            safe(() => this.task('/v3/dataforseo_labs/google/ranked_keywords/live', { target: domain, ...m, limit: 10, order_by: ['ranked_serp_element.serp_item.etv,desc'] })),
            safe(() => this.task('/v3/dataforseo_labs/google/historical_rank_overview/live', { target: domain, ...m })),
            safe(() => this.task('/v3/backlinks/summary/live', { target: domain, rank_scale: 'one_hundred' })),
            safe(() => this.competitors({ domain, db, limit: 10, offset: 0 })),
        ]);
        const org = overview?.items?.[0]?.metrics?.organic;
        const paid = overview?.items?.[0]?.metrics?.paid;
        if (!org && !summary && !ranked?.items?.length) return null;
        const totalEtv = ranked?.metrics?.organic?.etv ?? org?.etv ?? 0;
        const hist = [...(history?.items ?? [])].sort((a, b) => a.year - b.year || a.month - b.month).slice(-12)
            .map((h) => ({ date: `${h.year}-${String(h.month).padStart(2, '0')}-01`, organic: Math.round(h.metrics?.organic?.etv ?? 0), paid: Math.round(h.metrics?.paid?.etv ?? 0), organic_keywords: h.metrics?.organic?.count ?? null, paid_keywords: h.metrics?.paid?.count ?? null }));
        return {
            database: db.db,
            authority_score: num(summary?.rank),
            number_of_backlinks: num(summary?.backlinks),
            referring_domains_count: num(summary?.referring_domains),
            organic_keywords: num(org?.count),
            organic_traffic: org ? Math.round(org.etv ?? 0) : null,
            organic_traffic_cost: org ? Math.round(org.estimated_paid_traffic_cost ?? 0) : null,
            paid_keywords: num(paid?.count),
            paid_traffic: paid ? Math.round(paid.etv ?? 0) : null,
            search_traffic: Object.fromEntries(hist.map((h) => [h.date, h.organic])),
            search_traffic_history: hist,
            competitors: (comps ?? []).map((c) => ({ domain: c.domain, level: c.level === null ? null : Math.round(c.level * 100) / 100, common_keywords: c.common, positions: c.keywords })),
            top_keywords: (ranked?.items ?? []).map((k) => {
                const si = k.keyword_data?.search_intent_info ?? {};
                const etv = k.ranked_serp_element?.serp_item?.etv ?? 0;
                return {
                    phrase: k.keyword_data?.keyword,
                    intents: [si.main_intent, ...(si.foreign_intent ?? [])].map(intentCode).filter((x) => x !== null),
                    cpc: num(k.keyword_data?.keyword_info?.cpc),
                    position: num(k.ranked_serp_element?.serp_item?.rank_group),
                    traffic_percent: totalEtv ? Math.round((etv / totalEtv) * 10000) / 100 : null,
                    volume: num(k.keyword_data?.keyword_info?.search_volume),
                    url: k.ranked_serp_element?.serp_item?.url ?? null,
                };
            }),
        };
    }
}
