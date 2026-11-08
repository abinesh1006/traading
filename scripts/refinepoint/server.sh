#!/usr/bin/env bash
# Nifty Quant on the RefinePoint dev server.
#
# Everything lives under ~/niftyquant and listens on 127.0.0.1 only: reach it through an SSH tunnel
# (scripts\deploy_refinepoint.ps1 prints the command). Nothing system-wide is installed or changed:
# no sudo, no systemd unit, no nginx site. It does not restart after a server reboot unless you opt in
# with `server.sh enable-boot` (a user crontab @reboot line; undo with `disable-boot`).
#
#   server.sh install   unpack incoming/{src,web}.tar.gz, update the venv, build the backend jar
#   server.sh start | stop | restart | status
#   server.sh enable-boot | disable-boot   opt-in restart after a server reboot
#
# Layout: app.jar, web/ (built React app), venv/ (research API), data/ (Parquet copy), env (PG_*,
# chmod 600), logs/. The backend reads Postgres on this machine with Flyway disabled: migrations and
# pg-load stay with the PC, which is the only writer.
set -euo pipefail

ROOT="$HOME/niftyquant"
BACKEND_PORT=18088
QUANT_PORT=18001
cd "$ROOT"
mkdir -p logs

log() { echo "[$(date '+%F %T')] $*"; }

do_install() {
  log "unpacking source and web build"
  rm -rf src.new web.new && mkdir src.new web.new
  tar -xzf incoming/src.tar.gz -C src.new
  tar -xzf incoming/web.tar.gz -C web.new

  if [ ! -x venv/bin/pip ]; then
    # The system Python has the venv module but no ensurepip: bootstrap pip from PyPI.
    log "creating venv"
    python3 -m venv --without-pip venv
    curl -fsSL https://bootstrap.pypa.io/get-pip.py | venv/bin/python - -q
  fi
  log "installing the research API into the venv"
  venv/bin/pip install -q --upgrade ./src.new/quant

  # Built here with the Maven wrapper: the PC's uplink is slow, the server's is not.
  log "building the backend jar"
  (cd src.new/backend && sh mvnw -q -B -DskipTests package)
  cp src.new/backend/target/backend-*.jar app.jar.new

  rm -rf src web
  mv src.new src
  mv web.new web
  mv app.jar.new app.jar
  # `command`: run the coreutils binary, not a shell function of the same name.
  command install -m 755 src/scripts/refinepoint/server.sh "$ROOT/server.sh"
  log "installed (no auto-start after a server reboot unless you run: server.sh enable-boot)"
}

# Opt-in: restart the app after a server reboot through a user crontab @reboot line.
do_enable_boot() {
  local line="@reboot $ROOT/server.sh start >> $ROOT/logs/cron.log 2>&1"
  ( crontab -l 2>/dev/null | grep -vF "$ROOT/server.sh start" ; echo "$line" ) | crontab -
  log "enabled: starts after a reboot"
}

do_disable_boot() {
  ( crontab -l 2>/dev/null | grep -vF "$ROOT/server.sh start" ) | crontab -
  log "disabled auto-start after a reboot"
}

running() { [ -f "$1" ] && kill -0 "$(cat "$1")" 2>/dev/null; }

wait_http() {  # url, seconds
  for _ in $(seq 1 "$2"); do curl -fs -o /dev/null "$1" && return 0; sleep 1; done
  return 1
}

do_start() {
  [ -f env ] || { echo "missing $ROOT/env (PG_* settings)"; exit 1; }
  set -a; . "$ROOT/env"; set +a

  if running quant.pid; then
    log "research API already running"
  else
    log "starting research API on 127.0.0.1:$QUANT_PORT"
    NIFTYQUANT_DATA_DIR="$ROOT/data" nohup venv/bin/niftyquant serve --host 127.0.0.1 --port "$QUANT_PORT" \
      >> logs/quant.log 2>&1 &
    echo $! > quant.pid
  fi

  if running backend.pid; then
    log "backend already running"
  else
    log "starting backend on 127.0.0.1:$BACKEND_PORT"
    # Settings as environment variables, so the password is not visible in `ps`.
    SERVER_ADDRESS=127.0.0.1 SERVER_PORT="$BACKEND_PORT" \
    QUANT_SERVICE_URL="http://127.0.0.1:$QUANT_PORT" \
    SPRING_DATASOURCE_URL="jdbc:postgresql://${PG_HOST}:${PG_PORT}/${PG_DB}?sslmode=${PG_SSLMODE:-prefer}&ApplicationName=niftyquant-refinepoint" \
    SPRING_DATASOURCE_USERNAME="$PG_USER" SPRING_DATASOURCE_PASSWORD="$PG_PASSWORD" \
    SPRING_FLYWAY_ENABLED=false \
    SPRING_WEB_RESOURCES_STATIC_LOCATIONS="file:$ROOT/web/" \
    nohup java -Xmx512m -jar app.jar >> logs/backend.log 2>&1 &
    echo $! > backend.pid
  fi

  wait_http "http://127.0.0.1:$QUANT_PORT/health" 60 || { log "research API did not come up; see logs/quant.log"; exit 1; }
  wait_http "http://127.0.0.1:$BACKEND_PORT/actuator/health" 120 || { log "backend did not come up; see logs/backend.log"; exit 1; }
  log "up: http://127.0.0.1:$BACKEND_PORT"
}

do_stop() {
  for p in backend.pid quant.pid; do
    if running "$p"; then
      kill "$(cat "$p")"
      for _ in $(seq 1 30); do running "$p" || break; sleep 1; done
      running "$p" && kill -9 "$(cat "$p")"
      log "stopped ${p%.pid}"
    fi
    rm -f "$p"
  done
}

do_status() {
  for svc in "research API|http://127.0.0.1:$QUANT_PORT/health" "backend|http://127.0.0.1:$BACKEND_PORT/actuator/health"; do
    name="${svc%%|*}"; url="${svc#*|}"
    if curl -fs -o /dev/null "$url"; then echo "$name: up ($url)"; else echo "$name: DOWN"; fi
  done
  latest=$(curl -fs "http://127.0.0.1:$BACKEND_PORT/api/market/daily" 2>/dev/null | grep -o '"trade_date":"[0-9-]*"' | tail -1 || true)
  echo "latest session: ${latest:-unknown}"
}

case "${1:-status}" in
  install) do_install ;;
  start) do_start ;;
  stop) do_stop ;;
  restart) do_stop; do_start ;;
  status) do_status ;;
  enable-boot) do_enable_boot ;;
  disable-boot) do_disable_boot ;;
  *) echo "usage: server.sh install|start|stop|restart|status|enable-boot|disable-boot"; exit 2 ;;
esac
