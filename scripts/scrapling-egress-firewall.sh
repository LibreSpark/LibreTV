#!/usr/bin/env bash
set -euo pipefail

# Apply host-level Docker egress filtering for both Scrapling API and worker containers.
# Run on the Docker host as root after creating the Compose network.
# The /31 covers API .10 and worker .11; override if either static IP changes.
COLLECTOR_CIDR="${COLLECTOR_CIDR:-172.30.60.10/31}"
CHAIN="LIBRETV-SCRAPLING-EGRESS"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root (for example: sudo $0)" >&2
  exit 1
fi
if ! command -v iptables >/dev/null 2>&1; then
  echo "iptables is required; configure equivalent DOCKER-USER rules with your host firewall." >&2
  exit 1
fi
if ! iptables -w -nL DOCKER-USER >/dev/null 2>&1; then
  echo "Docker DOCKER-USER chain is unavailable. Start Docker with its iptables firewall integration enabled." >&2
  exit 1
fi

iptables -w -N "$CHAIN" 2>/dev/null || true
iptables -w -F "$CHAIN"

# Deny loopback, private, carrier-grade NAT, link-local, documentation,
# benchmarking, multicast, and reserved IPv4 destinations.
for cidr in \
  0.0.0.0/8 \
  10.0.0.0/8 \
  100.64.0.0/10 \
  127.0.0.0/8 \
  169.254.0.0/16 \
  172.16.0.0/12 \
  192.0.0.0/24 \
  192.0.2.0/24 \
  192.88.99.0/24 \
  192.168.0.0/16 \
  198.18.0.0/15 \
  198.51.100.0/24 \
  203.0.113.0/24 \
  224.0.0.0/4 \
  240.0.0.0/4
do
  iptables -w -A "$CHAIN" -d "$cidr" -j DROP
done

# Permit replies to collector-initiated public connections, then let Docker's
# normal forwarding policy handle all other public destinations.
# Keep this after the destination deny rules so pre-existing conntrack entries
# cannot bypass newly installed private/reserved-network blocks.
iptables -w -A "$CHAIN" -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
iptables -w -A "$CHAIN" -j RETURN

# Replace any previous jump for both collector containers without disturbing
# unrelated DOCKER-USER rules.
while iptables -w -C DOCKER-USER -s "$COLLECTOR_CIDR" -j "$CHAIN" 2>/dev/null; do
  iptables -w -D DOCKER-USER -s "$COLLECTOR_CIDR" -j "$CHAIN"
done
iptables -w -I DOCKER-USER 1 -s "$COLLECTOR_CIDR" -j "$CHAIN"

# DOCKER-USER only sees forwarded packets. Block direct access from the
# API and worker containers to host-local services as well (bridge gateway / host interfaces).
while iptables -w -C INPUT -s "$COLLECTOR_CIDR" -j DROP 2>/dev/null; do
  iptables -w -D INPUT -s "$COLLECTOR_CIDR" -j DROP
done
iptables -w -I INPUT 1 -s "$COLLECTOR_CIDR" -j DROP

# Fail the installer if either enforcement hook is not actually present.
iptables -w -C DOCKER-USER -s "$COLLECTOR_CIDR" -j "$CHAIN"
iptables -w -C INPUT -s "$COLLECTOR_CIDR" -j DROP

echo "Verified IPv4 egress restrictions for Scrapling API and worker $COLLECTOR_CIDR."
echo "The collector may reach public IPv4 destinations, but private/reserved ranges are blocked."
echo "IPv6 is disabled in the collector container by docker-compose.yml."
echo "To remove these rules: iptables -D DOCKER-USER -s $COLLECTOR_CIDR -j $CHAIN; iptables -D INPUT -s $COLLECTOR_CIDR -j DROP; iptables -F $CHAIN; iptables -X $CHAIN"
