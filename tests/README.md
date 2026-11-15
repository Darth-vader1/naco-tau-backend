# Backend tests

Run every suite:

```bash
npm test
```

Run only some suites (matches part of the file name):

```bash
npm test -- payments games
```

Each file in `suites/` is a plain Node script. It swaps the real database,
email, login check and payment gateway for small in-memory fakes, so **nothing
real is touched**: no Supabase, Redis, Bachs or email. A suite prints one
`PASS` or `FAIL` line per check and exits with a non-zero code if any check fails.

| Suite | What it protects |
|---|---|
| `payments` | Prices come from the server, replayed or underpaid references are refused, webhooks settle once, guest checkout, ticket fees, receipts |
| `games-multi` | Several games in one order, plays and fees, play limits, guest prices, webhook and receipt (including plays used) |
| `games-missing-table` | Paid checkouts keep working if the games table isn't there yet |
| `game-marshals` | Appointing by email, time windows, one event per marshal, no contact details leaked, plays can't go below zero, report |
| `audit-logs` | Audit log rules, filters and stats |
| `hackathon-teammates` | Teammate search and linked-teammate checks on registration |
| `hackathon-team-size` | Team size counts each person once; admin email on new teams |
| `rate-limiters` | Route rate limits switch to the shared Redis store |
| `session-tracking` | Session tracking reuses the cached login check |
| `prize-email` | Prize pool amounts formatted in naira in emails |
| `abandoned-checkouts` | Unpaid online checkouts older than 24h are marked abandoned; manual, paid and recent ones are left alone |
| `cold-start` | The real server answers 200 on a cold start even when Redis can't be reached |

Run `npm test` before every deploy. When you fix a bug, add a check that
would have caught it to the matching suite.
