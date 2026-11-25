@echo off
title Collins - start all
cd /d "%~dp0"

echo [1/2] Starting Collins server on :5090 ...
start "collins-server" cmd /k "cd /d %~dp0 && node server.js"

timeout /t 3 /nobreak >nul

echo [2/2] Starting Cloudflare tunnel ...
start "collins-tunnel" cmd /k "cloudflared tunnel --config ""%USERPROFILE%\.cloudflared\collins.yml"" run 30ff0ccd-5b8d-4c4c-8a86-4df6dc497e32"

timeout /t 5 /nobreak >nul

echo.
echo   Local  : http://localhost:5090
echo   Public : https://collins.startcollins.web.id
echo.
echo   Tutup kedua jendela itu untuk mematikan Collins.
echo.
pause
