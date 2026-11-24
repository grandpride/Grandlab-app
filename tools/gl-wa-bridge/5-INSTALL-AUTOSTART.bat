@echo off
rem Starts the CRM bridge automatically when you log in to Windows.
rem Safe: only adds one scheduled task called GrandlabBridge. Undo with 5-REMOVE-AUTOSTART.bat
cd /d "%~dp0"
schtasks /Create /TN "GrandlabBridge" /TR "\"%~dp04-RUN-BRIDGE.bat\"" /SC ONLOGON /RL LIMITED /F
echo.
echo Done. The bridge will start next time you log in. Do NOT also run it by hand at the same time.
pause
