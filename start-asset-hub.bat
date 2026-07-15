@echo off
chcp 65001 >nul
cd /d "%~dp0"
title WuXing Asset Hub - close this window to stop the server

echo Starting AI art asset server (npm run assets)...
echo This is separate from the Vite dev server and does not affect the game.
echo.

start /min cmd /c "timeout /t 1 /nobreak >nul & start http://localhost:8787"

node scripts\asset-server.cjs

echo.
echo Server stopped.
pause
