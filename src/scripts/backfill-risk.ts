/**
 * Risk backfill CLI — injects forensic event trails into the risk scorer.
 *
 * Reads a farmer manifest (JSON array of { userId, email, name, created,
 * signupIp, probes[], inferences[], evidence[] }) and feeds each account's
 * historical events through RiskScorer.backfill(), which uses the exact same
 * idempotent recompute path as live events. The result: the /admin/risk-watch
 * dashboard shows these accounts with the scores they would have earned live.
 *
 * Usage:
 *   node dist/scripts/backfill-risk.js <manifest.json> [--dry-run]
 *
 * Safe to re-run: backfill is idempotent (same trail → same score).
 * Respects the 'cleared' recovery lock (human-reviewed accounts are skipped).
 */

import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { RiskScorer } from '../security/risk.js';

interface BackfillInference { at: string; model: string; cost: number }
interface BackfillProbe { at: string; path: string }
interface BackfillAccount {
  userId: string;
  email: string;
  name?: string;
  created: string;
  signupIp?: string | null;
  evidence?: string[];
  probes?: BackfillProbe[];
  inferences?: BackfillInference[];
}

/** Normalise '2026-03-08 15:31:59' / '2026-07-28T10:50:42Z' → ISO with Z. */
function toIso(raw: string): string {
  const s = raw.trim();
  if (s.includes('T')) return s.endsWith('Z') ? s : `${s}Z`;
  return `${s.replace(' ', 'T')}Z`; // sqlite datetime('now') is UTC
}

function main(): void {
  const [manifestPath] = process.argv.slice(2);
  const dryRun = process.argv.includes('--dry-run');
  if (!manifestPath) {
    console.error('Usage: node dist/scripts/backfill-risk.js <manifest.json> [--dry-run]');
    process.exit(1);
  }

  const dbPath = process.env.DB_PATH ?? './data/modelrouter.db';
  const db = new Database(dbPath);
  const scorer = new RiskScorer(db, { quiet: true });

  const accounts = JSON.parse(readFileSync(manifestPath, 'utf8')) as BackfillAccount[];
  console.log(`[backfill] ${accounts.length} accounts, db=${dbPath}${dryRun ? ' (DRY RUN)' : ''}`);

  let injected = 0;
  let skipped = 0;
  let errors = 0;

  for (const a of accounts) {
    try {
      const events = [];
      events.push({
        t: 'signup',
        at: toIso(a.created),
        email: a.email,
        ip: a.signupIp ?? 'unknown',
        hasName: !!(a.name && a.name.trim()),
      });
      for (const p of a.probes ?? []) {
        events.push({ t: 'probe', at: toIso(p.at), path: p.path });
      }
      for (const i of a.inferences ?? []) {
        events.push({ t: 'inference', at: toIso(i.at), model: i.model, costCents: i.cost });
      }

      if (dryRun) {
        injected++;
        console.log(`  [dry] ${a.email} — ${events.length} events (${(a.evidence ?? []).join(', ') || 'no evidence'})`);
        continue;
      }

      scorer.backfill(a.userId, events as never);
      const risk = scorer.getRisk(a.userId);
      injected++;
      console.log(
        `  ${risk?.level ?? '?'} ${String(risk?.score ?? '?').padStart(3)}  ${a.email.padEnd(48)} ` +
        `${events.length} events (${(a.evidence ?? []).join(', ') || 'no evidence'})`,
      );
    } catch (err) {
      errors++;
      console.error(`  ERROR ${a.email}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(`[backfill] done — injected ${injected}, skipped ${skipped}, errors ${errors}${dryRun ? ' (dry run, nothing written)' : ''}`);
  db.close();
}

main();
