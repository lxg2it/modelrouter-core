import { describe, it, expect } from 'vitest';
import { computeQualityScores, BENCHMARK_DATA, BENCHMARK_WEIGHTS } from '../src/benchmarks.js';
import { TIERS } from '../src/config.js';

describe('benchmarks', () => {
  describe('computeQualityScores', () => {
    it('returns a score for every model in BENCHMARK_DATA', () => {
      const scores = computeQualityScores();
      for (const id of Object.keys(BENCHMARK_DATA)) {
        expect(scores[id]).toBeTypeOf('number');
        expect(scores[id]).toBeGreaterThanOrEqual(0.50);
        expect(scores[id]).toBeLessThanOrEqual(1.00);
      }
    });

    it('best model scores 1.00 and worst scores 0.50', () => {
      const scores = computeQualityScores();
      const values = Object.values(scores);
      expect(Math.max(...values)).toBe(1.00);
      expect(Math.min(...values)).toBe(0.50);
    });

    it('premium models score higher than economy models on average', () => {
      const scores = computeQualityScores();
      const avg = (models: typeof TIERS.economy.models) =>
        models.reduce((sum, m) => sum + (scores[m.model] ?? 0), 0) / models.length;

      expect(avg(TIERS.premium.models)).toBeGreaterThan(avg(TIERS.economy.models));
      expect(avg(TIERS.standard.models)).toBeGreaterThan(avg(TIERS.economy.models));
    });

    it('all TIERS models have benchmark data', () => {
      for (const [, cfg] of Object.entries(TIERS)) {
        for (const m of cfg.models) {
          expect(BENCHMARK_DATA[m.model], `missing benchmark data for ${m.model}`).toBeDefined();
        }
      }
    });

    it('weights sum to 1.0', () => {
      const total = Object.values(BENCHMARK_WEIGHTS).reduce((a, b) => a + b, 0);
      expect(total).toBeCloseTo(1.0, 5);
    });
  });
});
