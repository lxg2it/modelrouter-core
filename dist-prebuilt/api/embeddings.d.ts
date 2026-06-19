/**
 * POST /v1/embeddings — OpenAI-compatible embeddings endpoint.
 *
 * Supports embedding tier aliases (embed-small, embed-large) and exact model IDs.
 * Proxies to the appropriate provider, tracks usage, and deducts cost from balance.
 *
 * Embeddings are input-token-only: there are no output tokens.
 * Cost is computed as: (input_tokens / 1_000_000) * inputPer1M
 */
import { Hono } from 'hono';
import type { AuthEnv } from '../auth/middleware.js';
import type { UsageStore } from '../tracking/store.js';
import type { UserStore } from '../auth/users.js';
import type { KeyStore } from '../auth/keys.js';
export interface EmbeddingsDeps {
    usageStore: UsageStore;
    userStore?: UserStore;
    keyStore?: KeyStore;
}
export declare function createEmbeddingsRouter(deps: EmbeddingsDeps): Hono<AuthEnv>;
//# sourceMappingURL=embeddings.d.ts.map