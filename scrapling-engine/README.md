# LibreTV Scrapling Engine — Phase 1

An independently runnable Python service that hosts the upstream Scrapling framework for LibreTV. This phase validates the crawler engine only; it does not modify the LibreTV UI, production deployment, or main branch.

## Scope

The engine is built on the complete upstream `D4Vinci/Scrapling` package. It does not fork or replace Scrapling with a reduced implementation.

The eight capability areas are:

1. Fetching: HTTP, async, dynamic-browser and stealth fetchers.
2. Extraction: CSS, XPath, text, regex and DOM traversal.
3. Adaptive parsing: saved element fingerprints and relocation after layout changes.
4. Browser automation: JavaScript rendering, sessions and browser interactions.
5. Spider crawling: the first integration exposes a seed-URL crawl endpoint backed by Scrapling Spider, with concurrency limits and robots.txt enforcement. Recursive link discovery and persistent job controls remain gated until request-level egress protection is in place.
6. Public API discovery: capture and inspect page network responses; never assume every endpoint is public or usable.
7. Network resilience: proxy configuration, retries, blocked-response handling, throttling and robots policy.
8. AI integration: upstream MCP server/Agent Skill plus a controlled LibreTV adapter surface.

Some orchestration features (job persistence, API auth, audit logs, policy enforcement and metrics) are service-layer responsibilities, not claims that Scrapling provides them automatically.

## Run locally

```bash
cd scrapling-engine
python -m venv .venv
. .venv/bin/activate
pip install -e ".[dev]"
python -m app
```

Open `http://127.0.0.1:8787/health`.

The fetch API supports `adaptive_css` and `adaptive_xpath` in addition to ordinary selectors. First call with `adaptive_action: "save"` to persist an element fingerprint; later call with `adaptive_action: "relocate"` to let Scrapling find the matching element after the site's DOM changes. Adaptive fingerprints use Scrapling's SQLite storage at `CRAWL_DATA_DIR/adaptive.sqlite3` and are isolated by page domain.

POST /v1/spider remains a synchronous compatibility endpoint. For managed work, POST /v1/jobs accepts 1–20 seed URLs and returns a task_id; GET /v1/jobs/{task_id} returns persistent status; POST /v1/jobs/{task_id}/pause and /resume control the live Spider; GET /v1/jobs/{task_id}/events streams persisted events over SSE. Job metadata, crawl results, and audit events use PostgreSQL when `DATABASE_URL` is configured; otherwise local development falls back to SQLite (`CRAWL_JOB_DATABASE_PATH`, default `./crawl_data/jobs.sqlite3`). Scrapling checkpoints live under `CRAWL_DATA_DIR` (default `./crawl_data`). The PostgreSQL schema is initialized by both the API service and worker on startup. A task_id is immutable with respect to its seed URL list. On process restart, queued jobs remain queued and are re-scheduled at service startup; jobs that were running or pausing are marked interrupted. Resuming an interrupted crawl still requires a persisted Scrapling checkpoint file. The async Spider stream avoids calling Spider.start() and its process signal handlers from a worker thread. The crawler obeys robots.txt, limits concurrency and per-domain requests, uses an explicit service User-Agent without stealth header or TLS browser impersonation, and does not recursively follow page links yet. `max_response_bytes` prevents oversized responses from entering extraction, but Scrapling has already received the response body; it is not a network-transfer memory cap. Browser subrequests, DNS rebinding and private-address egress still require deployment-level network enforcement before recursive or browser crawling is enabled. Stealth browser sessions remain disabled.

Browser-backed fetchers require the optional browser dependencies and browser installation described by the upstream Scrapling documentation. With SQLite, run the API as a single process; SQLite remains a local-development fallback. With PostgreSQL, the API only accepts and reports managed jobs, while independent workers claim jobs using `FOR UPDATE SKIP LOCKED` leases. Install the package and run `libretv-scrapling-worker --worker-id worker-a`; run multiple worker processes with unique IDs against the same PostgreSQL database. Workers heartbeat their leases and fence result/completion writes by current lease ownership, so a worker that loses its lease cannot persist late results. All workers must share the same durable `CRAWL_DATA_DIR` checkpoint volume; local per-container disks are not sufficient for recovery. The API's current pause endpoint remains process-local and returns a conflict for jobs not owned by its process; cross-process pause/resume signaling is a subsequent runtime capability, not claimed as implemented. Keep local development bound to localhost. The Docker image binds to `0.0.0.0` using the same `HOST` and `PORT` settings as the application, so it must be started with a `SCRAPLING_API_KEY` of at least 32 characters. Any non-loopback bind without this key fails closed; all `/v1/*` routes then require the matching `X-API-Key` header. Terminate TLS at a trusted reverse proxy; do not send the API key over plain public HTTP. This is a single service key, not per-user tenant isolation. Before a multi-user remote deployment, add per-user authorization/quotas, audit retention, and network-level egress filtering that blocks private, loopback, link-local and metadata-service ranges even after DNS resolution and redirects.

## Safety boundary

- Phase 1 does not crawl FMHY yet; FMHY directory ingestion is Phase 2.
- Only public HTTP(S) pages are in scope. No DRM, paywall, login or access-control circumvention.
- Respect robots.txt, rate limits and site terms. Do not treat a discovered website URL as a playable source.
- The service rejects localhost, private, link-local and reserved IP destinations to reduce SSRF risk.

## Verification

Run `pytest` and `ruff check .`. The CI workflow starts PostgreSQL 16 and runs the PostgreSQL persistence integration test in addition to the SQLite unit tests. CI verifies unit/API behavior without relying on arbitrary public targets. CI also runs a controlled public-site smoke test against example.com through both the HTTP Fetcher and async Spider; broader target-site acceptance remains a separate step.
