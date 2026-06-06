@echo off
REM ABICOR Assembly-Doc Generator launcher
cd /d "%~dp0"
echo Starting ABICOR Assembly-Doc Generator...
echo Open http://127.0.0.1:8000 in your browser.
python server.py
pause
