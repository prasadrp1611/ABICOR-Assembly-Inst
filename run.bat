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
echo Open http://127.0.0.1:8000 in your browser.   ^(Press Ctrl+C to stop^)
echo.
python server.py
pause
