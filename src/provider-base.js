// Shared pieces of the two paid data sources: errors, pacing, and a result cache.
import { createHash } from 'node:crypto';

export const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms * Number(process.env.HTTP_BACKOFF_SCALE ?? 1))));

export class ProviderError extends Error {
    /** kind: 'down' (key, balance, plan: stop using this source), 'unsupported' (source can't do this), 'retry', 'other' */
    constructor(message, kind = 'other') {
        super(message);
        this.kind = kind;
    }
}

/** At most `perSecond` request starts per second. */
export class Pacer {
    constructor(perSecond) {
        this.gap = 1000 / perSecond;
        this.next = 0;
    }

    async take() {
        const slot = Math.max(Date.now(), this.next);
        this.next = slot + this.gap;
        if (slot > Date.now()) await new Promise((r) => setTimeout(r, slot - Date.now()));
    }
}

/**
 * Cache of API answers in a named key-value store (survives between runs of the same account), so repeating a query
 * within `ttlHours` costs no API call. Same price for the user either way.
 */
export class ResultCache {
    constructor(store, ttlHours, stats) {
        this.store = store;
        this.ttlMs = ttlHours * 3600 * 1000;
        this.stats = stats;
    }

    key(parts) {
        return `c-${createHash('sha1').update(JSON.stringify(parts)).digest('hex')}`;
    }

    async wrap(parts, fn) {
        if (!this.store || this.ttlMs <= 0) return fn();
        const k = this.key(parts);
        try {
            const hit = await this.store.getValue(k);
            if (hit && Date.now() - hit.at < this.ttlMs) {
                this.stats.cacheHits += 1;
                return hit.data;
            }
        } catch { /* cache is best effort */ }
        const data = await fn();
        try {
            await this.store.setValue(k, { at: Date.now(), data });
        } catch { /* too large or store unavailable */ }
        return data;
    }
}
