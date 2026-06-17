@echo off
setlocal
cd /d "%~dp0backend"

set HTTP_PROXY=
set HTTPS_PROXY=
set ALL_PROXY=
set http_proxy=
set https_proxy=
set all_proxy=
set PIP_INDEX_URL=
set PIP_EXTRA_INDEX_URL=
set PIP_TRUSTED_HOST=
set PIP_CONFIG_FILE=NUL
set NO_PROXY=*
set no_proxy=*

if not exist ".venv" (
  py -m venv .venv
)

call ".venv\Scripts\activate.bat"
python -m pip install --upgrade pip -i https://pypi.tuna.tsinghua.edu.cn/simple --trusted-host pypi.tuna.tsinghua.edu.cn --proxy ""
if errorlevel 1 goto failed

pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple --trusted-host pypi.tuna.tsinghua.edu.cn --proxy ""
if errorlevel 1 (
  echo.
  echo Tsinghua mirror failed, retrying Aliyun mirror...
  pip install -r requirements.txt -i https://mirrors.aliyun.com/pypi/simple --trusted-host mirrors.aliyun.com --proxy ""
)
if errorlevel 1 goto failed

echo.
echo Backend dependencies installed.
echo Run start_backend.bat to start the local OCR service.
pause
exit /b 0

:failed
echo.
echo Backend dependency installation failed.
echo Please copy the error above and send it to Codex.
pause
exit /b 1
