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
  failureThreshold: number; // Failures before opening
  windowMs: number;         // Window for counting failures
  cooldownMs: number;       // How long to stay open before half-open
}

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 3,
  windowMs: 60_000,       // 1 minute
  cooldownMs: 30_000,     // 30 seconds
};

export class CircuitBreaker {
  private circuits = new Map<string, CircuitState>();
  private config: CircuitBreakerConfig;

  constructor(config: Partial<CircuitBreakerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Composite key for provider+model pair.
   */
  private key(provider: ProviderName, model: string): string {
    return `${provider}:${model}`;
  }

  /**
   * Check if a provider+model is available for routing.
   */
  isAvailable(provider: ProviderName, model: string): boolean {
    const k = this.key(provider, model);
    const circuit = this.circuits.get(k);
    if (!circuit) return true;

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
  recordSuccess(provider: ProviderName, model: string): void {
    const k = this.key(provider, model);
    this.circuits.delete(k);
  }

  /**
   * Record a failed request. May trip the circuit.
   */
  recordFailure(provider: ProviderName, model: string): void {
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
  getState(provider: ProviderName, model: string): CircuitState | undefined {
    return this.circuits.get(this.key(provider, model));
  }

  /**
   * Get all open circuits (for health check endpoints).
   */
  getOpenCircuits(): Array<{ provider: ProviderName; model: string; state: CircuitState }> {
    const result: Array<{ provider: ProviderName; model: string; state: CircuitState }> = [];
    for (const [key, state] of this.circuits) {
      if (state.state !== 'closed') {
        const [provider, model] = key.split(':') as [ProviderName, string];
        result.push({ provider, model, state });
      }
    }
    return result;
  }
}
