@echo off
REM Launch an isolated side-load of Agentrium next to the installed prod app.
REM   usage: scripts\run-qa.cmd [instance-suffix]      (default: .qa)
REM   - AGENTRIUM_INSTANCE_ID=<suffix> -> separate SQLite data dir
REM       (%%APPDATA%%\claudeterminal\ClaudeTerminal<suffix>) + separate keychain slot
REM   - binary built with `npm run tauri build -- --config src-tauri/tauri.conf.qa.json --no-bundle`
REM     (identifier com.claudeterminal.desktop.qa, so single-instance lock does not collide with prod;
REM      it DOES collide between two side-loads, so close one before launching another suffix)
setlocal
set "SUFFIX=%~1"
if "%SUFFIX%"=="" set "SUFFIX=.qa"
set "AGENTRIUM_INSTANCE_ID=%SUFFIX%"
set "EXE=%~dp0..\src-tauri\target\release\claude-terminal.exe"
if not exist "%EXE%" (
  echo QA binary not found at "%EXE%".
  echo Build it first: npm run tauri build -- --config src-tauri/tauri.conf.qa.json --no-bundle
  exit /b 1
)
echo Launching Agentrium side-load with AGENTRIUM_INSTANCE_ID=%SUFFIX%
start "" "%EXE%"
endlocal
