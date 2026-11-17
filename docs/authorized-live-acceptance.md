# Authorized live acceptance

Live checks are deliberately manual. CI simulations must not be reported as proof of a real model gateway, a real public crawl, or sustained 4K playback. GitHub only accepts `workflow_dispatch` when the workflow file exists on the repository's default branch; these PR-only workflows cannot be dispatched while they exist only on this branch. Do not copy them to `main` without explicit authorization. Until then, run the documented scripts in an authorized environment with the required secrets and controlled egress proxy configured.

## 1. Live AI supervisor and public crawl

Configure these repository **Actions secrets** before running `Authorized Live Collector Acceptance` in an authorized environment:

- `SUPERVISOR_API_KEY`: model gateway credential
- `SUPERVISOR_MODEL`: exact model identifier
- `SUPERVISOR_API_BASE`: optional OpenAI-compatible API base; defaults to the OpenAI API base
- `SCRAPLING_EGRESS_PROXY`: controlled outbound proxy URL
- `LIVE_ACCEPTANCE_ALLOWED_HOSTS`: comma-separated exact hostnames, no wildcards
- `LIVE_ACCEPTANCE_PAGE_URL`: one explicitly authorized catalogue page for the AI supervisor probe
- `LIVE_ACCEPTANCE_URL_LIST`: newline-separated explicitly authorized seed URLs for scale acceptance

Select one probe:

- `ai-supervisor`: one authorized page fetch, one model completion, and a selector match check
- `live-scale`: fetch only the explicitly listed seed URLs, up to 1,000 unique URLs
- `both`: run both probes

The URL-list secret is subject to GitHub's secret size limit. For a larger authorized inventory, run the same documented command locally or use an approved private artifact handoff rather than committing private target lists to the repository.

The scale probe requires exact host allowlisting and the controlled egress proxy. Scrapling Spider obeys robots.txt, uses one concurrent request per domain, applies its configured per-domain delay, and does not expand page links. The result is a bounded seed-fetch measurement, not a claim of unrestricted web-wide discovery. When run through the workflow, its JSON report and stderr diagnostics are uploaded as a 14-day Actions artifact, including on failure when files were produced.

## 2. Sustained real 4K playback

Configure these repository Actions secrets/variables before running `Authorized Live 4K Playback Acceptance` in an authorized environment:

- Secret `LIBRETV_4K_TEST_URL`: an authorized, directly playable public HTTP(S) MP4 or HLS URL
- Secret `LIBRETV_4K_ALLOWED_HOSTS`: comma-separated exact hostnames
- Optional Actions variable `LIBRETV_4K_DURATION_SECONDS`: 60-3600; defaults to 600 seconds

The browser probe uses Chrome with media codecs, selects a 2160p-or-higher HLS rendition when available, checks decoded dimensions are at least 3840x2160, and requires continuous playback progress for the configured duration. It does not bypass DRM, authentication, paywalls, or access controls. Do not provide protected streams or credentials in URLs.

The workflow preserves its JSON result and stderr diagnostics in a 14-day Actions artifact. A successful run proves the supplied sample decoded and played in desktop Chromium for the measured duration. It does not prove iPhone Safari playback; that remains a separate physical-device acceptance.

## Evidence levels

Keep these separate in reports:

1. Unit/integration CI
2. Live model gateway + one authorized page
3. Live authorized seed-fetch scale
4. Actual 4K decode + sustained desktop browser playback
5. Physical iPhone/iPad Safari playback

Only report a level as passed when its corresponding run has completed successfully and its artifact/log evidence is available.
