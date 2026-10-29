// Semrush's free public domain pages (www.semrush.com/website/<domain>/overview/). No key needed; they exist for
// popular sites only. The data sits in the page as Astro island props: every value is [type, value]
// (0 = plain value / object, 1 = array).
import { codeList, num } from './rows.js';

export const PUBLIC_BASE = (process.env.SEMRUSH_WEB_BASE ?? 'https://www.semrush.com').replace(/\/$/, '');
export const publicUrl = (domain) => `${PUBLIC_BASE}/website/${encodeURIComponent(domain)}/overview/`;

const decodeEntities = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
export function decodeIsland(v) {
    if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'number') {
        const [t, x] = v;
        if (t === 0) return x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).map(([k, y]) => [k, decodeIsland(y)])) : x;
        if (t === 1) return x.map(decodeIsland);
        return x;
    }
    return v;
}

/** Page HTML -> the page's data object, or null when the page has none. */
export function pageData(html) {
    for (const m of String(html).matchAll(/<astro-island[^>]*?\sprops="([^"]*)"/g)) {
        try {
            const props = JSON.parse(decodeEntities(m[1]));
            const page = decodeIsland(props.page);
            const data = page?.data ?? page;
            if (data?.summary) return data;
        } catch { /* try the next island */ }
    }
    return null;
}

const v = (o) => num(o?.value);
const pct = (x) => (x === null || x === undefined ? null : Math.round(x * 10000) / 100);

/** Data object -> domain report (same shape as the API sources, plus the extras only the public page has). */
export function domainFromPage(d) {
    const s = d.summary ?? {};
    const ts = s.trafficStats ?? {};
    const bl = d.backlinks ?? {};
    const st = d.searchTraffic ?? {};
    const hist = [...(st.history ?? [])].sort((a, b) => String(a.displayDate).localeCompare(String(b.displayDate)));
    const eng = d.visitorEngagement ?? {};
    const dev = d.trafficByDevice?.history?.[0];
    return {
        // Semrush shows each site's main market: the top keywords and ranks are for this database.
        database: String(d.keywords?.country ?? s.country ?? '').toLowerCase().replace(/^gb$/, 'uk') || null,
        brand_name: s.brandName ?? null,
        authority_score: v(bl.authorityScore) ?? v(ts.authorityScore),
        number_of_backlinks: v(bl.backlinks),
        referring_domains_count: v(bl.referringDomains),
        google_penalty_risk: bl.googlePenaltyRisk?.value ?? null,
        organic_traffic: v(st.organic),
        organic_traffic_change_pct: pct(st.organic?.valueDiffPercent),
        paid_traffic: v(st.paid),
        search_traffic: Object.fromEntries(hist.map((h) => [h.displayDate, num(h.organic)])),
        search_traffic_history: hist.map((h) => ({ date: h.displayDate, organic: num(h.organic), paid: num(h.paid), total: num(h.total) })),
        competitors: (d.competitors?.items ?? []).map((c) => ({ domain: c.slug ?? c.name, level: num(c.relevance), common_keywords: null, positions: null, visits: num(c.visits) })),
        top_keywords: (d.keywords?.series ?? []).map((k) => ({ phrase: k.keyword, intents: codeList(k.intents), cpc: num(k.cpc), position: num(k.position), traffic_percent: pct(k.traffic), volume: num(k.searchVolume), url: null })),
        backlinks_history: (bl.backlinksHistory ?? []).map((h) => ({ date: h.displayDate, backlinks: num(h.backlinks) })),
        referring_domains_history: (bl.referringDomainsHistory ?? []).map((h) => ({ date: h.displayDate, referring_domains: num(h.referringDomains) })),
        visits: v(ts.visits) ?? v(eng.visits),
        global_rank: v(ts.globalRank),
        country_rank: v(ts.countryRank),
        country_rank_country: ts.countryRank?.name ?? null,
        category_rank: v(ts.categoryRank),
        category: ts.categoryRank?.name ?? null,
        categories: (s.categories ?? []).map((c) => c.name).filter(Boolean),
        pages_per_visit: v(eng.pagesPerVisit),
        avg_visit_duration_sec: v(eng.timeOnSite),
        bounce_rate_pct: pct(v(eng.bounceRate)),
        traffic_by_country: (d.trafficByCountry?.series ?? []).map((c) => ({ country: c.country, country_name: c.countryName, visits: num(c.traffic), share_pct: pct(c.trafficShare), desktop_pct: pct(c.desktopShare), mobile_pct: pct(c.mobileShare) })),
        device_split: dev ? { visits: num(dev.visits), desktop: num(dev.desktopVisits), mobile: num(dev.mobileVisits) } : null,
        traffic_sources: (d.trafficJourney?.in?.items ?? []).map((t) => ({ source: t.host, share_pct: pct(t.share), visits: num(t.value) })),
        outgoing_traffic: (d.trafficJourney?.out?.items ?? []).map((t) => ({ domain: t.host, share_pct: pct(t.share), visits: num(t.value) })),
        ai_traffic: (d.trafficAi?.items ?? []).map((a) => ({ assistant: a.name, visits: num(a.traffic?.value), share_pct: pct(a.traffic?.share) })),
        data_date: s.actualDate ?? st.displayDate ?? null,
    };
}
