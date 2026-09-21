#!/usr/bin/env bash
set -Eeuo pipefail

readonly DEPLOY_DIR="${DEPLOY_DIR:-/opt/nest-langchain}"
readonly COMPOSE_FILE="${DEPLOY_DIR}/docker-compose.prod.yml"
readonly DEPLOY_ENV="${DEPLOY_DIR}/.env.deploy"
readonly APP_ENV="/etc/secrets/env.prod"
readonly REDIS_ENV="/etc/secrets/redis.prod"
readonly NEW_IMAGE="${1:?Usage: deploy-backend.sh <image>}"

if [[ ! -f "${COMPOSE_FILE}" ]]; then
  echo "Compose file not found: ${COMPOSE_FILE}" >&2
  exit 1
fi

if [[ ! -r "${APP_ENV}" ]]; then
  echo "Application environment file is not readable: ${APP_ENV}" >&2
  exit 1
fi

if [[ ! -r "${REDIS_ENV}" ]]; then
  echo "Redis environment file is not readable: ${REDIS_ENV}" >&2
  exit 1
fi

required_variables=(
  DB_NAME
  DB_PASS
  DB_PORT
  DB_USER
)
missing_variables=()

for variable in "${required_variables[@]}"; do
  if ! grep -Eq "^[[:space:]]*${variable}=.+" "${APP_ENV}"; then
    missing_variables+=("${variable}")
  fi
done

if (( ${#missing_variables[@]} > 0 )); then
  printf 'Missing required variables in %s:\n' "${APP_ENV}" >&2
  printf '  %s\n' "${missing_variables[@]}" >&2
  exit 1
fi

if ! grep -Eq '^[[:space:]]*REDIS_PASSWORD=.+' "${REDIS_ENV}"; then
  echo "Missing REDIS_PASSWORD in ${REDIS_ENV}" >&2
  exit 1
fi

previous_image=""
if [[ -f "${DEPLOY_ENV}" ]]; then
  previous_image="$(sed -n 's/^BACKEND_IMAGE=//p' "${DEPLOY_ENV}" | head -n 1)"
fi
if [[ -z "${previous_image}" ]]; then
  previous_image="$(
    docker inspect langchain-prod-nest-app \
      --format '{{.Config.Image}}' 2>/dev/null || true
  )"
fi

write_deploy_env() {
  local image="$1"
  local temporary_file
  temporary_file="$(mktemp "${DEPLOY_DIR}/.env.deploy.XXXXXX")"
  printf 'BACKEND_IMAGE=%s\n' "${image}" > "${temporary_file}"
  chmod 600 "${temporary_file}"
  mv "${temporary_file}" "${DEPLOY_ENV}"
}

compose() {
  docker compose \
    --env-file "${DEPLOY_ENV}" \
    -f "${COMPOSE_FILE}" \
    "$@"
}

wait_for_backend() {
  local attempts=18
  local delay_seconds=5

  for ((attempt = 1; attempt <= attempts; attempt++)); do
    if curl --fail --silent --show-error --max-time 5 \
      http://127.0.0.1:3000/ > /dev/null; then
      return 0
    fi
    echo "Health check ${attempt}/${attempts} failed; retrying..."
    sleep "${delay_seconds}"
  done

  return 1
}

migrations_enabled() {
  grep -Eq '^[[:space:]]*RUN_MIGRATIONS=true[[:space:]]*$' "${APP_ENV}"
}

rollback() {
  if [[ -z "${previous_image}" || "${previous_image}" == "${NEW_IMAGE}" ]]; then
    echo "No previous image is available for rollback." >&2
    return 1
  fi

  echo "Rolling back to ${previous_image}"
  write_deploy_env "${previous_image}"
  compose pull nest-app
  compose up -d --no-deps --force-recreate nest-app
  wait_for_backend
}

echo "Deploying ${NEW_IMAGE}"
write_deploy_env "${NEW_IMAGE}"
compose config --quiet
compose up -d mysql redis
compose pull nest-app
compose up -d --no-deps --force-recreate nest-app

if ! wait_for_backend; then
  echo "Deployment health check failed." >&2
  compose logs --tail=100 nest-app >&2 || true
  if migrations_enabled; then
    echo "Automatic rollback is disabled while migrations are enabled." >&2
    echo "Restore the database backup before returning to an older image." >&2
    exit 1
  fi
  rollback
  exit 1
fi

compose ps
echo "Deployment completed: ${NEW_IMAGE}"
