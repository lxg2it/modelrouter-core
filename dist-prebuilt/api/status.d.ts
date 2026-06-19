/**
 * GET /status — uptime and health history.
 *
 * Shows 90-day provider uptime derived from real traffic in usage_log,
 * plus an overall status banner. No synthetic pings required — actual
 * request success/error rates tell the truth.
 */
import { Hono } from 'hono';
import Database from 'better-sqlite3';
export declare function createStatusRouter(db: Database.Database): Hono;
//# sourceMappingURL=status.d.ts.map