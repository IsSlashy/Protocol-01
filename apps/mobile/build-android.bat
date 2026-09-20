@echo off
set JAVA_HOME=C:\Program Files\Microsoft\jdk-17.0.20.101-hotspot
cd /d "D:\Protocol-01\apps\mobile"
call npx expo run:android --variant release
pause
