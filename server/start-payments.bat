@echo off
title PXAXBEY2016 AI - payments
echo [1/2] Starting payment server (node server.js)...
start "pxax-server" /min cmd /c "node server.js"
echo [2/2] Starting cloudflared tunnel...
start "pxax-tunnel" /min cmd /c "cloudflared tunnel --url http://localhost:8787 --no-autoupdate > %TEMP%\cf_url.txt 2>&1"
timeout /t 8 >nul
findstr /C:"trycloudflare.com" "%TEMP%\cf_url.txt"
echo.
echo ВАЖНО: если URL изменился — обнови CONFIG.API_BASE в index.html и запушь.
echo Сервер и туннель работают в свёрнутых окнах. Закрыть: закрой эти окна.
pause
