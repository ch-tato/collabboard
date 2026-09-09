#!/bin/bash
set -euo pipefail

if [ ! -d "$HOME/collabboard" ]; then
  echo "Directory $HOME/collabboard not found. Cloning repository for the first time..."
  git clone "https://github.com/${GITHUB_REPOSITORY_LOWERCASE}.git" "$HOME/collabboard"
fi

cd "$HOME/collabboard"
git pull origin main

if [ -n "${GHCR_PAT:-}" ]; then
  echo "$GHCR_PAT" | docker login ghcr.io -u github-actions --password-stdin
fi

docker compose -f infra/docker-compose.yml pull backend-1 backend-2

# Ensure foundational services are up (certbot is removed)
docker compose -f infra/docker-compose.yml up -d nginx postgres redis

wait_for_healthy() {
  local service=$1
  local max_retries=20
  local retry=0
  
  while [ $retry -lt $max_retries ]; do
    local cid=$(docker compose -f infra/docker-compose.yml ps -q "$service")
    if [ -n "$cid" ]; then
      local health=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}unknown{{end}}' "$cid")
      if [ "$health" = "healthy" ]; then
        return 0
      fi
    fi
    sleep 3
    retry=$((retry+1))
  done
  
  echo "Error: $service failed to become healthy."
  return 1
}

# Rolling restart for zero-downtime
docker compose -f infra/docker-compose.yml up -d --no-deps backend-1
wait_for_healthy backend-1

docker compose -f infra/docker-compose.yml up -d --no-deps backend-2
wait_for_healthy backend-2

docker image prune -f
