@echo off
title Offerly
cd /d "%~dp0"
if not exist node_modules\nodemailer (
  echo Installing dependencies...
  call npm install --omit=dev
)
rem The hosted page may use this bridge; no other website can.
if not defined OFFERLY_ALLOWED_ORIGINS set "OFFERLY_ALLOWED_ORIGINS=https://offerly-blue.vercel.app"
echo Starting Offerly (uses an AI agent installed on this machine)...
start "" http://localhost:8787/apply
node bridge.js
pause
