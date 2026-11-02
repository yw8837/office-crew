@echo off
chcp 65001 >nul
title 오피스 크루
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20 이상이 필요해. https://nodejs.org 에서 설치한 뒤 다시 실행해줘.
  pause
  exit /b 1
)
node bin\office-crew.js %*
pause
