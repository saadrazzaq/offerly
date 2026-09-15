@echo off
title Offerly
cd /d "%~dp0"
if not exist node_modules\nodemailer (
  echo Installing dependencies...
  call npm install --omit=dev
)
echo Starting Offerly (uses your Claude Code subscription)...
start "" http://localhost:8787/apply
node bridge.js
pause
