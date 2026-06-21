@echo off
setlocal
cd /d "%~dp0backend"

set NO_PROXY=*
set no_proxy=*

if not exist ".venv\Scripts\activate.bat" (
  echo Backend virtual environment not found.
  echo Please run install_backend.bat first.
  pause
  exit /b 1
)

call ".venv\Scripts\activate.bat"
if not exist ".paddle-home" mkdir ".paddle-home"
set "HOME=%CD%\.paddle-home"
set "USERPROFILE=%CD%\.paddle-home"
set "XDG_CACHE_HOME=%CD%\.paddle-home\.cache"
set "PADDLE_HOME=%CD%\.paddle-home\.cache\paddle"
set "PADDLE_PDX_CACHE_HOME=%CD%\.paddle-home\.paddlex"
set "PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK=True"
set "FLAGS_enable_pir_api=0"
set "PADDLE_PDX_ENABLE_MKLDNN_BYDEFAULT=False"
python -m uvicorn app:app --host localhost --port 8765 --reload
pause
