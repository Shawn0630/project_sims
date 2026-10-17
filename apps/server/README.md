# @sds/server — System Design Simulator backend

Hono + TypeScript (run directly with tsx, no build step). The backend owns
everything the thin frontend must not hold: problem packs, judging, rule
signals and the LLM evaluation call.

```bash
npm run dev:server        # from the repo root (watch mode)
npm run start -w @sds/server
npm run seed -w @sds/server   # (re)export data/problems/*.json from @sds/problems
```

## Configuration

Shell env wins; otherwise `apps/server/.env` is loaded if present
(see `.env.example`). No variable is required to start.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8787` | Listen port |
| `LLM_BASE_URL` | `https://api.openai.com/v1` | OpenAI-compatible endpoint |
| `LLM_API_KEY` | — | Unset → scripted fallback for `/api/evaluate` |
| `LLM_MODEL` | `gpt-4o-mini` | Evaluation model |

The web app finds the backend at `VITE_API_URL` (frontend build-time env,
default `http://localhost:8787`).

## Endpoints

- `GET /api/health` — `{ status, storage, problems, llmConfigured, llmBaseUrl, llmModel }`
- `GET /api/problems` — all packs, client-safe (hidden cases stripped to
  `{ id, name, hidden, weight, locked: true }` + neutral placeholders)
- `GET /api/problems/:id` — one pack, same stripping; 404 for unknown ids
- `POST /api/submissions/judge` — `{ problemId, design, schema?, schemaLoadFactor? }`
  → `{ suite, structural, schemaSignals }`, judged by the existing
  `@sds/checker` code. This is the only way hidden cases are ever revealed:
  as results, after a submission.
- `POST /api/evaluate` — `{ kind, context }`:
  - `submission`: context = SubmissionAssessmentContext (driver contract)
  - `followups`: context = FollowUpContext (driver contract)
  - `schema`: context = SchemaAssessmentContext, OR `{ problemName, schema, loadFactor }`
    and the server computes the signals itself (returned as `schemaSignals`)
  - Response: `{ kind, source: 'llm' | 'scripted', label, data }`. Exactly one
    LLM call per request; any failure falls back to ScriptedDriver.
- `POST /api/problems/generate` — STUB for the LLM problem-generation system.
  Validates a seed `{ title, statement, scaleNotes? }` and returns 501 with
  the planned pack-generation contract.

## Storage

`src/storage.ts`: `ProblemStorage` interface + `JsonProblemStorage`
(one JSON pack per problem under `data/problems/`). Swapping to Postgres =
one new implementation; routes and judging do not change.
