@echo off
setlocal
cd /d "%~dp0backend"

if not exist ".venv\Scripts\activate.bat" (
  echo Backend virtual environment not found.
  echo Please run install_backend.bat first.
  pause
  exit /b 1
)

call ".venv\Scripts\activate.bat"
python -m uvicorn app:app --host 127.0.0.1 --port 8765
pause
