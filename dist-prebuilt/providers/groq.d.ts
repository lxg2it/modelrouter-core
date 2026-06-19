/**
 * Groq provider adapter.
 *
 * Groq's API is fully OpenAI-compatible. This adapter reuses the OpenAI adapter
 * with Groq's base URL and the 'groq' provider name.
 *
 * Groq offers a permanent free tier (30 RPM, 14,400 RPD) and paid tier.
 * Free-tier models include: Llama 3.3 70B, Llama 4 Scout, and others.
 *
 * API endpoint: https://api.groq.com/openai/v1
 * Console:      https://console.groq.com/keys
 */
import type { ProviderName } from '../types.js';
import { OpenAIAdapter } from './openai.js';
export declare class GroqAdapter extends OpenAIAdapter {
    readonly name: ProviderName;
    constructor(apiKey?: string);
}
//# sourceMappingURL=groq.d.ts.map