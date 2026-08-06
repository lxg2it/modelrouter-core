/**
 * GET /admin        — admin dashboard HTML shell (public, client-side rendered).
 * GET /admin/stats  — admin stats JSON (session auth + admin email required).
 * POST /admin/grant-credit — grant promotional credit (session auth + admin).
 *
 * The dashboard HTML is served without authentication so it can load in a
 * browser. The page reads the session token from localStorage and fetches
 * /admin/stats with an Authorization header. This mirrors the profile page
 * pattern and avoids requiring programmatic header injection just to view the
 * page.
 *
 * Stats include aggregate data across all users:
 *   - Total user count and daily signups (last 30 days)
 *   - Total request count and daily requests (last 30 days)
 *   - Total revenue and top models
 *   - Recent signups with balances
 */
import { Hono } from 'hono';
import Database from 'better-sqlite3';
import type { AuthEnv } from '../auth/middleware.js';
import type { UserStore } from '../auth/users.js';
import type { UsageStore, AutoRoutingStats } from '../tracking/store.js';
import type { RiskScorer } from '../security/risk.js';
export interface AdminDeps {
    db: Database.Database;
    adminEmails: string[];
    userStore: UserStore;
    usageStore?: UsageStore;
    /** Risk scorer — enables /admin/risk review endpoints (watch mode). */
    risk?: RiskScorer;
}
export interface AdminStats {
    users: {
        total: number;
        last30Days: number;
        daily: DayStat[];
    };
    requests: {
        total: number;
        last30Days: number;
        daily: DayStat[];
        topModels: ModelStat[];
        statusCodes: {
            status_code: number;
            count: number;
        }[];
    };
    uiRequests: {
        total: number;
        last30Days: number;
        daily: DayStat[];
    };
    revenue: {
        totalCents: number;
        last30DaysCents: number;
        daily: DayRevenue[];
    };
    creditBalanceHeldCents: number;
    recentUsers: RecentUser[];
    topSpenders: {
        email: string;
        requests: number;
        spendCents: number;
    }[];
    userGrowth: DayStat[];
    topErrors: {
        status_code: number;
        count: number;
    }[];
    autoRouting?: AutoRoutingStats;
}
export interface DayStat {
    day: string;
    count: number;
}
export interface DayRevenue {
    day: string;
    cents: number;
}
export interface ModelStat {
    model: string;
    provider: string;
    count: number;
}
export interface RecentUser {
    email: string;
    creditBalanceCents: number;
    createdAt: string;
}
export declare function createAdminRouter(deps: AdminDeps): Hono<AuthEnv>;
//# sourceMappingURL=admin.d.ts.map