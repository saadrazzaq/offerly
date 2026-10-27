@echo off
title Offerly (phone access)
cd /d "%~dp0"
if not exist node_modules\nodemailer (
  echo Installing dependencies...
  call npm install --omit=dev
)
echo Starting Offerly with phone access (same Wi-Fi only)...
rem Offer the agent CLIs signed in on this machine (Claude Code, Gemini CLI, Codex)
rem as engines, and let a paired phone on this Wi-Fi use them.
rem If Windows Firewall asks about Node.js, allow it on Private networks only.
set OFFERLY_ENABLE_SSO=1
set OFFERLY_LAN=1
start "" http://localhost:8787/phone
node bridge.js
pause
