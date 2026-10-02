import { expect } from "bun:test";
import type { SQL } from "bun";

export async function assertAllWalletsMatchLedger(sql: SQL): Promise<void> {
  const divergent = await sql`
    SELECT w.id,
           w.balance::text AS balance,
           w.version::int AS version,
           coalesce(sum(CASE e.direction WHEN 'CREDIT' THEN e.amount ELSE -e.amount END), 0)::text AS rebuilt_balance,
           (count(e.id) FILTER (WHERE t.kind <> 'OPENING'))::int AS movements,
           (SELECT l.balance_after::text FROM wallet_ledger_entries l
             WHERE l.wallet_id = w.id ORDER BY l.wallet_version DESC LIMIT 1) AS last_balance_after
      FROM wallets w
      LEFT JOIN wallet_ledger_entries e ON e.wallet_id = w.id
      LEFT JOIN wager_transactions t ON t.id = e.transaction_id
     GROUP BY w.id
    HAVING w.balance <> coalesce(sum(CASE e.direction WHEN 'CREDIT' THEN e.amount ELSE -e.amount END), 0)
        OR w.version <> 1 + count(e.id) FILTER (WHERE t.kind <> 'OPENING')
        OR w.balance <> coalesce((SELECT l.balance_after FROM wallet_ledger_entries l
                                   WHERE l.wallet_id = w.id ORDER BY l.wallet_version DESC LIMIT 1), 0)`;
  expect(divergent).toEqual([]);
}
