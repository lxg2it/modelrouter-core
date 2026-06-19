/**
 * Grok (xAI) provider adapter.
 *
 * xAI's API is fully OpenAI-compatible. This adapter reuses the OpenAI adapter
 * with xAI's base URL and the 'grok' provider name.
 *
 * API endpoint: https://api.x.ai/v1
 * Models: grok-3-beta (standard), grok-3-mini-beta (economy)
 */
import { OpenAIAdapter } from './openai.js';
const GROK_BASE_URL = 'https://api.x.ai/v1';
export class GrokAdapter extends OpenAIAdapter {
    name = 'grok';
    constructor(apiKey) {
        super(apiKey, GROK_BASE_URL);
    }
}
//# sourceMappingURL=grok.js.map