@echo off
chcp 65001 >nul
cd /d %~dp0
set PY=
py -3.12 --version >nul 2>&1 && set PY=py -3.12
if not defined PY py -3 --version >nul 2>&1 && set PY=py -3
if not defined PY python --version >nul 2>&1 && set PY=python
if not defined PY (
  echo [오류] Python을 찾지 못했습니다. https://www.python.org 에서 Python 3.12를 설치하고 "Add python.exe to PATH"를 체크하세요.
  pause & exit /b 1
)
if not exist .venv\Scripts\python.exe (
  echo 처음 한 번만 필요한 프로그램을 설치합니다...
  %PY% -m venv .venv || (echo [오류] 가상환경을 만들지 못했습니다. & pause & exit /b 1)
  .venv\Scripts\python.exe -m pip install -q -r bridge\requirements.txt || (echo [오류] 설치 실패. 인터넷 연결을 확인하세요. & pause & exit /b 1)
)
echo.
echo.
echo 브라우저에서 http://127.0.0.1:8000 을 엽니다. 끝내려면 이 창에서 Ctrl+C
start "" http://127.0.0.1:8000
cd bridge
..\.venv\Scripts\python.exe app.py --mock
pause
