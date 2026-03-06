/**
 * Z.ai provider adapter.
 *
 * Z.ai's API is OpenAI-compatible. This adapter reuses the OpenAI adapter
 * with Z.ai's base URL and the 'zai' provider name.
 *
 * API endpoint: https://api.z.ai/api/paas/v4
 * Models: GLM-5 (premium), GLM-4.7 (standard), GLM-4.7-Flash (economy)
 */

import type { ProviderName } from '../types.js';
import { OpenAIAdapter } from './openai.js';

const ZAI_BASE_URL = 'https://api.z.ai/api/paas/v4';

export class ZaiAdapter extends OpenAIAdapter {
  override readonly name: ProviderName = 'zai';

  constructor(apiKey?: string) {
    super(apiKey, ZAI_BASE_URL);
  }
}
