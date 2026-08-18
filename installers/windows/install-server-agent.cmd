@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-server-agent.ps1" %*
