@echo off
echo ========================================
echo Deploying CORS Fix to Railway
echo ========================================
echo.

echo Step 1: Adding server.js to Git...
git add server.js
if %errorlevel% neq 0 (
    echo ERROR: Failed to add server.js
    pause
    exit /b 1
)
echo ✓ server.js added

echo.
echo Step 2: Committing changes...
git commit -m "fix: Update CORS to allow nacos-tau-portal.netlify.app"
if %errorlevel% neq 0 (
    echo ERROR: Failed to commit
    pause
    exit /b 1
)
echo ✓ Changes committed

echo.
echo Step 3: Pushing to origin/main...
git push origin main
if %errorlevel% neq 0 (
    echo ERROR: Failed to push
    echo Make sure you're authenticated with Git
    pause
    exit /b 1
)
echo ✓ Pushed to origin/main

echo.
echo ========================================
echo SUCCESS!
echo ========================================
echo.
echo Railway should now auto-deploy the changes.
echo Wait 2-3 minutes, then refresh your frontend.
echo.
pause
