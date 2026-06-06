@echo off
REM ===== ABICOR Assembly-Doc Generator - one-time setup (Windows) =====
cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Python was not found on PATH.
  echo Install Python 3.10 or newer from https://www.python.org/downloads/
  echo  (tick "Add python.exe to PATH" during install^), then re-run setup.bat
  pause & exit /b 1
)

echo Creating virtual environment (.venv) ...
python -m venv .venv
call .venv\Scripts\activate.bat

echo Upgrading pip and installing dependencies (this can take a few minutes) ...
python -m pip install --upgrade pip
pip install -r requirements.txt
if errorlevel 1 (
  echo [ERROR] Dependency installation failed. Scroll up for the reason.
  pause & exit /b 1
)

if not exist .env copy .env.example .env >nul

echo.
echo ============================================================
echo  Setup complete!
echo.
echo  1^) Open the .env file and paste your GEMINI_API_KEY
echo     ^(get one free at https://aistudio.google.com/apikey^)
echo     -- OR skip this and paste the key in the app's Settings ^(gear icon^).
echo.
echo  2^) Double-click run.bat   ^(opens http://127.0.0.1:8000^)
echo.
echo  Optional - precise SAM segmentation backend:
echo     .venv\Scripts\activate.bat ^&^& pip install -r requirements-sam.txt
echo ============================================================
pause
