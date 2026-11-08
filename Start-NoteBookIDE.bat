@echo off
setlocal
set "LAUNCHER=%~dp0Start-NoteBookIDE.ps1"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%LAUNCHER%" %*
if errorlevel 1 pause
