/**
 * SQLite store for usage tracking.
 *
 * Records every request with token counts, cost, latency, and model used.
 * This data powers:
 * - Usage reporting for clients
 * - Output ratio calculation for smarter routing (V2)
 * - Billing (when we add it)
 */
export class UsageStore {
    db;
    insertStmt;
    constructor(db) {
        this.db = db;
        this.initSchema();
        this.insertStmt = this.db.prepare(`
      INSERT INTO usage_log (
        key_id, provider, model, tier,
        prompt_tokens, completion_tokens, total_tokens,
        cost_cents, latency_ms, streaming, status_code,
        auto_score, auto_tier, auto_signals,
        error_body, error_headers,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `);
    }
    initSchema() {
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS usage_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        tier TEXT NOT NULL,
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        cost_cents REAL NOT NULL DEFAULT 0,
        latency_ms INTEGER NOT NULL DEFAULT 0,
        streaming INTEGER NOT NULL DEFAULT 0,
        status_code INTEGER NOT NULL DEFAULT 200,
        error_body TEXT,
        error_headers TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_usage_key_id ON usage_log(key_id);
      CREATE INDEX IF NOT EXISTS idx_usage_created ON usage_log(created_at);
      CREATE INDEX IF NOT EXISTS idx_usage_provider ON usage_log(provider);
    `);
        // ── Migration: add auto-routing columns to existing DBs ──
        // SQLite ADD COLUMN is idempotent-safe via try/catch.
        const autoColumns = [
            ['auto_score', 'INTEGER'],
            ['auto_tier', 'TEXT'],
            ['auto_signals', 'TEXT'],
        ];
        for (const [col, type] of autoColumns) {
            try {
                this.db.exec(`ALTER TABLE usage_log ADD COLUMN ${col} ${type}`);
            }
            catch {
                // Column already exists — expected on non-first run
            }
        }
        // ── Migration: add error detail columns ──
        const errorColumns = [
            ['error_body', 'TEXT'],
            ['error_headers', 'TEXT'],
        ];
        for (const [col, type] of errorColumns) {
            try {
                this.db.exec(`ALTER TABLE usage_log ADD COLUMN ${col} ${type}`);
            }
            catch {
                // Column already exists
            }
        }
    }
    /**
     * Record a completed request.
     */
    record(usage) {
        this.insertStmt.run(usage.keyId, usage.provider, usage.model, usage.tier, usage.promptTokens, usage.completionTokens, usage.totalTokens, usage.costCents, usage.latencyMs, usage.streaming ? 1 : 0, usage.statusCode, usage.autoScore ?? null, usage.autoTier ?? null, usage.autoSignals ?? null, usage.errorBody ?? null, usage.errorHeaders ?? null);
    }
    /**
     * Get usage summary for an API key over a time period.
     */
    getUsageSummary(keyId, sinceDays = 7) {
        const row = this.db.prepare(`
      SELECT
        COUNT(*) as total_requests,
        SUM(prompt_tokens) as total_prompt_tokens,
        SUM(completion_tokens) as total_completion_tokens,
        SUM(total_tokens) as total_tokens,
        SUM(cost_cents) as total_cost_cents,
        AVG(latency_ms) as avg_latency_ms
      FROM usage_log
      WHERE key_id = ? AND created_at > datetime('now', ?)
    `).get(keyId, `-${sinceDays} days`);
        const modelDist = this.db.prepare(`
      SELECT model, provider, COUNT(*) as count, SUM(total_tokens) as tokens
      FROM usage_log
      WHERE key_id = ? AND created_at > datetime('now', ?)
      GROUP BY model, provider
      ORDER BY count DESC
    `).all(keyId, `-${sinceDays} days`);
        return {
            totalRequests: row.total_requests ?? 0,
            totalPromptTokens: row.total_prompt_tokens ?? 0,
            totalCompletionTokens: row.total_completion_tokens ?? 0,
            totalTokens: row.total_tokens ?? 0,
            totalCostCents: row.total_cost_cents ?? 0,
            avgLatencyMs: Math.round(row.avg_latency_ms ?? 0),
            modelDistribution: modelDist.map((m) => ({
                model: m.model,
                provider: m.provider,
                requestCount: m.count,
                totalTokens: m.tokens,
            })),
        };
    }
    /**
     * Get daily usage aggregates for a key, for charting.
     * Returns one row per day for the last `days` days (including days with zero requests).
     */
    getDailyUsage(keyId, days = 30) {
        const rows = this.db.prepare(`
      SELECT
        date(created_at) as day,
        COUNT(*) as request_count,
        SUM(total_tokens) as total_tokens,
        SUM(cost_cents) as cost_cents
      FROM usage_log
      WHERE key_id = ? AND created_at > datetime('now', ?)
      GROUP BY date(created_at)
      ORDER BY day ASC
    `).all(keyId, `-${days} days`);
        return rows.map((r) => ({
            day: r.day,
            requestCount: r.request_count,
            totalTokens: r.total_tokens ?? 0,
            costCents: r.cost_cents ?? 0,
        }));
    }
    /**
     * Get the average output ratio for a key (for routing optimization).
     */
    /**
     * Get auto-routing analytics — tier distribution, average score, request count.
     * Only includes requests where auto-routing was used (auto_tier IS NOT NULL).
     */
    getAutoRoutingStats(sinceDays = 30) {
        const summary = this.db.prepare(`
      SELECT
        COUNT(*) as total_auto_requests,
        AVG(auto_score) as avg_score,
        MIN(auto_score) as min_score,
        MAX(auto_score) as max_score
      FROM usage_log
      WHERE auto_tier IS NOT NULL AND created_at > datetime('now', ?)
    `).get(`-${sinceDays} days`);
        const tierDist = this.db.prepare(`
      SELECT
        auto_tier as tier,
        COUNT(*) as count,
        AVG(auto_score) as avg_score,
        SUM(cost_cents) as total_cost_cents
      FROM usage_log
      WHERE auto_tier IS NOT NULL AND created_at > datetime('now', ?)
      GROUP BY auto_tier
      ORDER BY count DESC
    `).all(`-${sinceDays} days`);
        const totalRequests = this.db.prepare(`
      SELECT COUNT(*) as n FROM usage_log
      WHERE created_at > datetime('now', ?)
    `).get(`-${sinceDays} days`).n;
        return {
            totalAutoRequests: summary.total_auto_requests ?? 0,
            totalRequests,
            avgScore: summary.avg_score !== null ? Math.round(summary.avg_score * 10) / 10 : null,
            minScore: summary.min_score ?? null,
            maxScore: summary.max_score ?? null,
            tierDistribution: tierDist.map((t) => ({
                tier: t.tier,
                count: t.count,
                avgScore: Math.round(t.avg_score * 10) / 10,
                totalCostCents: t.total_cost_cents ?? 0,
            })),
        };
    }
    getOutputRatio(keyId, sinceDays = 30) {
        const row = this.db.prepare(`
      SELECT
        SUM(completion_tokens) as total_output,
        SUM(prompt_tokens) as total_input
      FROM usage_log
      WHERE key_id = ? AND created_at > datetime('now', ?)
        AND prompt_tokens > 0
    `).get(keyId, `-${sinceDays} days`);
        if (!row.total_output || !row.total_input || row.total_input === 0)
            return null;
        return row.total_output / row.total_input;
    }
}
//# sourceMappingURL=store.js.map