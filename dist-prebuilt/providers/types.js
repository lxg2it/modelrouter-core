/**
 * Provider adapter interface.
 *
 * Each provider (Anthropic, OpenAI, Google) implements this interface.
 * The adapter handles:
 * 1. Translating our OpenAI-compatible request to the provider's format
 * 2. Making the API call (streaming or non-streaming)
 * 3. Translating the provider's response back to OpenAI format
 *
 * The rest of the system never touches provider-specific formats.
 */
export {};
//# sourceMappingURL=types.js.map