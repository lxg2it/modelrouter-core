/**
 * POST /v1/completions — text completion endpoint.
 *
 * For models that use the legacy completions API (e.g. gpt-5.3-codex).
 * Accepts a prompt string rather than a messages array.
 */
import { Hono } from 'hono';
import type { AuthEnv } from '../auth/middleware.js';
import type { ChatDeps } from './chat.js';
export declare function createCompletionsRouter(deps: ChatDeps): Hono<AuthEnv>;
//# sourceMappingURL=completions.d.ts.map