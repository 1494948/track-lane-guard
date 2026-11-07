@echo off
chcp 65001 >nul
REM 安装 Android NDK 与 CMake（只需一次）
REM 依赖：Android SDK Command-Line Tools（sdkmanager）
REM 版本需与 build.gradle.kts 中 externalNativeBuild.cmake.version 一致
setlocal
set "SDK=%ANDROID_SDK_ROOT%"
if "%SDK%"=="" (
    echo [错误] 请先设置环境变量 ANDROID_SDK_ROOT 指向你的 Android SDK
    exit /b 1
)
set "SDKMANAGER=%SDK%\cmdline-tools\latest\bin\sdkmanager.bat"
if not exist "%SDKMANAGER%" (
    echo [错误] 未找到 %SDKMANAGER%
    echo        请先安装 Command-Line Tools：
    echo        https://developer.android.com/studio#command-line-tools-only
    exit /b 1
)

echo 安装 NDK 27.0.12077973 与 CMake 3.22.1 ...
call "%SDKMANAGER%" --sdk_root="%SDK%" "ndk;27.0.12077973" "cmake;3.22.1"
if errorlevel 1 (
    echo [失败] 安装出错
    exit /b 1
)
echo [完成] NDK 与 CMake 已安装
echo        原生构建还需在 local.properties 中设置 sdk.dir
endlocal
