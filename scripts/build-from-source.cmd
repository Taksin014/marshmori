@echo off
rem For developers: builds Marshmori from this folder and installs it (run again to update).
rem Everyone else: no need to build, press "ติดตั้ง Marshmori" on https://taksin014.github.io/marshmori/
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
