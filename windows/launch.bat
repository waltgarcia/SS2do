@echo off
:: SS2do Windows Launcher
:: Double-click this file to start the app.

echo Starting SS2do...

:: Check Python is available
python --version >nul 2>&1
if errorlevel 1 (
    echo Python is not installed or not on PATH.
    echo Install Python from https://python.org/downloads/
    pause
    exit /b 1
)

:: Install/update dependencies silently
echo Checking dependencies...
pip install --quiet --upgrade pillow pytesseract 2>nul

:: Run the app
python "%~dp0ss2do_windows.py"

if errorlevel 1 (
    echo.
    echo SS2do exited with an error. See above for details.
    pause
)
