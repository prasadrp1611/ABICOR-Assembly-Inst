@echo off
REM ===== ABICOR Assembly-Doc Generator - start the app (Windows) =====
cd /d "%~dp0"

if exist .venv\Scripts\activate.bat (
  call .venv\Scripts\activate.bat
) else (
  echo [warning] .venv not found - did you run setup.bat first?  Trying system Python...
)

echo.
echo Starting ABICOR Assembly-Doc Generator ...
echo It will open automatically at http://127.0.0.1:8000
echo Keep this window open while you use the app.   ^(Press Ctrl+C to stop^)
echo.
REM open the browser a few seconds after the server has started
start "" /min cmd /c "timeout /t 4 /nobreak >nul & start http://127.0.0.1:8000"
python server.py
pause
