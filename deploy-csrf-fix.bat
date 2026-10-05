@echo off
echo ========================================
echo Deploying CSRF SameSite Fix to Railway
echo ========================================
echo.

echo Problem: CSRF cookies blocked by SameSite=strict
echo Solution: Changed to SameSite=none for cross-origin
echo.

echo [1/4] Adding changed files...
git add config/security.js

echo.
echo [2/4] Committing changes...
git commit -m "Fix: CSRF sameSite=none for Netlify-Railway cross-origin requests"

echo.
echo [3/4] Pushing to GitHub...
git push origin main

echo.
echo [4/4] Done!
echo.
echo ========================================
echo Backend deployment triggered!
echo ========================================
echo.
echo Railway will auto-deploy in ~2 minutes.
echo.
echo Next steps:
echo 1. Wait 2 minutes for Railway deployment
echo 2. Check Railway logs for "Server running"
echo 3. Go to admin dashboard
echo 4. Hard refresh: Ctrl + Shift + R
echo 5. Try deleting a resource
echo.
echo Expected result:
echo   ✅ Resource deletes successfully
echo   ✅ No more 403 Forbidden errors
echo   ✅ Console shows success message
echo.
pause
