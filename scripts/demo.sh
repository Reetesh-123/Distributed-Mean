#!/usr/bin/env bash
# Create a job, wait for it to finish, and verify the result against numpy.
# Usage: scripts/demo.sh [F] [C]      (defaults: F=50, C=10000)
# Needs the stack running (docker compose up -d --build) and curl.
set -euo pipefail

API="${API:-http://localhost:3000}"
F="${1:-50}"
C="${2:-10000}"

echo "Creating job: F=$F files, C=$C numbers per file"
resp=$(curl -sS -X POST "$API/jobs" -H 'Content-Type: application/json' -d "{\"F\":$F,\"C\":$C}")
job_id=$(echo "$resp" | sed -n 's/.*"jobId":"\([^"]*\)".*/\1/p')
if [ -z "$job_id" ]; then
  echo "Could not create job: $resp" >&2
  exit 1
fi
echo "Job id: $job_id"

start=$(date +%s)
status=""
while true; do
  job=$(curl -sS "$API/jobs/$job_id")
  status=$(echo "$job" | sed -n 's/.*"status":"\([A-Z]*\)".*/\1/p' | head -n 1)
  progress=$(echo "$job" | sed -n 's/.*"progress":"\{0,1\}\([0-9.]*\).*/\1/p' | head -n 1)
  printf '\r  status=%-10s progress=%5.1f%%  elapsed=%ss' "$status" "${progress:-0}" "$(( $(date +%s) - start ))"
  case "$status" in COMPLETED|FAILED|CANCELLED) break ;; esac
  if [ $(( $(date +%s) - start )) -gt "${TIMEOUT:-600}" ]; then echo; echo "Timed out" >&2; exit 1; fi
  sleep 1
done
echo

if [ "$status" != "COMPLETED" ]; then
  echo "Job ended as $status: $job" >&2
  exit 1
fi

out="result-$job_id.csv"
curl -sS -o "$out" "$API/jobs/$job_id/result"
echo "Downloaded $out ($(wc -l < "$out" | tr -d ' ') values)"

echo "Verifying against numpy (inside the worker image)..."
docker compose exec -T workers python -m distributed_mean.verify "$job_id"
echo "Done in $(( $(date +%s) - start ))s. Dashboard: $API"
