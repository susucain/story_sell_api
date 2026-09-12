# Production deployment

The production backend image is built by GitHub Actions, stored in Alibaba
Cloud ACR, and pulled by the ECS host. The ECS host does not build the
application or clone this repository.

## Image repository

```text
crpi-sddlrqkeigsw33zb.cn-hangzhou.personal.cr.aliyuncs.com/my_ai_project/story_sell_api
```

Production deployments use immutable tags in the form `sha-<git-sha>`.
The `latest` tag is published for convenience but is not used for deployment.

## One-time ECS setup

Run these commands as an administrator. Replace `deploy` if a different SSH
user will be stored in `ECS_USER`.

```bash
docker --version
docker compose version
curl --version

mkdir -p /opt/nest-langchain/scripts
chown deploy:deploy /opt/nest-langchain
chown deploy:deploy /opt/nest-langchain/docker-compose.prod.yml
chown -R deploy:deploy /opt/nest-langchain/scripts
usermod -aG docker deploy
```

Log out and back in after adding the user to the `docker` group. Then log in
to ACR as the deployment user:

```bash
docker login \
  crpi-sddlrqkeigsw33zb.cn-hangzhou.personal.cr.aliyuncs.com
```

The existing backend environment file remains on the server:

```text
/etc/secrets/env.prod
/etc/secrets/redis.prod
```

It must be readable by Docker Compose. Do not add it to GitHub or this
repository.

Use `env.prod.example` as the non-secret inventory of production variables.
When code introduces a new variable, add its name to the example and update
`/etc/secrets/env.prod` directly on the ECS host before deployment. Do not
copy the development `.env` wholesale: local hostnames such as `localhost`
and local callback URLs are invalid inside production containers.

`redis.prod` contains only `REDIS_PASSWORD`. Both files are readable by the
application deployment through a dedicated group:

```bash
groupadd --system deploy-secrets
usermod -aG deploy-secrets deploy
chgrp deploy-secrets /etc/secrets/env.prod
chgrp deploy-secrets /etc/secrets/redis.prod
chmod 640 /etc/secrets/env.prod /etc/secrets/redis.prod
```

The existing MySQL data remains at:

```text
/opt/nest-langchain/volumes/mysql
```

Back up this directory before the first automated deployment.
Do not recursively change the ownership of `/opt/nest-langchain`, because
the MySQL data directory must retain the ownership expected by its container.

Redis data is stored at:

```text
/opt/nest-langchain/volumes/redis
```

Redis is an application dependency and is started by the production Compose
file without publishing port 6379 to the public host.

## First database rollout

For a newly created, empty MySQL database, bootstrap the schema once before
running migrations:

1. Set `DB_SYNCHRONIZE=true` and `RUN_MIGRATIONS=false` in
   `/etc/secrets/env.prod`.
2. Deploy or start the backend and wait for the health check to pass.
3. Stop the backend, then set `DB_SYNCHRONIZE=false` and
   `RUN_MIGRATIONS=true`.
4. Start or deploy the backend again so TypeORM records and applies
   migrations.

`DB_SYNCHRONIZE` must remain `false` after this one-time empty-database
bootstrap. Do not enable it for an existing database.

## Langfuse

The application can export tracing to an external Langfuse deployment by
setting `LANGFUSE_ENABLED=true` and configuring `LANGFUSE_BASE_URL`,
`LANGFUSE_PUBLIC_KEY`, and `LANGFUSE_SECRET_KEY`.

Langfuse v3 is not included in the application Compose file. A self-hosted
installation also requires PostgreSQL, ClickHouse, Redis, object storage,
the Langfuse worker, and the Langfuse web service. It must run on a separate
host with sufficient memory or be replaced by Langfuse Cloud. Keep
`LANGFUSE_ENABLED=false` on this ECS until an external endpoint is ready.

## GitHub environment and secrets

Create a GitHub Actions environment named `production`, then add these
environment secrets:

```text
ACR_USERNAME
ACR_PASSWORD
ECS_HOST
ECS_PORT
ECS_USER
ECS_SSH_PRIVATE_KEY
ECS_KNOWN_HOSTS
```

`ECS_PORT` is normally `22`. `ECS_KNOWN_HOSTS` must contain the trusted SSH
host key for the exact hostname or IP used by `ECS_HOST`.

## First deployment

Open the `Deploy backend to production` workflow in GitHub Actions and run it
with `workflow_dispatch`. After it succeeds, pushes to `main` deploy
automatically.

The deployment script:

1. Updates `/opt/nest-langchain/.env.deploy` atomically.
2. Starts or preserves the existing MySQL service.
3. Pulls the image tagged with the current Git commit.
4. Recreates only the backend application container.
5. Checks `http://127.0.0.1:3000/`.
6. Restores the previous image if the health check fails.

## Manual rollback

Use a previously published immutable image:

```bash
/opt/nest-langchain/scripts/deploy-backend.sh \
  crpi-sddlrqkeigsw33zb.cn-hangzhou.personal.cr.aliyuncs.com/my_ai_project/story_sell_api:sha-<previous-git-sha>
```
