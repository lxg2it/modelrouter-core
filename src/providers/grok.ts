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

const GROK_BASE_URL = 'https://api.x.ai/v1';

export class GrokAdapter extends OpenAIAdapter {
  override readonly name: ProviderName = 'grok';

  constructor(apiKey?: string) {
    super(apiKey, GROK_BASE_URL);
  }
}
