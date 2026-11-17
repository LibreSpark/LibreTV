#!/usr/bin/env bash
set -euo pipefail

# Runtime acceptance for the opt-in crawler profile. This intentionally runs
# only on an isolated CI runner; it creates and removes its own Compose volumes.
: "${PASSWORD:?PASSWORD is required}"
: "${SCRAPLING_API_KEY:?SCRAPLING_API_KEY is required}"
: "${SCRAPLING_DB_PASSWORD:?SCRAPLING_DB_PASSWORD is required}"

compose=(docker compose --profile crawler)

cleanup() {
  status=$?
  if [[ "$status" -ne 0 ]]; then
    for service in scrapling-engine scrapling-job-worker scrapling-workflow-worker scrapling-egress-proxy scrapling-media-probe; do
      container=$("${compose[@]}" ps -aq "$service" | head -n 1)
      if [[ -n "$container" ]]; then
        echo "Runtime state for $service:"
        docker inspect --format '{{json .State}}' "$container" || true
      fi
    done
    "${compose[@]}" logs --no-color --tail=100 scrapling-engine scrapling-job-worker scrapling-egress-proxy scrapling-workflow-worker scrapling-media-probe || true
  fi
  "${compose[@]}" down --volumes --remove-orphans
}
trap cleanup EXIT

"${compose[@]}" config --quiet
"${compose[@]}" up -d --build scrapling-postgres scrapling-egress-proxy scrapling-media-probe scrapling-engine

ready=0
for attempt in $(seq 1 60); do
  if "${compose[@]}" exec -T scrapling-postgres pg_isready -U libretv_scrapling -d libretv_scrapling >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 2
done
[[ "$ready" == "1" ]] || { echo "PostgreSQL did not become ready"; exit 1; }

engine_container=$("${compose[@]}" ps -q scrapling-engine)
engine_ready=0
for attempt in $(seq 1 60); do
  engine_health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$engine_container")
  if [[ "$engine_health" == "healthy" ]]; then
    engine_ready=1
    break
  fi
  running=$(docker inspect --format '{{.State.Running}}' "$engine_container")
  if [[ "$running" != "true" ]]; then
    echo "scrapling-engine exited before becoming healthy"
    docker inspect --format '{{json .State}}' "$engine_container" || true
    docker logs "$engine_container" || true
    exit 1
  fi
  sleep 2
done
[[ "$engine_ready" == "1" ]] || {
  echo "scrapling-engine did not become healthy"
  docker inspect --format '{{json .State.Health}}' "$engine_container" || true
  docker logs "$engine_container" || true
  exit 1
}

probe_container=$("${compose[@]}" ps -q scrapling-media-probe)
probe_ready=0
for attempt in $(seq 1 30); do
  probe_health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$probe_container")
  if [[ "$probe_health" == "healthy" ]]; then
    probe_ready=1
    break
  fi
  sleep 2
done
[[ "$probe_ready" == "1" ]] || {
  echo "scrapling-media-probe did not become healthy"
  docker inspect --format '{{json .State.Health}}' "$probe_container" || true
  docker logs "$probe_container" || true
  exit 1
}

"${compose[@]}" up -d --build scrapling-job-worker scrapling-workflow-worker

for service in scrapling-engine scrapling-job-worker scrapling-workflow-worker; do
  container=$("${compose[@]}" ps -q "$service")
  test -n "$container"

  running=$(docker inspect --format '{{.State.Running}}' "$container")
  [[ "$running" == "true" ]] || { echo "$service is not running"; docker logs "$container"; exit 1; }
  user=$(docker inspect --format '{{.Config.User}}' "$container")
  readonly=$(docker inspect --format '{{.HostConfig.ReadonlyRootfs}}' "$container")
  pids=$(docker inspect --format '{{.HostConfig.PidsLimit}}' "$container")
  memory=$(docker inspect --format '{{.HostConfig.Memory}}' "$container")
  nano_cpus=$(docker inspect --format '{{.HostConfig.NanoCpus}}' "$container")
  cap_drop=$(docker inspect --format '{{json .HostConfig.CapDrop}}' "$container")
  security_opt=$(docker inspect --format '{{json .HostConfig.SecurityOpt}}' "$container")
  tmpfs=$(docker inspect --format '{{json .HostConfig.Tmpfs}}' "$container")

  [[ "$user" == "10001:10001" ]] || { echo "$service: unexpected user $user"; exit 1; }
  [[ "$readonly" == "true" ]] || { echo "$service: root filesystem is writable"; exit 1; }
  [[ "$pids" -gt 0 && "$pids" -le 128 ]] || { echo "$service: invalid PID limit $pids"; exit 1; }
  [[ "$memory" -gt 0 ]] || { echo "$service: memory limit is missing"; exit 1; }
  [[ "$nano_cpus" -gt 0 ]] || { echo "$service: CPU limit is missing"; exit 1; }
  grep -q '"ALL"' <<<"$cap_drop" || { echo "$service: CAP_DROP ALL is missing"; exit 1; }
  grep -q 'no-new-privileges' <<<"$security_opt" || { echo "$service: no-new-privileges is missing"; exit 1; }
  grep -q '/tmp' <<<"$tmpfs" || { echo "$service: /tmp tmpfs is missing"; exit 1; }
  grep -q 'noexec' <<<"$tmpfs" || { echo "$service: /tmp noexec is missing"; exit 1; }
  grep -q 'nosuid' <<<"$tmpfs" || { echo "$service: /tmp nosuid is missing"; exit 1; }
  grep -q 'nodev' <<<"$tmpfs" || { echo "$service: /tmp nodev is missing"; exit 1; }

  actual_uid=$("${compose[@]}" exec -T "$service" id -u)
  actual_gid=$("${compose[@]}" exec -T "$service" id -g)
  [[ "$actual_uid" == "10001" && "$actual_gid" == "10001" ]] || {
    echo "$service: runtime identity is $actual_uid:$actual_gid"
    exit 1
  }

  # The shared durable volume must be writable by the unprivileged process.
  if ! "${compose[@]}" exec -T "$service" sh -ec 'f="/data/.runtime-acceptance-$"; : > "$f"; rm "$f"'; then
    echo "$service failed during the /data write check; container logs follow"
    docker logs "$container" || true
    exit 1
  fi
  echo "$service: uid, read-only rootfs, tmpfs, resource limits and /data write passed"
done


probe_container=$("${compose[@]}" ps -q scrapling-media-probe)
test -n "$probe_container"
[[ "$(docker inspect --format '{{.State.Running}}' "$probe_container")" == "true" ]]
[[ "$(docker inspect --format '{{.Config.User}}' "$probe_container")" == "10001:10001" ]]
[[ "$(docker inspect --format '{{.HostConfig.ReadonlyRootfs}}' "$probe_container")" == "true" ]]
[[ "$(docker inspect --format '{{.HostConfig.NetworkMode}}' "$probe_container")" == "none" ]]
[[ "$(docker inspect --format '{{.HostConfig.PidsLimit}}' "$probe_container")" -le 64 ]]
[[ "$(docker inspect --format '{{.HostConfig.Memory}}' "$probe_container")" -gt 0 ]]
[[ "$(docker inspect --format '{{.HostConfig.NanoCpus}}' "$probe_container")" -gt 0 ]]
grep -q '"ALL"' <<<"$(docker inspect --format '{{json .HostConfig.CapDrop}}' "$probe_container")"
grep -q 'no-new-privileges' <<<"$(docker inspect --format '{{json .HostConfig.SecurityOpt}}' "$probe_container")"
probe_security_opt=$(docker inspect --format '{{json .HostConfig.SecurityOpt}}' "$probe_container")
grep -q 'seccomp' <<<"$probe_security_opt" || { echo "Probe sidecar must use the dedicated ffprobe seccomp profile"; exit 1; }
"${compose[@]}" exec -T scrapling-media-probe prlimit --help >/dev/null
probe_tmpfs=$(docker inspect --format '{{json .HostConfig.Tmpfs}}' "$probe_container")
grep -q 'noexec' <<<"$probe_tmpfs"
grep -q 'nosuid' <<<"$probe_tmpfs"
grep -q 'nodev' <<<"$probe_tmpfs"
probe_env=$(docker inspect --format '{{json .Config.Env}}' "$probe_container")
if grep -Eq 'DATABASE_URL|SCRAPLING_API_KEY|SUPERVISOR_API_KEY' <<<"$probe_env"; then
  echo "Probe sidecar must not receive database or Supervisor credentials"
  exit 1
fi
"${compose[@]}" exec -T scrapling-media-probe ffprobe -version >/dev/null
if "${compose[@]}" exec -T scrapling-workflow-worker sh -c 'command -v ffprobe >/dev/null 2>&1'; then
  echo "ffprobe must not be installed in the networked workflow worker"
  exit 1
fi
# Exercise the complete file handoff: generate a tiny local clip inside the
# no-network sidecar, stage it in the worker-only volume, and request a real probe.
echo "[runtime] Generate a probe fixture in the isolated sidecar"
timeout 30s "${compose[@]}" exec -T scrapling-media-probe ffmpeg -hide_banner -loglevel error \
  -f lavfi -i "testsrc2=size=320x240:rate=25:duration=2" -frames:v 50 \
  -an -c:v libx264 -preset ultrafast -crf 32 -pix_fmt yuv420p -threads 1 -movflags +faststart \
  -y /probe/outbox/probe-smoke.mp4
"${compose[@]}" exec -T scrapling-media-probe test -s /probe/outbox/probe-smoke.mp4
worker_container=$("${compose[@]}" ps -q scrapling-workflow-worker)
echo "[runtime] Stage the media fixture into the worker-only writable volume"
"${compose[@]}" exec -T scrapling-workflow-worker cp /probe/outbox/probe-smoke.mp4 /probe/staging/probe-smoke.mp4
"${compose[@]}" exec -T scrapling-workflow-worker cp /probe/staging/probe-smoke.mp4 /probe/staging/probe-smoke.media
echo "[runtime] Validate the copied fixture directly with the isolated FFmpeg binary"
timeout 20s "${compose[@]}" exec -T scrapling-media-probe python - <<'PY'
import os
import subprocess

cpu = str(min(os.sched_getaffinity(0)))
command = [
    "prlimit",
    "--cpu=5:10",
    "--as=1073741824",
    "--stack=1048576:1048576",
    "--core=0:0",
    "--nofile=64:64",
    "--fsize=2097152:2097152",
    "--",
    "taskset",
    "-c",
    cpu,
    "ffmpeg",
    "-nostdin",
    "-hide_banner",
    "-loglevel",
    "error",
    "-xerror",
    "-err_detect",
    "explode",
    "-protocol_whitelist",
    "file",
    "-max_alloc",
    "67108864",
    "-probesize",
    "10485760",
    "-analyzeduration",
    "10000000",
    "-threads",
    "1",
    "-filter_threads",
    "1",
    "-filter_complex_threads",
    "1",
    "-i",
    "/probe/staging/probe-smoke.media",
    "-t",
    "8",
    "-map",
    "0:v:0",
    "-map",
    "0:a:0?",
    "-f",
    "null",
    "-",
]
subprocess.run(command, check=True)
PY
echo "[runtime] Exercise the real sidecar handoff and ffprobe analysis"
timeout 45s "${compose[@]}" exec -T scrapling-workflow-worker python - <<'PY'
from app.probe_client import probe_media_file

report = probe_media_file(
    "/probe/staging/probe-smoke.mp4",
    timeout_seconds=10,
)
assert report["video"]["width"] == 320, report
assert report["video"]["height"] == 240, report
print("End-to-end isolated ffprobe handoff passed.")
PY
"${compose[@]}" exec -T scrapling-workflow-worker rm -f /probe/staging/probe-smoke.mp4 /probe/staging/probe-smoke.media
"${compose[@]}" exec -T scrapling-media-probe rm -f /probe/outbox/probe-smoke.mp4
grep -q 'no-new-privileges' <<<"$(docker inspect --format '{{json .HostConfig.SecurityOpt}}' "$probe_container")"
"${compose[@]}" exec -T scrapling-media-probe python - <<'PY'
import socket
try:
    socket.socket()
except PermissionError:
    print("Probe seccomp profile denied socket creation.")
else:
    raise SystemExit("Probe sidecar unexpectedly created a socket.")
PY
probe_mounts=$(docker inspect --format '{{json .Mounts}}' "$probe_container")
python3 -c 'import json,sys; mounts=json.loads(sys.argv[1]); by_target={m["Destination"]:m for m in mounts}; assert by_target["/probe/staging"]["RW"] is False; assert by_target["/probe/inbox"]["RW"] is False; assert by_target["/probe/outbox"]["RW"] is True' "$probe_mounts"
"${compose[@]}" exec -T scrapling-media-probe python - <<'PY'
import socket

try:
    sock = socket.socket()
except PermissionError:
    print("Probe seccomp denied socket creation; direct network access is impossible.")
else:
    try:
        sock.settimeout(1)
        sock.connect(("1.1.1.1", 53))
    except OSError:
        pass
    else:
        raise SystemExit("probe sidecar unexpectedly reached the network")
    finally:
        sock.close()
PY
worker_mounts=$(docker inspect --format '{{json .Mounts}}' "$worker_container")
python3 -c 'import json,sys; mounts=json.loads(sys.argv[1]); by_target={m["Destination"]:m for m in mounts}; assert by_target["/probe/staging"]["RW"] is True; assert by_target["/probe/inbox"]["RW"] is True; assert by_target["/probe/outbox"]["RW"] is False' "$worker_mounts"
timeout 5s "${compose[@]}" exec -T scrapling-workflow-worker python - <<'PY'
from pathlib import Path
try:
    (Path("/probe/outbox") / "worker-write-forbidden").write_text("tamper")
except OSError:
    print("Workflow worker cannot modify probe results.")
else:
    raise SystemExit("Workflow worker unexpectedly wrote to the probe result volume.")
PY
echo "scrapling-media-probe: no network, read-only input and output isolation passed"


# Network membership is the actual no-bypass control: every worker and
# PostgreSQL must be attached only to Docker networks marked Internal.
for service in scrapling-engine scrapling-job-worker scrapling-workflow-worker scrapling-postgres; do
  container=$("${compose[@]}" ps -q "$service")
  networks=$(docker inspect --format '{{range $name, $value := .NetworkSettings.Networks}}{{$name}} {{end}}' "$container")
  [[ -n "$networks" ]] || { echo "$service has no isolated network"; exit 1; }
  for network in $networks; do
    internal=$(docker network inspect --format '{{.Internal}}' "$network")
    [[ "$internal" == "true" ]] || {
      echo "$service is attached to non-internal network $network"
      exit 1
    }
  done
done

proxy_container=$("${compose[@]}" ps -q scrapling-egress-proxy)
test -n "$proxy_container"
[[ "$(docker inspect --format '{{.State.Running}}' "$proxy_container")" == "true" ]]
[[ "$(docker inspect --format '{{.Config.User}}' "$proxy_container")" == "10001:10001" ]]
[[ "$(docker inspect --format '{{.HostConfig.ReadonlyRootfs}}' "$proxy_container")" == "true" ]]
[[ "$(docker inspect --format '{{.HostConfig.PidsLimit}}' "$proxy_container")" -le 64 ]]
[[ "$(docker inspect --format '{{.HostConfig.Memory}}' "$proxy_container")" -gt 0 ]]
[[ "$(docker inspect --format '{{.HostConfig.NanoCpus}}' "$proxy_container")" -gt 0 ]]
proxy_tmpfs=$(docker inspect --format '{{json .HostConfig.Tmpfs}}' "$proxy_container")
grep -q 'noexec' <<<"$proxy_tmpfs"
grep -q 'nosuid' <<<"$proxy_tmpfs"
grep -q 'nodev' <<<"$proxy_tmpfs"
grep -q '"ALL"' <<<"$(docker inspect --format '{{json .HostConfig.CapDrop}}' "$proxy_container")"
grep -q 'no-new-privileges' <<<"$(docker inspect --format '{{json .HostConfig.SecurityOpt}}' "$proxy_container")"
proxy_networks=$(docker inspect --format '{{range $name, $value := .NetworkSettings.Networks}}{{$name}} {{end}}' "$proxy_container")
proxy_internal_count=0
proxy_external_count=0
for network in $proxy_networks; do
  internal=$(docker network inspect --format '{{.Internal}}' "$network")
  if [[ "$internal" == "true" ]]; then
    proxy_internal_count=$((proxy_internal_count + 1))
  else
    proxy_external_count=$((proxy_external_count + 1))
  fi
done
[[ "$proxy_internal_count" -eq 1 && "$proxy_external_count" -eq 1 ]] || {
  echo "Egress proxy must attach only to one internal client network and one external egress network"
  exit 1
}

# A crawler worker must have no direct Internet route, but must be able to fetch
# both HTTP and HTTPS through the validated proxy.
echo "[runtime] Verify workers cannot bypass proxy and can fetch HTTP(S) through it"
timeout 60s "${compose[@]}" exec -T scrapling-workflow-worker python - <<'PY'
import socket
from scrapling.fetchers import Fetcher

try:
    socket.create_connection(("93.184.216.34", 80), timeout=2)
except OSError:
    pass
else:
    raise SystemExit("workflow worker bypassed the egress proxy")

proxy = "http://scrapling-egress-proxy:8080"
for target in ("https://example.com/", "http://example.com/"):
    page = Fetcher.get(
        target,
        timeout=10,
        retries=0,
        follow_redirects=True,
        proxy=proxy,
        impersonate=None,
        stealthy_headers=False,
    )
    assert page.status == 200, (target, page.status)
    assert "Example Domain" in page.get_all_text(strip=True)
print("Worker direct egress blocked; HTTP and HTTPS proxy fetches passed.")
PY

echo "[runtime] Verify proxy blocks cloud metadata endpoints"
timeout 15s "${compose[@]}" exec -T scrapling-workflow-worker python - <<'PY'
import socket
sock = socket.create_connection(("scrapling-egress-proxy", 8080), timeout=3)
sock.sendall(b"CONNECT 169.254.169.254:443 HTTP/1.1\r\nHost: 169.254.169.254:443\r\n\r\n")
response = sock.recv(4096)
sock.close()
assert response.startswith(b"HTTP/1.1 403"), response[:200]
print("Proxy rejected cloud metadata address.")
PY

echo "Crawler container runtime acceptance passed."
