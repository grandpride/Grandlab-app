@echo off
rem Removes the auto-start task. Does not touch the bridge or any data.
schtasks /Delete /TN "GrandlabBridge" /F
pause
