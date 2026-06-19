/**
 * Circuit breaker for provider health tracking.
 *
 * Prevents cascading failures by temporarily removing unhealthy providers
 * from the routing pool. Three states:
 *
 * CLOSED (healthy) → errors accumulate → OPEN (broken) → cooldown expires → HALF_OPEN → success → CLOSED
 *                                                                                    → failure → OPEN
 */
const DEFAULT_CONFIG = {
    failureThreshold: 3,
    windowMs: 60_000, // 1 minute
    cooldownMs: 30_000, // 30 seconds
};
export class CircuitBreaker {
    circuits = new Map();
    config;
    constructor(config = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };
    }
    /**
     * Composite key for provider+model pair.
     */
    key(provider, model) {
        return `${provider}:${model}`;
    }
    /**
     * Check if a provider+model is available for routing.
     */
    isAvailable(provider, model) {
        const k = this.key(provider, model);
        const circuit = this.circuits.get(k);
        if (!circuit)
            return true;
        const now = Date.now();
        switch (circuit.state) {
            case 'closed':
                return true;
            case 'open': {
                // Check if cooldown has expired → transition to half_open
                if (circuit.openedAt && now - circuit.openedAt >= this.config.cooldownMs) {
                    circuit.state = 'half_open';
                    return true; // Allow one test request
                }
                return false;
            }
            case 'half_open':
                return true; // Allow test request
        }
    }
    /**
     * Record a successful request. Resets the circuit.
     */
    recordSuccess(provider, model) {
        const k = this.key(provider, model);
        this.circuits.delete(k);
    }
    /**
     * Record a failed request. May trip the circuit.
     */
    recordFailure(provider, model) {
        const k = this.key(provider, model);
        const now = Date.now();
        let circuit = this.circuits.get(k);
        if (!circuit) {
            circuit = { failures: 0, lastFailure: 0, state: 'closed' };
            this.circuits.set(k, circuit);
        }
        // If in half_open state and we got a failure → back to open
        if (circuit.state === 'half_open') {
            circuit.state = 'open';
            circuit.openedAt = now;
            return;
        }
        // If the last failure was outside the window, reset the count
        if (now - circuit.lastFailure > this.config.windowMs) {
            circuit.failures = 0;
        }
        circuit.failures++;
        circuit.lastFailure = now;
        // Trip the circuit if threshold exceeded
        if (circuit.failures >= this.config.failureThreshold) {
            circuit.state = 'open';
            circuit.openedAt = now;
        }
    }
    /**
     * Get current state for diagnostics.
     */
    getState(provider, model) {
        return this.circuits.get(this.key(provider, model));
    }
    /**
     * Get all open circuits (for health check endpoints).
     */
    getOpenCircuits() {
        const result = [];
        for (const [key, state] of this.circuits) {
            if (state.state !== 'closed') {
                const [provider, model] = key.split(':');
                result.push({ provider, model, state });
            }
        }
        return result;
    }
}
//# sourceMappingURL=circuit-breaker.js.map