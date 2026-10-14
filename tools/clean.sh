#!/usr/bin/env bash
# Stop the stack and remove all its data: the database (jobs, tasks, activity log) and the
# generated files in ./data. The next `docker compose up` starts empty.
# Usage: tools/clean.sh
set -euo pipefail

cd "$(dirname "$0")/.."          # always run from the project folder, wherever it is called from

docker compose down -v           # stop the containers and delete the database volume
mkdir -p data
find data -mindepth 1 -delete    # delete the contents of ./data, keep the folder itself
echo "Stopped. Database and generated files removed."
