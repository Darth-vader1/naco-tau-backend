@echo off
echo ========================================
echo Running Migration 010: Fix Audit Logs RLS
echo ========================================
echo.

cd /d "%~dp0"
node scripts/migrate-010-audit-logs.js

echo.
echo ========================================
echo Migration script completed
echo ========================================
echo.
pause
