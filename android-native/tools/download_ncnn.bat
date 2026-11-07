@echo off
chcp 65001 >nul
REM 下载 ncnn Android Vulkan 预编译库并解压到 third_party/ncnn/
REM 依赖：Python（本机受管 Python 或系统 Python 均可）
setlocal
set "HERE=%~dp0.."
set "PY=C:\Users\徐梓烽\.workbuddy\binaries\python\versions\3.13.12\python.exe"
if not exist "%PY%" set "PY=python"
"%PY%" "%~dp0fetch_ncnn.py"
if errorlevel 1 (
    echo [失败] 下载或解压出错，请检查网络后重试
    exit /b 1
)
echo [完成] ncnn 已解压到 %HERE%\third_party\ncnn
endlocal
