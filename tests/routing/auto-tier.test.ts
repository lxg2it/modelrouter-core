/**
 * Tests for auto-tier classification.
 *
 * These tests verify that the heuristic scorer correctly infers tier from
 * conversation context. The key insight being tested: classification should
 * look at the FULL messages array, not just the last message.
 */

import { describe, it, expect } from 'vitest';
import { classifyAutoTier } from '../../src/routing/auto-tier.js';
import type { ChatMessage } from '../../src/types.js';

describe('classifyAutoTier', () => {
  // ─── Economy tier: genuinely simple conversations ─────────

  describe('economy tier', () => {
    it('classifies a simple greeting as economy', () => {
      const messages: ChatMessage[] = [
        { role: 'user', content: 'Hello!' },
      ];
      const result = classifyAutoTier(messages);
      expect(result.tier).toBe('economy');
      expect(result.score).toBeLessThanOrEqual(20);
    });

    it('classifies a simple factual question as economy', () => {
      const messages: ChatMessage[] = [
        { role: 'user', content: 'What is the capital of France?' },
      ];
      const result = classifyAutoTier(messages);
      expect(result.tier).toBe('economy');
    });

    it('classifies basic math as economy', () => {
      const messages: ChatMessage[] = [
        { role: 'user', content: 'What is 2 + 2?' },
      ];
      const result = classifyAutoTier(messages);
      expect(result.tier).toBe('economy');
    });

    it('classifies a yes/no question with no context as economy', () => {
      const messages: ChatMessage[] = [
        { role: 'user', content: 'Is the sky blue?' },
      ];
      const result = classifyAutoTier(messages);
      expect(result.tier).toBe('economy');
    });
  });

  // ─── Standard tier: typical developer conversations ───────

  describe('standard tier', () => {
    it('classifies a simple coding question as economy (economy models handle these well)', () => {
      const messages: ChatMessage[] = [
        { role: 'user', content: 'Write a Python function that sorts a list of dictionaries by a given key.' },
      ];
      const result = classifyAutoTier(messages);
      // Simple single-message coding tasks don't need standard-tier models.
      // GPT-4.1-mini / Claude Haiku handle these perfectly.
      expect(result.tier).toBe('economy');
    });

    it('classifies a more complex coding question as standard', () => {
      const messages: ChatMessage[] = [
        { role: 'user', content: 'Write a TypeScript module that implements a generic retry mechanism with exponential backoff, circuit breaker pattern, and configurable timeout. It should support async functions and provide detailed error logging.' },
      ];
      const result = classifyAutoTier(messages);
      expect(result.tier).toBe('standard');
    });

    it('classifies a conversation with code blocks as standard', () => {
      const messages: ChatMessage[] = [
        { role: 'user', content: 'Here is my code:\n```typescript\nfunction add(a: number, b: number): number {\n  return a + b;\n}\n```\nCan you add error handling?' },
      ];
      const result = classifyAutoTier(messages);
      expect(result.tier).toBe('standard');
    });

    it('classifies a multi-turn coding conversation as standard or higher', () => {
      const messages: ChatMessage[] = [
        { role: 'user', content: 'I need help with a TypeScript module for parsing CSV files.' },
        { role: 'assistant', content: 'Here\'s a basic approach using a class:\n```typescript\nclass CSVParser {\n  parse(input: string): string[][] {\n    return input.split("\\n").map(row => row.split(","));\n  }\n}\n```' },
        { role: 'user', content: 'Can you add support for quoted fields?' },
        { role: 'assistant', content: 'Sure, here\'s an updated version that handles quotes...\n```typescript\n// Updated parser...\n```' },
        { role: 'user', content: 'Looks good, now add streaming support.' },
      ];
      const result = classifyAutoTier(messages);
      expect(['standard', 'premium']).toContain(result.tier);
      expect(result.score).toBeGreaterThan(20);
    });

    it('classifies a simple database question as economy (economy models handle these well)', () => {
      const messages: ChatMessage[] = [
        { role: 'user', content: 'How do I write a Postgres query to find duplicate rows in a table?' },
      ];
      const result = classifyAutoTier(messages);
      // Simple factual database questions don't require standard-tier.
      expect(result.tier).toBe('economy');
    });

    it('classifies a complex database question as standard', () => {
      const messages: ChatMessage[] = [
        { role: 'user', content: 'I need to optimize a PostgreSQL query that joins 5 tables with complex aggregations. The query currently takes 30 seconds on a table with 50M rows. Here is the explain analyze output and the schema. How should I refactor the query and what indexes should I add?' },
      ];
      const result = classifyAutoTier(messages);
      expect(['standard', 'premium']).toContain(result.tier);
    });
  });

  // ─── Premium tier: complex tasks ──────────────────────────

  describe('premium tier', () => {
    it('classifies system design as premium', () => {
      const messages: ChatMessage[] = [
        { role: 'user', content: 'Design a distributed system for a real-time multiplayer game. Consider consensus algorithm choices, event sourcing for game state, and how to handle network partitions.' },
      ];
      const result = classifyAutoTier(messages);
      expect(result.tier).toBe('premium');
      expect(result.score).toBeGreaterThan(55);
    });

    it('classifies formal reasoning requests as premium', () => {
      const messages: ChatMessage[] = [
        { role: 'user', content: 'Prove that the halting problem is undecidable using a proof by contradiction.' },
      ];
      const result = classifyAutoTier(messages);
      expect(result.tier).toBe('premium');
    });

    it('classifies deep code review with architecture context as premium', () => {
      const messages: ChatMessage[] = [
        { role: 'system', content: 'You are a senior software architect reviewing a microservices migration. The codebase has 200k lines of TypeScript across 15 services. Focus on identifying coupling issues, shared state problems, and transaction boundary violations. Consider the implications for eventual consistency and the saga pattern.' },
        { role: 'user', content: 'Review this code and analyze the trade-offs of the current approach:\n```typescript\nclass OrderService {\n  async createOrder(items: Item[]) {\n    const inventory = await this.inventoryClient.reserve(items);\n    const payment = await this.paymentClient.charge(this.calculateTotal(items));\n    if (!payment.success) {\n      await this.inventoryClient.release(inventory.reservationId);\n      throw new Error("Payment failed");\n    }\n    return this.orderRepo.save({ items, inventoryReservation: inventory.reservationId });\n  }\n}\n```' },
      ];
      const result = classifyAutoTier(messages);
      expect(result.tier).toBe('premium');
    });
  });

  // ─── The critical test: short messages in complex context ─

  describe('context-aware classification', () => {
    it('"yes please" in a coding conversation routes to standard or higher, not economy', () => {
      const messages: ChatMessage[] = [
        { role: 'system', content: 'You are a senior TypeScript developer helping build a REST API with Express, PostgreSQL, and Docker.' },
        { role: 'user', content: 'I need to add authentication middleware to my Express app.' },
        { role: 'assistant', content: 'Here\'s a JWT authentication middleware:\n```typescript\nimport jwt from "jsonwebtoken";\n\nexport function authMiddleware(req, res, next) {\n  const token = req.headers.authorization?.split(" ")[1];\n  if (!token) return res.status(401).json({ error: "No token" });\n  try {\n    req.user = jwt.verify(token, process.env.JWT_SECRET);\n    next();\n  } catch {\n    res.status(401).json({ error: "Invalid token" });\n  }\n}\n```\nShall I also add refresh token support?' },
        { role: 'user', content: 'yes please' },
      ];
      const result = classifyAutoTier(messages);
      expect(result.tier).not.toBe('economy');
      expect(result.score).toBeGreaterThan(20);
    });

    it('"do it" in an architecture discussion routes to standard or higher', () => {
      const messages: ChatMessage[] = [
        { role: 'user', content: 'I want to refactor our monolith into microservices. We currently have a Django app with models for users, orders, payments, and inventory.' },
        { role: 'assistant', content: 'Here\'s a suggested decomposition...\n\nI\'d recommend starting with the payment service since it has the clearest domain boundary. The key trade-offs to consider are...' },
        { role: 'user', content: 'do it' },
      ];
      const result = classifyAutoTier(messages);
      expect(result.tier).not.toBe('economy');
    });

    it('"looks good" after code review routes to standard or higher', () => {
      const messages: ChatMessage[] = [
        { role: 'user', content: '```python\ndef process_data(records):\n    results = []\n    for r in records:\n        if r["status"] == "active":\n            transformed = transform(r)\n            results.append(transformed)\n    return results\n```\nCan you optimize this?' },
        { role: 'assistant', content: 'Here\'s an optimized version using list comprehension and generator patterns:\n```python\ndef process_data(records):\n    return [transform(r) for r in records if r["status"] == "active"]\n```\nThis is more Pythonic and slightly faster. Want me to add type hints too?' },
        { role: 'user', content: 'looks good, add the type hints' },
      ];
      const result = classifyAutoTier(messages);
      expect(result.tier).not.toBe('economy');
    });
  });

  // ─── Tool usage ───────────────────────────────────────────

  describe('tool usage', () => {
    it('conversations with tool calls score higher', () => {
      const messages: ChatMessage[] = [
        { role: 'user', content: 'Find the error in the logs' },
        {
          role: 'assistant',
          content: 'Let me check the logs.',
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"error.log"}' } },
          ],
        },
        { role: 'tool', content: 'Error: Connection refused at port 5432', tool_call_id: 'call_1' },
        { role: 'assistant', content: 'The database connection is failing. Let me check the config...' },
        { role: 'user', content: 'fix it' },
      ];
      const result = classifyAutoTier(messages);
      expect(result.tier).not.toBe('economy');
      expect(result.signals.toolUsage).toBeGreaterThan(0);
    });
  });

  // ─── System prompt influence ──────────────────────────────

  describe('system prompt influence', () => {
    it('long detailed system prompt pushes toward higher tiers', () => {
      const longSystemPrompt = `You are an expert software architect with 20 years of experience.
Your role is to review code for security vulnerabilities, performance issues,
and architectural problems. You should consider OWASP top 10, SOLID principles,
and clean architecture patterns. When reviewing, provide specific line-by-line
feedback with severity ratings (critical, major, minor, info). Always suggest
concrete fixes with code examples. Consider thread safety, memory leaks, and
resource management. Factor in the broader system context when making recommendations.
Your reviews should be thorough but actionable — every finding should have a clear
remediation path. Consider edge cases, error handling, and failure modes.
Format your response as a structured review with sections for each finding.`;

      const withSystem: ChatMessage[] = [
        { role: 'system', content: longSystemPrompt },
        { role: 'user', content: 'Review this code please' },
      ];
      const withoutSystem: ChatMessage[] = [
        { role: 'user', content: 'Review this code please' },
      ];

      const withSystemResult = classifyAutoTier(withSystem);
      const withoutSystemResult = classifyAutoTier(withoutSystem);

      expect(withSystemResult.score).toBeGreaterThan(withoutSystemResult.score);
    });

    it('minimal system prompt does not inflate score', () => {
      const messages: ChatMessage[] = [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'Hi' },
      ];
      const result = classifyAutoTier(messages);
      expect(result.tier).toBe('economy');
    });
  });

  // ─── Signal breakdown transparency ────────────────────────

  describe('signal breakdown', () => {
    it('returns all expected signal fields', () => {
      const messages: ChatMessage[] = [
        { role: 'user', content: 'Hello' },
      ];
      const result = classifyAutoTier(messages);
      expect(result.signals).toHaveProperty('systemPromptLength');
      expect(result.signals).toHaveProperty('codeBlocks');
      expect(result.signals).toHaveProperty('technicalKeywords');
      expect(result.signals).toHaveProperty('conversationDepth');
      expect(result.signals).toHaveProperty('toolUsage');
      expect(result.signals).toHaveProperty('messageComplexity');
      expect(result.signals).toHaveProperty('reasoningMarkers');
    });

    it('score is bounded 0–100', () => {
      // Test with a maximally complex conversation
      const messages: ChatMessage[] = [
        { role: 'system', content: 'A'.repeat(10000) },
        { role: 'user', content: 'Design a microservices architecture with consensus algorithm and event sourcing. Prove the halting problem is undecidable. Step by step analyze the trade-offs.\n```typescript\nconst x = 1;\n```\n```python\ndef f(): pass\n```\n```rust\nfn main() {}\n```\n```go\nfunc main() {}\n```\n```java\nclass X {}\n```' },
        {
          role: 'assistant',
          content: 'response',
          tool_calls: [
            { id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } },
            { id: 'c2', type: 'function', function: { name: 'g', arguments: '{}' } },
          ],
        },
        { role: 'tool', content: 'result', tool_call_id: 'c1' },
        { role: 'tool', content: 'result', tool_call_id: 'c2' },
      ];
      const result = classifyAutoTier(messages);
      expect(result.score).toBeLessThanOrEqual(100);
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.tier).toBe('premium');
    });
  });

  // ─── Multi-part content ───────────────────────────────────

  describe('multi-part content', () => {
    it('handles content arrays correctly', () => {
      const messages: ChatMessage[] = [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Design a distributed system with consensus algorithm' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,...' } },
          ],
        },
      ];
      const result = classifyAutoTier(messages);
      expect(result.tier).not.toBe('economy');
    });
  });

  // ─── Edge cases ───────────────────────────────────────────

  describe('edge cases', () => {
    it('handles empty messages array', () => {
      const result = classifyAutoTier([]);
      expect(result.tier).toBe('economy');
      expect(result.score).toBe(0);
    });

    it('handles messages with empty content', () => {
      const messages: ChatMessage[] = [
        { role: 'user', content: '' },
      ];
      const result = classifyAutoTier(messages);
      expect(result.tier).toBe('economy');
    });

    it('handles messages with null-ish content gracefully', () => {
      const messages: ChatMessage[] = [
        { role: 'user', content: undefined as unknown as string },
      ];
      // Should not throw
      const result = classifyAutoTier(messages);
      expect(result.tier).toBe('economy');
    });
  });
});
