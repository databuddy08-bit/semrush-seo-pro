// Output rows shared by both data sources, plus filters. Field names follow the original actor; extra fields are additive.

/** Semrush intent codes. DataForSEO intents are mapped to the same codes so rows from both sources look alike. */
export const INTENTS = ['commercial', 'informational', 'navigational', 'transactional'];
export const intentCode = (name) => {
    const i = INTENTS.indexOf(String(name ?? '').toLowerCase());
    return i < 0 ? null : i;
};
export const intentLabels = (codes) => (codes ?? []).map((c) => INTENTS[c]).filter(Boolean);

const num = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const round = (v, d = 2) => (v === null ? null : Math.round(v * 10 ** d) / 10 ** d);
export { num, round };

/** "0,2" / [0, 2] / "" -> [0, 2] */
export const codeList = (v) => (Array.isArray(v) ? v : String(v ?? '').split(',')).map((x) => String(x).trim()).filter((x) => x !== '' && !Number.isNaN(Number(x))).map(Number);

/** Semrush trend "0.62,0.81,…,1.00" -> [62, 81, …, 100] */
export const semrushTrend = (td) => {
    const v = String(td ?? '').split(',').map((x) => num(x)).filter((x) => x !== null);
    return v.length ? v.map((x) => Math.round(x * 100)) : null;
};

/** DataForSEO monthly_searches (newest first) -> {trend: 12 values 0–100 oldest→newest, monthly: [{month, volume}]} */
export function monthlyTrend(monthly) {
    const m = [...(monthly ?? [])].filter((x) => x && x.year).sort((a, b) => a.year - b.year || a.month - b.month).slice(-12);
    if (!m.length) return { trend: null, monthly: null };
    const max = Math.max(...m.map((x) => x.search_volume ?? 0));
    return {
        trend: m.map((x) => (max > 0 ? Math.round(((x.search_volume ?? 0) / max) * 100) : 0)),
        monthly: m.map((x) => ({ month: `${x.year}-${String(x.month).padStart(2, '0')}`, volume: x.search_volume ?? null })),
    };
}

/** "2026-09-20 03:43:39 +00:00" -> "20260920" */
export const yyyymmdd = (t) => (t ? String(t).slice(0, 10).replace(/-/g, '') || null : null);
/** Any date -> unix seconds (Semrush backlinks already are unix). */
export const unix = (t) => {
    if (t === null || t === undefined || t === '') return null;
    if (/^\d+$/.test(String(t))) return Number(t);
    const ms = Date.parse(String(t).replace(' +00:00', 'Z').replace(' ', 'T'));
    return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
};
export const isoDate = (sec) => (sec ? new Date(sec * 1000).toISOString().slice(0, 10) : null);

export function keywordRow(k, ctx) {
    const phrase = String(k.phrase ?? '').trim();
    return {
        mode: 'keyword',
        query: ctx.query,
        phrase,
        database: ctx.db.db,
        volume: num(k.volume),
        cpc: num(k.cpc),
        competition_level: num(k.competition),
        difficulty: num(k.difficulty),
        intents: k.intents ?? [],
        intent_labels: intentLabels(k.intents),
        results: num(k.results),
        serp_features: k.serpFeatures ?? null,
        ...(k.serpFeatureNames ? { serp_feature_names: k.serpFeatureNames } : {}),
        trend: k.trend ?? null,
        ...(k.monthly ? { monthly_searches: k.monthly } : {}),
        snapshot_date: k.snapshotDate ?? null,
        word_count: phrase ? phrase.split(/\s+/).length : 0,
        match_type: ctx.matchType,
        ...(k.isSeed ? { is_seed: true } : {}),
        ...(k.depth !== undefined ? { related_depth: k.depth } : {}),
        source: ctx.source,
    };
}

export function competitorRow(c, ctx) {
    return {
        mode: 'competitors',
        query: ctx.query,
        rank: c.rank,
        domain: c.domain,
        database: ctx.db.db,
        competition_level: round(num(c.level), 4),
        common_keywords: num(c.common),
        se_keywords: num(c.keywords),
        traffic: num(c.traffic),
        traffic_cost: num(c.cost),
        paid_keywords: num(c.paid),
        source: ctx.source,
    };
}

export function backlinkRow(b, ctx) {
    const first = unix(b.firstSeen);
    const last = unix(b.lastSeen);
    let sourceDomain = null;
    try {
        sourceDomain = new URL(b.sourceUrl).hostname.replace(/^www\./, '');
    } catch { /* keep null */ }
    return {
        mode: 'backlinks',
        query: ctx.query,
        page_ascore: num(b.pageScore),
        source_title: b.sourceTitle ?? null,
        source_url: b.sourceUrl ?? null,
        source_domain: sourceDomain,
        external_link_num: num(b.external),
        internal_link_num: num(b.internal),
        target_anchor: b.anchor ?? '',
        target_url: b.targetUrl ?? null,
        nofollow: b.nofollow ?? null,
        link_type: b.linkType ?? null,
        first_seen: first,
        last_seen: last,
        first_seen_date: isoDate(first),
        last_seen_date: isoDate(last),
        ...(b.isNew !== undefined ? { new_link: b.isNew } : {}),
        ...(b.isLost !== undefined ? { lost_link: b.isLost } : {}),
        ...(b.sitewide !== undefined ? { sitewide: b.sitewide } : {}),
        ...(b.spamScore !== undefined ? { spam_score: b.spamScore } : {}),
        target_type: ctx.targetType,
        source: ctx.source,
    };
}

// ---------- filters (keyword mode) ----------
const words = (v) => (Array.isArray(v) ? v : String(v ?? '').split(/[\n,]/)).map((x) => String(x).trim().toLowerCase()).filter(Boolean);
export function makeKeywordFilter(i) {
    const f = {
        // 0 / 100 are the form defaults and mean "no limit"
        minVolume: num(i.minVolume) > 0 ? num(i.minVolume) : null,
        maxVolume: num(i.maxVolume) > 0 ? num(i.maxVolume) : null,
        minDifficulty: num(i.minDifficulty) > 0 ? num(i.minDifficulty) : null,
        maxDifficulty: num(i.maxDifficulty) !== null && num(i.maxDifficulty) < 100 ? num(i.maxDifficulty) : null,
        minCpc: num(i.minCpc) > 0 ? num(i.minCpc) : null,
        includeWords: words(i.includeWords),
        excludeWords: words(i.excludeWords),
        intents: (Array.isArray(i.intents) ? i.intents : []).map(intentCode).filter((x) => x !== null),
    };
    f.active = Object.values(f).some((v) => (Array.isArray(v) ? v.length : v !== null));
    /** Returns null when the row passes, otherwise the reason it was skipped. */
    f.reject = (r) => {
        if (f.minVolume !== null && (r.volume ?? 0) < f.minVolume) return 'volume_below_minimum';
        if (f.maxVolume !== null && (r.volume ?? 0) > f.maxVolume) return 'volume_above_maximum';
        if (f.minDifficulty !== null && (r.difficulty === null || r.difficulty < f.minDifficulty)) return 'difficulty_below_minimum';
        if (f.maxDifficulty !== null && (r.difficulty === null || r.difficulty > f.maxDifficulty)) return 'difficulty_above_maximum';
        if (f.minCpc !== null && (r.cpc ?? 0) < f.minCpc) return 'cpc_below_minimum';
        const p = ` ${r.phrase.toLowerCase()} `;
        if (f.includeWords.length && !f.includeWords.some((w) => p.includes(w))) return 'missing_included_word';
        if (f.excludeWords.some((w) => p.includes(w))) return 'contains_excluded_word';
        if (f.intents.length && !r.intents.some((c) => f.intents.includes(c))) return 'intent_not_selected';
        return null;
    };
    return f;
}

/** "https://www.Nike.com/en/x" -> "nike.com"; keeps subdomains other than www. */
export function cleanDomain(raw) {
    let s = String(raw ?? '').trim().toLowerCase();
    if (!s) return '';
    if (!/^[a-z]+:\/\//.test(s)) s = `http://${s}`;
    try {
        return new URL(s).hostname.replace(/^www\./, '').replace(/\.$/, '');
    } catch {
        return '';
    }
}
