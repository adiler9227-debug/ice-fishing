#!/bin/bash
# Установка «Ледяной рыбалки» на сервер отдельной службой (не трогает другие игры).
# Запуск:  bash /opt/ice-fishing/install.sh
set -e
APP_DIR="$(cd "$(dirname "$0")" && pwd)"
DATA_DIR=/var/lib/ice-fishing
UNIT=/etc/systemd/system/fishing.service

if [ "$(id -u)" != "0" ]; then echo "Запусти от root (или через sudo)."; exit 1; fi
NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then echo "Не найден Node.js. Он нужен так же, как для арены."; exit 1; fi

# Порт: оставляем прежний, если уже ставили; иначе первый свободный начиная с 3001
PORT="${PORT:-}"
if [ -z "$PORT" ] && [ -f "$UNIT" ]; then PORT="$(grep -o 'PORT=[0-9]*' "$UNIT" | head -1 | cut -d= -f2)"; fi
if [ -z "$PORT" ]; then
  for p in $(seq 3001 3020); do
    if ! ss -ltn | grep -q ":$p "; then PORT=$p; break; fi
  done
fi

mkdir -p "$DATA_DIR"

cat > "$UNIT" <<EOF
[Unit]
Description=Ice Fishing game (Ледяная рыбалка)
After=network.target

[Service]
WorkingDirectory=$APP_DIR
Environment=PORT=$PORT
Environment=DATA_DIR=$DATA_DIR
ExecStart=$NODE $APP_DIR/server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable fishing >/dev/null 2>&1
systemctl restart fishing

# Открыть порт, если на сервере включён ufw
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then ufw allow "$PORT"/tcp >/dev/null; fi

# Ежедневная копия сохранений (хранится 14 дней) в /var/backups/ice-fishing
cat > /etc/cron.daily/ice-fishing-backup <<EOF
#!/bin/sh
mkdir -p /var/backups/ice-fishing
tar czf /var/backups/ice-fishing/saves-\$(date +%F).tgz -C $DATA_DIR . 2>/dev/null
find /var/backups/ice-fishing -name 'saves-*.tgz' -mtime +14 -delete
EOF
chmod +x /etc/cron.daily/ice-fishing-backup

sleep 2
IP="$(curl -s -4 -m 5 ifconfig.me || hostname -I | awk '{print $1}')"
if curl -s -m 5 "http://127.0.0.1:$PORT/api/ping" | grep -q ice-fishing; then
  echo ""
  echo "✅ Готово! Ледяная рыбалка работает."
  echo "   Ссылка для игры:  http://$IP:$PORT"
  echo "   Сохранения:       $DATA_DIR"
  echo "   Обновить игру:    bash $APP_DIR/update.sh"
else
  echo "⚠️ Служба не ответила. Посмотри журнал: journalctl -u fishing -n 30"
fi
