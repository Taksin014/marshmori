@echo off
rem For developers: builds Marshmori from this folder and installs it (run again to update).
rem Everyone else: double-click "ติดตั้ง Marshmori.exe" in the folder above instead.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
