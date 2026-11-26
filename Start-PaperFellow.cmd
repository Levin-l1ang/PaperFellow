@echo off
setlocal
cd /d "%~dp0"
title PaperFellow

set "PAPER_NODE="
if defined PC_NODE if exist "%PC_NODE%" set "PAPER_NODE=%PC_NODE%"
if not defined PAPER_NODE for /f "delims=" %%N in ('where.exe node.exe 2^>nul') do if not defined PAPER_NODE set "PAPER_NODE=%%N"
if not defined PAPER_NODE for /f "delims=" %%N in ('powershell.exe -NoProfile -Command "foreach ($package in Get-AppxPackage -Name 'OpenAI.CodexPrimaryRuntime*' -ErrorAction SilentlyContinue) { $path = Join-Path $package.InstallLocation 'dependencies/node/bin/node.exe'; if (Test-Path -LiteralPath $path) { Write-Output $path; break } }"') do set "PAPER_NODE=%%N"
if not defined PAPER_NODE (
    echo Node.js 24 or newer is required to run PaperFellow.
    pause
    exit /b 1
)

if not defined PC_CODEX for /f "delims=" %%C in ('where.exe codex.exe 2^>nul') do if not defined PC_CODEX set "PC_CODEX=%%C"
if not defined PC_CODEX for /f "delims=" %%C in ('powershell.exe -NoProfile -Command "foreach ($package in Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction SilentlyContinue) { $path = Join-Path $package.InstallLocation 'app/resources/codex.exe'; if (Test-Path -LiteralPath $path) { Write-Output $path; break } }"') do set "PC_CODEX=%%C"

"%PAPER_NODE%" "%~dp0scripts\launch-windows.mjs"
set "START_RESULT=%ERRORLEVEL%"
echo.
echo Press any key to close this launcher window.
pause >nul
exit /b %START_RESULT%
