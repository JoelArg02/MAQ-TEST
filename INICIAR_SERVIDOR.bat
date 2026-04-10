@echo off
setlocal

cd /d "%~dp0"

echo ======================================
echo   Iniciando servidor MAQ-TEST...
echo ======================================
echo.

echo [GIT] Descargando cambios del repositorio remoto...
git fetch --all >nul 2>&1
if errorlevel 1 (
  echo [WARN] No se pudo conectar al repositorio remoto. Continuando con version local.
) else (
  for /f "tokens=*" %%b in ('git rev-parse --abbrev-ref HEAD 2^>nul') do set "BRANCH=%%b"
  git reset --hard origin/%BRANCH% >nul 2>&1
  echo [GIT] Repositorio sincronizado con origin/%BRANCH%.
)
echo.

where npm >nul 2>&1
if errorlevel 1 (
  echo [ERROR] npm no esta disponible en este sistema.
  echo Instala Node.js y vuelve a intentar.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo [INFO] No se encontro node_modules. Instalando dependencias...
  call npm install
  if errorlevel 1 (
    echo.
    echo [ERROR] Fallo la instalacion de dependencias.
    pause
    exit /b 1
  )
)

call npm run start
set "EXIT_CODE=%ERRORLEVEL%"

echo.
echo Proceso finalizado con codigo %EXIT_CODE%.
pause
exit /b %EXIT_CODE%
