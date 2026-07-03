@echo off
setlocal

cd /d "%~dp0"
npm run build:service

if errorlevel 1 (
  echo.
  echo ERROR: No se pudo generar el instalador de servicio.
  exit /b 1
)

echo.
echo OK: dist\poc-log-service-installer.exe generado.
exit /b 0
