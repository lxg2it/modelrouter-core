/**
 * Grok (xAI) provider adapter.
 *
 * xAI's API is fully OpenAI-compatible. This adapter reuses the OpenAI adapter
 * with xAI's base URL and the 'grok' provider name.
 *
 * API endpoint: https://api.x.ai/v1
 * Models: grok-3-beta (standard), grok-3-mini-beta (economy)
 */
import type { ProviderName } from '../types.js';
import { OpenAIAdapter } from './openai.js';
export declare class GrokAdapter extends OpenAIAdapter {
    readonly name: ProviderName;
    constructor(apiKey?: string);
}
//# sourceMappingURL=grok.d.ts.map