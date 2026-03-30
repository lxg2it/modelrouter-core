/**
 * AWS Bedrock provider adapter.
 *
 * Bedrock's Mantle endpoint is fully OpenAI-compatible, so this adapter
 * reuses the OpenAI adapter with the Bedrock base URL.
 *
 * API endpoint: https://bedrock-mantle.{region}.api.aws/v1
 * Auth: Bedrock API key as Bearer token
 * Models: GLM, DeepSeek, Qwen, Kimi, MiniMax, Mistral, and more
 */

import type { ProviderName } from '../types.js';
import { OpenAIAdapter } from './openai.js';

const BEDROCK_BASE_URL = 'https://bedrock-mantle.us-west-2.api.aws/v1';

export class BedrockAdapter extends OpenAIAdapter {
  override readonly name: ProviderName = 'bedrock';

  constructor(apiKey?: string) {
    super(apiKey, BEDROCK_BASE_URL);
  }
}
