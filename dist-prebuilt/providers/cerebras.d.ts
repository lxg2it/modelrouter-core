/**
 * Cerebras provider adapter.
 *
 * Cerebras's API is fully OpenAI-compatible. This adapter reuses the OpenAI adapter
 * with Cerebras's base URL and the 'cerebras' provider name.
 *
 * Cerebras offers a permanent free tier (30 RPM, 14,400 RPD) powered by
 * Cerebras Wafer-Scale Engine silicon — significantly faster inference than GPU.
 * Free-tier models include: Llama 3.3 70B, Qwen3 235B, GPT-OSS-120B, and others.
 *
 * API endpoint: https://api.cerebras.ai/v1
 * Console:      https://cloud.cerebras.ai/
 */
import type { ProviderName } from '../types.js';
import { OpenAIAdapter } from './openai.js';
export declare class CerebrasAdapter extends OpenAIAdapter {
    readonly name: ProviderName;
    constructor(apiKey?: string);
}
//# sourceMappingURL=cerebras.d.ts.map