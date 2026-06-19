/**
 * SQLite store for usage tracking.
 *
 * Records every request with token counts, cost, latency, and model used.
 * This data powers:
 * - Usage reporting for clients
 * - Output ratio calculation for smarter routing (V2)
 * - Billing (when we add it)
 */
import Database from 'better-sqlite3';
import type { UsageRecord } from '../types.js';
export declare class UsageStore {
    private db;
    private insertStmt;
    constructor(db: Database.Database);
    private initSchema;
    /**
     * Record a completed request.
     */
    record(usage: UsageRecord): void;
    /**
     * Get usage summary for an API key over a time period.
     */
    getUsageSummary(keyId: string, sinceDays?: number): UsageSummary;
    /**
     * Get daily usage aggregates for a key, for charting.
     * Returns one row per day for the last `days` days (including days with zero requests).
     */
    getDailyUsage(keyId: string, days?: number): DailyUsage[];
    /**
     * Get the average output ratio for a key (for routing optimization).
     */
    /**
     * Get auto-routing analytics — tier distribution, average score, request count.
     * Only includes requests where auto-routing was used (auto_tier IS NOT NULL).
     */
    getAutoRoutingStats(sinceDays?: number): AutoRoutingStats;
    getOutputRatio(keyId: string, sinceDays?: number): number | null;
}
export interface UsageSummary {
    totalRequests: number;
    totalPromptTokens: number;
    totalCompletionTokens: number;
    totalTokens: number;
    totalCostCents: number;
    avgLatencyMs: number;
    modelDistribution: Array<{
        model: string;
        provider: string;
        requestCount: number;
        totalTokens: number;
    }>;
}
export interface DailyUsage {
    day: string;
    requestCount: number;
    totalTokens: number;
    costCents: number;
}
export interface AutoRoutingStats {
    totalAutoRequests: number;
    totalRequests: number;
    avgScore: number | null;
    minScore: number | null;
    maxScore: number | null;
    tierDistribution: Array<{
        tier: string;
        count: number;
        avgScore: number;
        totalCostCents: number;
    }>;
}
//# sourceMappingURL=store.d.ts.map