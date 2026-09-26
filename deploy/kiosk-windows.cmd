@echo off
rem TV player (Windows). Put a shortcut to this in shell:startup, or use Assigned Access.
rem Usage: kiosk-windows.cmd http://board-server:8080/board/main
start "" msedge --kiosk "%~1" --edge-kiosk-type=fullscreen --no-first-run
