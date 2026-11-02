#!/bin/bash
# Обновить «Ледяную рыбалку» одной командой. Сохранения игроков не трогаются (они в /var/lib/ice-fishing).
cd "$(dirname "$0")" || exit 1
if [ -d .git ]; then git pull -q || { echo "Не получилось скачать обновление (git pull)"; exit 1; }; fi
systemctl restart fishing && sleep 1 && echo "✅ Обновлено: $(systemctl is-active fishing)"
