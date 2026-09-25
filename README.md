# Chain Tracer — PS 26183

**Real-Time Identification of Fraud-Linked Cryptocurrency Exchanges from Victim-Reported Suspect Wallet Addresses through Automated Blockchain Analytics.**

An investigation console for cybercrime officers. A victim-reported wallet address goes in; the platform traces where the funds moved, identifies the exchange (VASP) they landed on, raises live alerts, and produces a tamper-evident evidence report and a freeze notice.

## What it does

| Area | Capability |
|---|---|
| Intake | Register NCRP complaints singly, by CSV import, or by pasting wallet addresses. |
| Tracing | Multi-hop fund-flow tracing across TRON, ETH, BSC, Polygon and BTC. |
| Graph explorer | Interactive fund-flow graph with chain, value and IST date filters, time replay, heaviest path and PNG export. |
| Wallet risk | Risk score, band and factors per wallet (v1 model covers TRON only; other chains are reported as unsupported, never scored). |
| Attribution | Matches traced funds to registry VASP hot wallets and shows the supporting evidence. |
| Alerts | Live alerts on watched wallets over Socket.IO, with acknowledge, assign and snooze. |
| Reports | Server-generated evidence report as PDF or JSON (`evidence.v1`), with a SHA-256 hash and a public verify endpoint. |
| Freeze notices | Draft → Pending approval → Approved → Sent workflow, with role-based approval and submission to a SAHYOG sandbox. |
| Roles | Viewer, Investigator, Supervisor and Admin, enforced by the backend. |
| UI | English / Hindi toggle, IST timestamps everywhere, responsive layout, keyboard navigation, colour-blind-safe cues, and a visible "Demo mode (replay)" banner. |

## Architecture

```
apps/web        React + Vite operations console (port 5173)
apps/api        Express + Prisma API, /api/v1 (port 4000)
workers         Background tracing and monitoring workers
services/ml     Risk-scoring model service (port 8000)
packages/shared Shared types and utilities
mocks           Mock NCRP (4010) and SAHYOG (4011) servers + OpenAPI contracts
fixtures        Recorded provider responses used in replay mode
data, scripts   Label datasets and data-preparation scripts
```

Data stores: PostgreSQL (cases, reports, notices, audit), Neo4j (transaction graph), Redis (queues, rate limits).

Frontend: React 18, TypeScript, TanStack Query, Zustand, Tailwind, Cytoscape (graph), Recharts, react-i18next.

## Getting started

Requirements: Docker with Compose, and Node 20+ with pnpm (only needed for running tests locally).

```bash
cp .env.example .env        # then fill in values (see below)
docker compose up -d --build
```

Open **http://localhost:5173**.

To rebuild only the frontend after changes: `docker compose up -d --build web`.

### Demo mode (replay)

Set `DATA_MODE=replay` in `.env` (the default for demos). In replay mode all blockchain and intelligence provider data is served from `fixtures/`; no external provider is called. The console shows a "Demo mode (replay)" banner whenever the API reports this mode.

Provider API keys in `.env` are only needed for live or record mode. Use only free-tier keys and avoid running live calls during routine testing.

### Demo accounts

All seeded accounts use the password `ChangeMe!123` (demo only; change it for any real deployment).

| Account | Role | Can |
|---|---|---|
| `investigator@demo.local` | Investigator | Register complaints, analyse, generate reports, draft and submit freeze notices |
| `supervisor@demo.local` | Supervisor | Everything above, plus approve and send freeze notices |
| `admin@demo.local` | Admin | Manage the VASP registry and labels |
| `viewer@demo.local` | Viewer | Read-only |

## Using the console

1. **Sign in** as the supervisor to see every step.
2. **Dashboard** shows open cases, value traced, exchanges identified and live alerts.
3. **Intake** registers a complaint; a complaint with a wallet address creates a case and queues a trace.
4. Open a case from **Recent cases** (for example `sample-case`) to see the **fund-flow graph**, open a wallet for its **risk profile**, and see the **exchanges the funds reached**.
5. **Alerts** lists movements on watched wallets; acknowledge, assign or snooze them.
6. **Reports**: choose a case, generate the PDF (with preview) or JSON, and use **Verify** to check the SHA-256 against the server.
7. **Freeze notice** (same page): choose a VASP, draft, enter the legal provision yourself, submit for approval, then approve and send as supervisor.

## Development

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test                       # all packages
pnpm --filter @ps26183/web test # frontend only
```

The frontend suite is timing-sensitive under heavy parallel load. If tests time out, limit parallelism:

```bash
pnpm --filter @ps26183/web exec vitest run --pool=forks --poolOptions.forks.minForks=1 --poolOptions.forks.maxForks=3
```

## Key environment variables

See `.env.example` for the full list. The important ones:

- `DATA_MODE`: `replay`, `record` or `live`.
- `DATABASE_URL`, `NEO4J_URI`, `REDIS_URL`, `ML_URL`: service connections.
- `JWT_SECRET`, `PII_ENC_KEY`: auth signing and PII encryption; set your own.
- `CORS_ORIGINS`, `RATE_LIMIT_*`: API hardening.
- `TRACE_MAX_HOPS`, `TRACE_MIN_USD`, `TRACE_WINDOW_DAYS`: tracing limits.
- `*_KEY` provider keys: only for live or record mode.

Never commit `.env`; it is git-ignored.

## Known limitations

- **SAHYOG send in replay mode:** submitting an approved freeze notice returns a server error because no SAHYOG replay response is recorded. The UI shows the failure and the notice stays Approved.
- **Freeze notices are not listable:** the API has no endpoint to list or re-fetch notices, so the notice screen only shows those created in the current browser session.
- **Attribution confidence** is not exposed by the API and is shown as unavailable.
- **IO name, rank and police station** are not stored by the backend and are not part of the report.
- **Risk scoring** covers TRON only.
- **Cases page** (`/cases`) is a placeholder; cases are listed on the dashboard.
- **Hindi** covers the main chrome, headings, states and the report and notice builders; some inline strings remain in English. Addresses, hashes, VASP names and backend-generated text are never translated.

## Documentation

The full implementation plan is in `PS26183_Implementation_Plan.pdf`. API contracts for the mock providers are in `mocks/openapi/`.
