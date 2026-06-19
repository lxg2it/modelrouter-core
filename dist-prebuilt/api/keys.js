/**
 * Key management routes — list, create, revoke, rename.
 *
 * All routes require a session token (mr_st_...) in the Authorization header.
 * These are account management operations, not inference operations.
 *
 * Routes:
 *   GET    /v1/keys          — list all keys for the authenticated user
 *   POST   /v1/keys          — create a new key
 *   DELETE /v1/keys/:id      — revoke a key (the key that triggered this request, or any owned key)
 *   PATCH  /v1/keys/:id      — rename a key
 */
import { Hono } from 'hono';
export function createKeysRouter(deps) {
    const { keyStore, usageStore } = deps;
    const router = new Hono();
    // ─── GET /v1/keys ─────────────────────────────────────────
    //
    // Returns all keys (active and revoked) for the authenticated user,
    // with recent usage stats for each.
    //
    router.get('/', (c) => {
        const user = c.get('user');
        const keys = keyStore.listByUser(user.id);
        const keysWithStats = keys.map((key) => {
            const usage7d = usageStore.getUsageSummary(key.id, 7);
            return {
                id: key.id,
                keyPrefix: key.keyPrefix,
                name: key.name ?? null,
                active: key.active,
                createdAt: key.createdAt,
                lastUsedAt: key.lastUsedAt ?? null,
                usage7d: {
                    requestCount: usage7d.totalRequests,
                    costCents: usage7d.totalCostCents,
                    costUsd: formatUsd(usage7d.totalCostCents),
                },
            };
        });
        return c.json({ keys: keysWithStats });
    });
    // ─── POST /v1/keys ────────────────────────────────────────
    //
    // Create a new API key for the authenticated user.
    // Returns the full key (shown ONCE) and the key record.
    //
    router.post('/', async (c) => {
        const user = c.get('user');
        let body = {};
        try {
            body = await c.req.json();
        }
        catch {
            // Empty body is fine
        }
        const name = typeof body.name === 'string' && body.name.trim().length > 0
            ? body.name.trim().slice(0, 100)
            : undefined;
        const { fullKey, record } = keyStore.generate(name, undefined, user.id);
        return c.json({
            key: fullKey,
            keyPrefix: record.keyPrefix,
            id: record.id,
            name: record.name ?? null,
            active: record.active,
            createdAt: record.createdAt,
            message: 'Save your API key — it will not be shown again.',
        }, 201);
    });
    // ─── DELETE /v1/keys/:id ──────────────────────────────────
    //
    // Revoke a key. The key is deactivated immediately — any in-flight
    // requests using it will fail on next auth check.
    //
    // This is the critical operation for fund protection: if a key is
    // compromised, the account holder can log in here and revoke it
    // without needing to possess the key itself.
    //
    router.delete('/:id', (c) => {
        const user = c.get('user');
        const keyId = c.req.param('id');
        const revoked = keyStore.revokeForUser(keyId, user.id);
        if (!revoked) {
            return c.json({
                error: {
                    message: 'Key not found or not owned by this account.',
                    code: 'not_found',
                },
            }, 404);
        }
        return c.json({ ok: true, keyId, status: 'revoked' });
    });
    // ─── PATCH /v1/keys/:id ───────────────────────────────────
    //
    // Rename a key. Useful for organising keys by project, team member, etc.
    //
    router.patch('/:id', async (c) => {
        const user = c.get('user');
        const keyId = c.req.param('id');
        let body = {};
        try {
            body = await c.req.json();
        }
        catch {
            return c.json({
                error: { message: 'Invalid JSON body', code: 'invalid_request' },
            }, 400);
        }
        if (!('name' in body)) {
            return c.json({
                error: { message: 'No fields to update', code: 'invalid_request' },
            }, 400);
        }
        const name = body.name === null
            ? null
            : typeof body.name === 'string' && body.name.trim().length > 0
                ? body.name.trim().slice(0, 100)
                : undefined;
        if (name === undefined) {
            return c.json({
                error: { message: 'name must be a non-empty string or null', code: 'invalid_request' },
            }, 400);
        }
        const updated = keyStore.renameForUser(keyId, user.id, name);
        if (!updated) {
            return c.json({
                error: {
                    message: 'Key not found or not owned by this account.',
                    code: 'not_found',
                },
            }, 404);
        }
        return c.json({ ok: true, keyId, name });
    });
    return router;
}
function formatUsd(cents) {
    return `$${(cents / 100).toFixed(2)}`;
}
//# sourceMappingURL=keys.js.map