@echo off
title Offerly
cd /d "%~dp0"
if not exist node_modules\nodemailer (
  echo Installing dependencies...
  call npm install --omit=dev
)
echo Starting Offerly (uses an AI agent installed on this machine)...
rem Offer the agent CLIs signed in on this machine (Claude Code, Gemini CLI, Codex)
rem as engines, not only API keys.
set OFFERLY_ENABLE_SSO=1
start "" http://localhost:8787/apply
node bridge.js
pause
