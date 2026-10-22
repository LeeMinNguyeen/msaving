#!/bin/sh
# Once, on a server started with docker compose before the app was renamed (MSaving became Waterflow): the
# compose project is named waterflow, and Docker keeps a project's data in volumes named after it. This stops the
# msaving project, copies each of its volumes into the waterflow volume of the same kind, and starts the server
# under the new name, with the services that were running. The msaving volumes stay, untouched, until you remove
# them. Run it in the folder you cloned, after git pull:
#   sh scripts/move-to-waterflow.sh
set -eu

OLD=${OLD_PROJECT:-msaving}
VOLUMES="secrets db backups updates caddy"

cd "$(dirname "$0")/.."
NEW=$(docker compose config 2>/dev/null | sed -n 's/^name: //p' | head -n 1)
[ -n "$NEW" ] || { echo "Run this in the folder you cloned, after git pull: docker compose can't read docker-compose.yml here." >&2; exit 1; }

old_volumes=""
for v in $VOLUMES; do
  if docker volume inspect "${OLD}_$v" > /dev/null 2>&1; then old_volumes="$old_volumes $v"; fi
done
if [ "$OLD" = "$NEW" ] || [ -z "$old_volumes" ]; then
  echo "Nothing to move: no volumes of a project named $OLD (this one is $NEW)."
  exit 0
fi

new_volumes=""
for v in $VOLUMES; do
  if docker volume inspect "${NEW}_$v" > /dev/null 2>&1; then new_volumes="$new_volumes $v"; fi
done
if [ -n "$new_volumes" ]; then
  # The one-click update (Server admin) starts the new name next to the old server, whose port it can't take: its
  # server container is made but never starts, so the new volumes hold nothing anyone made.
  server=$(docker ps -aq --filter "label=com.docker.compose.project=$NEW" --filter "label=com.docker.compose.service=waterflow")
  if [ -n "$server" ] && [ "$(docker inspect -f '{{.State.StartedAt}}' $server)" = "0001-01-01T00:00:00Z" ]; then
    echo "Removing what the update started under the new name (its server never started)..."
    # shellcheck disable=SC2046
    docker rm -f $(docker ps -aq --filter "label=com.docker.compose.project=$NEW") > /dev/null
    for v in $new_volumes; do docker volume rm "${NEW}_$v" > /dev/null; done
    docker network rm "${NEW}_default" > /dev/null 2>&1 || true
  else
    cat >&2 <<EOF
Volumes named ${NEW}_* exist already: the server was started under the new name before its data was moved, with
new, empty storage. Your data is still in the ${OLD}_* volumes. Remove the new ones (anything made there since is
lost), then run this again:
  docker compose down --volumes
EOF
    exit 1
  fi
fi

running=$(docker ps --filter "label=com.docker.compose.project=$OLD" --format '{{.Label "com.docker.compose.service"}}')
containers=$(docker ps -aq --filter "label=com.docker.compose.project=$OLD")
echo "Stopping the $OLD project..."
# shellcheck disable=SC2086
[ -z "$containers" ] || { docker stop -t 60 $containers > /dev/null; docker rm $containers > /dev/null; }
docker network rm "${OLD}_default" > /dev/null 2>&1 || true

for v in $old_volumes; do
  echo "Copying ${OLD}_$v into ${NEW}_$v..."
  docker volume create "${NEW}_$v" > /dev/null
  docker run --rm --entrypoint sh -v "${OLD}_$v:/from:ro" -v "${NEW}_$v:/to" postgres:17 -c 'cp -a /from/. /to/'
done

# The built-in database stays off when it was (a server on its own Postgres, started with --scale db=0).
scale=""
echo "$running" | grep -qx db || scale="--scale db=0"
echo "Starting $NEW..."
# shellcheck disable=SC2086
docker compose up -d --build $scale

cat <<EOF

Done. Check the server, then remove what the old name left behind:
  docker volume rm$(for v in $old_volumes; do printf ' %s_%s' "$OLD" "$v"; done)
  docker image rm msaving:local msaving-updater:local
EOF
