/**
 * Circuit breaker for provider health tracking.
 *
 * Prevents cascading failures by temporarily removing unhealthy providers
 * from the routing pool. Three states:
 *
 * CLOSED (healthy) → errors accumulate → OPEN (broken) → cooldown expires → HALF_OPEN → success → CLOSED
 *                                                                                    → failure → OPEN
 */
import type { ProviderName } from '../types.js';
interface CircuitState {
    failures: number;
    lastFailure: number;
    state: 'closed' | 'open' | 'half_open';
    openedAt?: number;
}
export interface CircuitBreakerConfig {
    failureThreshold: number;
    windowMs: number;
    cooldownMs: number;
}
export declare class CircuitBreaker {
    private circuits;
    private config;
    constructor(config?: Partial<CircuitBreakerConfig>);
    /**
     * Composite key for provider+model pair.
     */
    private key;
    /**
     * Check if a provider+model is available for routing.
     */
    isAvailable(provider: ProviderName, model: string): boolean;
    /**
     * Record a successful request. Resets the circuit.
     */
    recordSuccess(provider: ProviderName, model: string): void;
    /**
     * Record a failed request. May trip the circuit.
     */
    recordFailure(provider: ProviderName, model: string): void;
    /**
     * Get current state for diagnostics.
     */
    getState(provider: ProviderName, model: string): CircuitState | undefined;
    /**
     * Get all open circuits (for health check endpoints).
     */
    getOpenCircuits(): Array<{
        provider: ProviderName;
        model: string;
        state: CircuitState;
    }>;
}
export {};
//# sourceMappingURL=circuit-breaker.d.ts.map