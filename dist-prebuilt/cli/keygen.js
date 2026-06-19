/**
 * CLI for API key management.
 *
 * Usage:
 *   npx tsx src/cli/keygen.ts generate --tier standard --name "my-app"
 *   npx tsx src/cli/keygen.ts list
 *   npx tsx src/cli/keygen.ts revoke --id <key-id>
 */
import Database from 'better-sqlite3';
import { KeyStore } from '../auth/keys.js';
const DB_PATH = process.env.DB_PATH ?? './data/modelrouter.db';
function main() {
    const args = process.argv.slice(2);
    const command = args[0];
    const db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    const keyStore = new KeyStore(db);
    try {
        switch (command) {
            case 'generate':
            case 'gen': {
                const name = getArg(args, '--name');
                const { fullKey, record } = keyStore.generate(name);
                console.log('\n🔑 New API key generated:\n');
                console.log(`  Key:    ${fullKey}`);
                console.log(`  ID:     ${record.id}`);
                console.log(`  Name:   ${record.name ?? '(none)'}`);
                console.log(`\n⚠️  Save this key now — it won't be shown again.\n`);
                break;
            }
            case 'list':
            case 'ls': {
                const keys = keyStore.list();
                if (keys.length === 0) {
                    console.log('No API keys found.');
                    break;
                }
                console.log('\nAPI Keys:\n');
                console.log('  ID              Prefix           Name             Active  Last Used');
                console.log('  ─────────────── ──────────────── ──────────────── ─────── ─────────');
                for (const key of keys) {
                    console.log(`  ${key.id.padEnd(16)} ${key.keyPrefix.padEnd(16)} ${(key.name ?? '').padEnd(16)} ${key.active ? 'yes' : 'no'}     ${key.lastUsedAt ?? 'never'}`);
                }
                console.log();
                break;
            }
            case 'revoke': {
                const id = getArg(args, '--id');
                if (!id) {
                    console.error('Usage: revoke --id <key-id>');
                    process.exit(1);
                }
                const success = keyStore.revoke(id);
                if (success) {
                    console.log(`✅ Key ${id} revoked.`);
                }
                else {
                    console.error(`❌ Key ${id} not found.`);
                }
                break;
            }
            default:
                console.log(`
Model Router — API Key Management

Usage:
  keygen generate --tier <tier> [--name <name>]   Generate a new API key
  keygen list                                     List all keys
  keygen revoke --id <key-id>                     Revoke a key

Tiers: economy, standard, premium
        `);
        }
    }
    finally {
        db.close();
    }
}
function getArg(args, flag, fallback) {
    const idx = args.indexOf(flag);
    if (idx === -1 || idx + 1 >= args.length)
        return fallback;
    return args[idx + 1];
}
main();
//# sourceMappingURL=keygen.js.map