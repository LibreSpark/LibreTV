# LibreTV Scrapling Collector

Scrapling is a Python crawling framework, so the collector runs as an isolated Python service. LibreTV calls it through the authenticated Next.js API proxy; the browser never receives the collector token.

## End-to-end pipeline

1. **Discover (separate path)** — FMHY Movies / TV / Anime is a separate third-party site-discovery path. The collector reads the video index plus at most eight FMHY-owned category pages linked from that index, merges sites by hostname, and records which directory pages referenced each host. It does not crawl the whole FMHY website or treat arbitrary external pages as a directory.
2. **Fetch** — Scrapling Spider uses a bounded same-host HTTPS frontier: maximum depth 2, maximum 12 scheduled pages per crawl, and at most eight follow-up links per page. Pagination links receive the highest priority, followed by catalogue/category links and shallow navigation. Media files, API endpoints, off-host links, and non-HTTPS links are not added to the HTML page frontier. Per-domain delay, robots.txt compliance, and Scrapling crawl checkpoints remain enabled.
3. **Adapt** — Scrapling adaptive selectors save element traits by domain and try to relocate matching elements after page markup changes.
4. **Render / capture** — in `auto` mode, the HTTP Spider and StealthySession browser collector run independently in parallel even when either side finds candidates. Each side reports its own status, error, and candidate count; merged candidates retain `collected_by` provenance so dual hits remain visible. Explicit `http` and `browser` modes run only the selected collector. Browser capture records observed network responses; it does not bypass login, CAPTCHA, subscription, DRM, or other access controls.
5. **Classify** — candidates are separated into direct media, embedded player, CMS API, and access-gate records. A candidate without its own observed response remains `ACCESS_UNKNOWN`; only its own 2xx response with no detected access restriction may be classified `PUBLIC`. Authentication, subscription, explicit DRM, and generic HLS encryption are kept distinct. HLS AES-128/SAMPLE-AES signaling alone is recorded as `ENCRYPTED_STREAM`, not falsely labelled as a DRM system.
6. **Validate** — candidates are DNS/public-IP checked. CMS API candidates are fetched and must return JSON with a list-shaped payload before they can be imported.
7. **Inspect manifests** — bounded HLS parsing extracts declared variant dimensions, codecs, encryption methods, and durations, then follows master-to-variant playlists with a strict depth/request budget and samples only a few media segments. DASH parsing extracts declared Representation dimensions, ContentProtection DRM signaling (without fetching keys), inherited BaseURL paths, SegmentTemplate media/initialization patterns, SegmentList URLs, and up to 50 SegmentTimeline entries per Representation. It expands the standard RepresentationID, Bandwidth, Number, and Time template tokens for this bounded sample. Dynamic MPD metadata (availability start, publish time, minimum update interval, time-shift buffer depth, and suggested presentation delay) is recorded; negative timeline repeats are bounded by the next explicit time or Period/MPD duration. For an open-ended dynamic repeat without a known live edge, the parser marks the timeline as requiring live-edge resolution and emits no speculative segment URLs instead of treating timeShiftBufferDepth as an absolute end timestamp. All discovered manifest references are resolved and checked for public HTTPS destinations. Quality evidence explicitly separates manifest-declared resolution from observed container resolution. Progressive MP4/M4V/MOV probes inspect bounded `moov`/`tkhd` ranges (including a bounded tail range when needed), and WebM probes inspect EBML Video PixelWidth/PixelHeight. These are container metadata checks only: the service does not decode frames, score visual quality, poll live MPDs, download full segments, synchronize clocks, or prove continuous playback.
8. **Import / play** — validated CMS API endpoints can be added to LibreTV's existing custom VOD source store. Direct media candidates are previewed through the existing PlayerShell; they are not misrepresented as CMS sources.
9. **Track / recover** — SQLite stores discovery entries, tasks, candidates, validation results, and task status. Candidate records persist collector provenance (`spider` / `browser`), access state and reason, probe evidence, conservative title/year/season/episode hints, non-authoritative entity/version keys, and a quality rank whose source distinguishes manifest declarations from filename hints. Existing SQLite volumes receive additive migrations; old candidates remain `ACCESS_UNKNOWN` rather than being retroactively marked public. Interrupted tasks are marked on service restart and can be retried from Settings → Resource Collection Center.

SeedHub is a separately pinned first-party adapter, not a directory used to discover other sites. `/v1/seedhub/sync` collects its own movie, series, and anime catalogue pages; `/v1/seedhub/detail` extracts only same-site title, description, poster, and still-image metadata. It deliberately does not extract outbound share, torrent, magnet, or download links, and does not claim those entries are playable media. The adapter is isolated from the FMHY `discover` / `crawl` allow-list and uses its own fixed-origin detail URL validation.

The collector accepts only HTTPS targets on standard port 443 and checks DNS results for public IP addresses before crawling. Direct-media probes pin the TCP connection to the exact validated IP while retaining the original hostname for TLS SNI and certificate verification; each redirect hop is independently resolved, checked, and pinned. Browser capture also installs a per-request guard that rejects non-HTTPS, non-standard-port, unresolved, private, and reserved targets, including redirects and subresource requests. These application checks are defense in depth, not a complete network boundary: DNS can change between validation and connection (TOCTOU). **The collector now fails closed with HTTP 503 for FMHY discovery, crawl, and candidate-validation operations unless `SCRAPLING_EGRESS_FIREWALL_CONFIRMED=1` is explicitly set.** This variable is an operator assertion only; it does not install or verify firewall rules. Leave it unset on Render or any platform where an equivalent outbound network boundary has not been independently installed and tested. The Docker Compose setup assigns the collector a dedicated static address, disables IPv6 inside the collector, and passes `SCRAPLING_EGRESS_FIREWALL_CONFIRMED` with a default of `0`. Apply the host firewall rules before exposing the service: after `docker compose --profile collector up -d --build`, run `sudo bash scripts/scrapling-egress-firewall.sh` on the Docker host. This installs an idempotent IPv4 `DOCKER-USER` rule for the collector address, blocking loopback, RFC1918, carrier-grade NAT, link-local (including cloud metadata), documentation, benchmarking, multicast, and reserved ranges while permitting established replies and public IPv4 destinations. If `SCRAPLING_NETWORK_SUBNET` is changed, also set `SCRAPLING_COLLECTOR_IP` to an address inside it and pass that exact address as `COLLECTOR_CIDR`, for example `SCRAPLING_NETWORK_SUBNET=172.31.60.0/24 SCRAPLING_COLLECTOR_IP=172.31.60.10` in the Compose environment and `sudo COLLECTOR_CIDR=172.31.60.10/32 bash scripts/scrapling-egress-firewall.sh`. The firewall blocks both forwarded private/reserved destinations and direct access to host-local services. The firewall script requires Docker's `DOCKER-USER` chain and host `iptables`; environments using nftables or another firewall must implement equivalent forwarding rules. Application checks and host firewall rules are defense in depth; verify the effective host rules and test blocked destinations on the actual deployment host. Do not expose the collector directly to the public internet without HTTPS and a strong token. The collector does not log in, bypass paywalls, DRM, CAPTCHA or access controls. It does not automatically import unvalidated links. A URL being public or returning media bytes does not prove that the content is licensed or suitable for redistribution; operators must ensure they have permission to access and use each source.

## Run locally with Docker Compose

Create a strong token and add it to the LibreTV deployment's environment:

```sh
export SCRAPLING_API_TOKEN="$(openssl rand -hex 32)"
export SCRAPLING_API_BASE="http://scrapling-collector:8000"
# Start with the egress gate disabled (the default).
docker compose --profile collector up -d --build
# Install and verify the host firewall before enabling any crawling.
sudo bash scripts/scrapling-egress-firewall.sh
export SCRAPLING_EGRESS_FIREWALL_CONFIRMED=1
docker compose --profile collector up -d --force-recreate scrapling-collector
```

The collector is internal to the Compose network and persists its SQLite database in the `scrapling_data` named volume. The LibreTV container receives the same token and internal service URL from Compose.

For Cloudflare-hosted LibreTV, the collector must run as a separately reachable HTTPS service. Configure `SCRAPLING_API_BASE` and `SCRAPLING_API_TOKEN` as Worker environment values/secrets. Do not expose the collector without a strong token and HTTPS.

## AI Resource Supervisor

The Next.js Preview API exposes `POST /api/resource-collector/agent`. The isolated PR84 Preview binds Cloudflare Workers AI as its default planner (`@cf/meta/llama-3.1-8b-instruct`), so no external model-provider API key is required. A dedicated OpenClaw agent or OpenAI-compatible provider can optionally override it. The model can only schedule `discover`, `seedhub_sync`, and `crawl` jobs. A crawl must select an exact host from the persisted discovered-site allowlist; it cannot emit arbitrary URLs or claim that media is playable.

Cloudflare Workers AI is enabled through the `[ai] binding = "AI"` section in `wrangler.pr84-preview.toml`; it does not require a provider API key. The PR84 preview deployment workflow can optionally override this default by reading the GitHub Actions secrets `PR84_RESOURCE_AGENT_API_KEY` (plus optional `PR84_RESOURCE_AGENT_BASE_URL` / `PR84_RESOURCE_AGENT_MODEL`), or the complete `PR84_RESOURCE_OPENCLAW_*` secret set, and writes them only to the isolated Preview Worker:

- Direct model: `RESOURCE_AGENT_API_KEY`, optionally `RESOURCE_AGENT_BASE_URL` and `RESOURCE_AGENT_MODEL`. If omitted, the direct provider defaults to the Zhipu endpoint and `glm-4-air`.
- OpenClaw: `RESOURCE_OPENCLAW_GATEWAY_URL`, `RESOURCE_OPENCLAW_GATEWAY_TOKEN`, `RESOURCE_OPENCLAW_AGENT_ID`, `RESOURCE_OPENCLAW_ACCESS_CLIENT_ID`, and `RESOURCE_OPENCLAW_ACCESS_CLIENT_SECRET`.

The API exposes only whether a provider is configured, never credentials. The Cloudflare AI binding is the no-provider-key default; account-level Cloudflare Workers AI availability, quota, and billing still apply. The Supervisor caps plans at four tasks and SeedHub batches at twenty pages. Collector jobs still enforce their own idempotency, retries, egress firewall gate, and validation rules. This is the first bounded planning agent; autonomous site research, generated Connector sandboxing, graph-based repair, and continuous media QA remain separate implementation milestones and must not be represented as live until independently built and tested.

## API

- `GET /health` — service health and stored task count.
- `GET /v1/discover` — refresh the separate FMHY video directory and persist discovered sites.
- `GET /v1/sites?limit=30` — return the persisted discovered-site allowlist for AI Supervisor selection; arbitrary model-generated URLs are not accepted.
- `POST /v1/seedhub/sync?category=movies|series|anime&pages=1` — small synchronous SeedHub metadata batch (maximum five pages).
- Submit `{ "job_type":"seedhub_sync", "payload":{"category":"movies","start_page":1,"pages":20}, "idempotency_key":"seedhub:movies:1:20" }` to `POST /v1/tasks/submit` for a durable, checkpointed batch; the worker pauses two seconds between pages and records per-page progress. Queue successive batches to cover the full catalogue without long HTTP requests.
- `GET /v1/seedhub/catalog?category=movies|series|anime&limit=50&offset=0` — read the SeedHub catalogue.
- `GET /v1/seedhub/search?q=title&limit=20` — search imported SeedHub catalogue metadata for LibreTV search; no playback/share URLs are exposed.
- `GET /v1/seedhub/detail?url=https://www.seedhub.cc/movies/130096/` — read title, description, poster, and still-image metadata from one SeedHub detail page; outbound resource/share links are intentionally excluded.
- `POST /v1/crawl` — crawl one previously discovered host. Body: `{"url":"https://...","mode":"auto|http|browser","limit":50}`.
- `GET /v1/tasks` — recent persistent task history.
- `GET /v1/tasks/{task_id}/candidates` — candidates for one task.
- `POST /v1/tasks/{task_id}/retry` — retry a previous task.
- `POST /v1/candidates/{candidate_id}/validate` — validate a candidate and classify CMS importability.

All API endpoints except `/health` require `Authorization: Bearer <token>`.

## Tests

```sh
cd services/scrapling-collector
SCRAPLING_API_TOKEN=test-token python -m unittest discover -s tests -v
```

The GitHub Actions workflow runs Python compilation and the collector security/persistence unit tests on relevant changes.

## Deploy to Render (PR #60 preview / manual opt-in)

This repository includes a Render Blueprint at the repository root. It is configured for the PR #60 feature branch and creates one **paid** Docker web service only when the owner explicitly creates/syncs the Blueprint. It does not deploy automatically: `autoDeployTrigger: off`.

### Render settings

- Repository: `421581698/LibreTV`
- Branch: `feat/iphone-inline-play-top-search-2026-11-09` (select this branch when connecting the Blueprint)
- Blueprint file: `render.yaml` at repository root
- Service root directory: `services/scrapling-collector`
- Dockerfile: `services/scrapling-collector/Dockerfile`
- Docker build context: `services/scrapling-collector`
- Health check: `/health`
- Persistent disk: `/data` (1 GB)
- Runtime port: Render-provided `PORT` (defaults to 10000 on Render); Docker Compose explicitly sets `PORT=8000`.

The Blueprint generates `SCRAPLING_API_TOKEN` as a secret. Do not commit a token or paste it into chat. After deployment, copy the generated value securely from the Render service environment into the **PR #60 Preview Worker Secret** with the same name. Set the Worker variable `SCRAPLING_API_BASE` to the service's HTTPS `onrender.com` URL (no trailing slash). The Worker must be configured separately; this repository does not publish a shared test token or public shared collector.

### Important deployment and security limits

- A persistent disk is required for SQLite. Render's free web services do not provide the persistent disk required by this service; this Blueprint deliberately selects a paid `2c-4g` web service and a 1 GB disk. Creating it may incur charges. Review the current Render price before confirming.
- The container installs Scrapling's browser runtime during image build and stores browser binaries at `/opt/collector-browsers`, outside the `/data` persistent-disk mount. The entrypoint fixes `/data` ownership after Render attaches the disk, then drops privileges to UID 10001 before starting the API. Browser-based crawl requests can use significantly more memory than simple HTTP discovery; monitor memory and upgrade if needed.
- The collector accepts authenticated crawl requests and fetches third-party URLs. Its application-level DNS/IP checks are defense in depth, not an egress firewall. The existing `DOCKER-USER` firewall script only applies to a Docker host and cannot be assumed to run on Render. The collector therefore keeps crawl and candidate-validation operations disabled on Render by default (HTTP 503). Do not set `SCRAPLING_EGRESS_FIREWALL_CONFIRMED=1` there unless equivalent outbound network restrictions are independently implemented and verified on that platform.
- The Render Blueprint is a reproducible deployment definition, not proof of a live deployment. No service, domain, token, or paid resource is created by CI.
- Use Render's HTTPS `onrender.com` hostname; no custom domain is required for Preview testing.
- Render may suspend free services, but this configuration is not a free-tier deployment because persistent SQLite storage is required.

### Render deployment verification

After the owner manually deploys the Blueprint, verify all of the following before connecting the Worker:

1. `GET https://<service>.onrender.com/health` returns HTTP 200 and `{"ok":true,...}`.
2. `GET /v1/discover` without a bearer token returns HTTP 401.
3. `GET /v1/discover` with the configured token returns a real FMHY discovery response.
4. Restart/redeploy the service and confirm task records remain available from the persistent `/data` disk.
5. Set the Preview Worker's `SCRAPLING_API_BASE` and `SCRAPLING_API_TOKEN` secrets, then verify `/api/resource-collector` from the Preview app.
6. Keep this service isolated from production. Do not reuse production secrets.
