// Country databases. Semrush uses its own two-letter codes (uk = United Kingdom); DataForSEO needs a location code
// (2000 + ISO numeric) and a language.
import { COUNTRIES, countryCode } from './countries.js';

/** The 47 databases of the original actor, with the main search language of each market. */
export const DATABASES = {
    us: 'en', uk: 'en', ca: 'en', au: 'en', br: 'pt', fr: 'fr', de: 'de', it: 'it', es: 'es', nl: 'nl', se: 'sv', dk: 'da',
    be: 'nl', no: 'nb', ie: 'en', ar: 'es', mx: 'es', co: 'es', cl: 'es', pe: 'es', in: 'en', sg: 'en', id: 'id', ph: 'en',
    my: 'en', th: 'th', vn: 'vi', jp: 'ja', hk: 'zh-TW', cn: 'zh-CN', tr: 'tr', za: 'en', il: 'he', sa: 'ar', ae: 'en', pl: 'pl',
    cz: 'cs', ro: 'ro', hu: 'hu', at: 'de', ch: 'de', pt: 'pt', fi: 'fi', gr: 'el', nz: 'en', ru: 'ru', ua: 'uk',
};

/**
 * "us", "UK", "united_kingdom", "Germany" -> {db: 'uk', iso: 'GB', location_code: 2826, language: 'en', name}.
 * Other countries work too (Semrush has more databases than the 47 listed); their language defaults to English.
 */
export function resolveDb(raw, languageOverride) {
    const s = String(raw ?? '').trim().toLowerCase() || 'us';
    const iso = s === 'uk' ? 'GB' : countryCode(s);
    if (!iso) throw new Error(`Unknown database "${raw}". Use a country code such as us, uk, de, in (47 supported: ${Object.keys(DATABASES).join(', ')}).`);
    const db = iso === 'GB' ? 'uk' : iso.toLowerCase();
    const c = COUNTRIES.find((x) => x.iso === iso);
    return { db, iso, location_code: c.code, name: c.name, language: String(languageOverride || DATABASES[db] || 'en'), listed: db in DATABASES };
}
