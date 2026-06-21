/**
 * POST /v1/messages — Anthropic Messages API compatibility endpoint.
 *
 * Accepts native Anthropic Messages API format and routes through
 * the same engine as /v1/chat/completions. Two execution paths:
 *
 * 1. Native passthrough (Anthropic, xAI):
 *    → Forward raw Anthropic request to provider's Messages API
 *    → Return raw Anthropic response (full fidelity)
 *
 * 2. Translation path (OpenAI, Google, Groq, Cerebras):
 *    → Translate Anthropic → OpenAI format
 *    → Route through existing provider adapter
 *    → Translate OpenAI response → Anthropic format
 */
import { Hono } from 'hono';
import type { AuthEnv } from '../auth/middleware.js';
import type { RoutingEngine } from '../routing/engine.js';
import type { ProviderAdapter } from '../providers/types.js';
import type { NativeAnthropicClient } from '../providers/anthropic-native.js';
import type { UsageLogger } from '../tracking/logger.js';
import type { SatbillClient } from '../billing/satbill-client.js';
import type { KeyStore } from '../auth/keys.js';
import type { UserStore } from '../auth/users.js';
import type { EmailSender } from '../auth/email.js';
import type { StripeService } from '../billing/stripe.js';
import type { BillingTransactionStore } from '../billing/transactions.js';
import type { ProviderName } from '../types.js';
export interface MessagesDeps {
    router: RoutingEngine;
    providers: Map<ProviderName, ProviderAdapter>;
    nativeClients: Map<string, NativeAnthropicClient>;
    logger: UsageLogger;
    billing?: SatbillClient;
    userStore?: UserStore;
    keyStore?: KeyStore;
    stripe?: StripeService;
    billingTxStore?: BillingTransactionStore;
    maxDailySpendCents?: number;
    emailSender?: EmailSender;
}
export declare function createMessagesRouter(deps: MessagesDeps): Hono<AuthEnv>;
//# sourceMappingURL=messages.d.ts.map