/**
 * Risk backfill CLI — injects forensic event trails into the risk scorer.
 *
 * Reads a farmer manifest (JSON array of { userId, email, name, created,
 * signupIp, probes[], inferences[], evidence[] }) and feeds each account's
 * historical events through RiskScorer.backfill(), which uses the exact same
 * idempotent recompute path as live events. The result: the /admin/risk-watch
 * dashboard shows these accounts with the scores they would have earned live.
 *
 * Usage:
 *   node dist/scripts/backfill-risk.js <manifest.json> [--dry-run]
 *
 * Safe to re-run: backfill is idempotent (same trail → same score).
 * Respects the 'cleared' recovery lock (human-reviewed accounts are skipped).
 */
export {};
//# sourceMappingURL=backfill-risk.d.ts.map