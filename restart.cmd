@echo off
chcp 65001 >nul
setlocal

echo ========================================
echo  SnowLuma Bridge - 重启开发服务器
echo ========================================
echo.

echo [1/4] 停止 Ollama（释放显存）...
taskkill /IM ollama.exe /F >nul 2>&1
if %errorlevel%==0 (
    echo       已停止
) else (
    echo       未在运行
)
timeout /t 1 /nobreak >nul

echo [2/4] 停止占用端口的进程...
for %%P in (5178 9510 9500) do (
    for /f "tokens=5" %%A in ('netstat -ano ^| findstr ":%%P " ^| findstr "LISTENING"') do (
        taskkill /PID %%A /T /F >nul 2>&1
        if not errorlevel 1 echo       端口 %%P 已释放 ^(PID %%A^)
    )
)
timeout /t 2 /nobreak >nul

echo [3/4] 检查残留...
set LEFTOVER=0
for %%P in (5178 9510 9500) do (
    netstat -ano | findstr ":%%P " | findstr "LISTENING" >nul 2>&1
    if not errorlevel 1 (
        echo       [警告] 端口 %%P 仍被占用
        set LEFTOVER=1
    )
)
if "%LEFTOVER%"=="1" (
    echo.
    echo   --------------------------------------------------
    echo    有端口无法释放，通常是因为进程以更高权限运行。
    echo    请右键本脚本 - 以管理员身份运行。
    echo   --------------------------------------------------
    echo.
    pause
    exit /b 1
)
echo       全部端口已释放

echo [4/4] 启动开发服务器...
echo.
cd /d "%~dp0"
call pnpm dev

endlocal
