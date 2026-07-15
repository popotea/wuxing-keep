@echo off
    chcp 65001 >nul
    cd /d "%~dp0"
    title WuXing Game - close this window to stop

    echo Starting Vite dev server (npm run dev)...
    echo Open your browser to http://localhost:5173 if it doesn't open automatically.
    echo.

    start /min cmd /c "timeout /t 3 /nobreak >nul & start http://localhost:5173"

    npm run dev