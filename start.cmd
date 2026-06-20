@echo off
title Offerly
cd /d "%~dp0"
echo Starting Offerly (uses your Claude Code subscription)...
start "" http://localhost:8787/
node bridge.js
pause
