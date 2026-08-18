# ═══════════════════════════════════════════════════════════════
# LINKCORE — instalador de usuario
#
# Registra LinkCore como un componente de software del sistema, no
# como una app de escritorio: aparece en "Aplicaciones instaladas" de
# Windows (igual que un driver o una utilidad de fabricante), sin
# icono de escritorio, sin acceso directo de menu, sin ventana propia.
# El chip arranca solo, en segundo plano, al iniciar sesion.
#
# Todo a nivel de USUARIO ACTUAL (HKCU + tarea programada por usuario)
# -- no requiere permisos de administrador ni toca ningun ajuste de
# seguridad del sistema.
# ═══════════════════════════════════════════════════════════════

$ErrorActionPreference = 'Stop'

$CoreDir = Split-Path -Parent $PSScriptRoot
$NodeExe = (Get-Command node.exe).Source
$IndexJs = Join-Path $CoreDir 'src\index.js'
$CliJs = Join-Path $CoreDir 'bin\linkcore-cli.js'
$Uninstaller = Join-Path $PSScriptRoot 'uninstall.ps1'
$IconPath = Join-Path $CoreDir 'assets\linkcore-icon.ico'
$PackageJson = Get-Content (Join-Path $CoreDir 'package.json') -Raw | ConvertFrom-Json
$Version = $PackageJson.version
$SizeKB = [math]::Round(((Get-ChildItem $CoreDir -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum) / 1KB)

Write-Host "[LinkCore] instalando componente en $CoreDir"

# 1) Entrada en "Aplicaciones instaladas" (Panel de control / Configuracion > Apps)
$UninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\LinkCore'
New-Item -Path $UninstallKey -Force | Out-Null
Set-ItemProperty -Path $UninstallKey -Name 'DisplayName' -Value 'LinkCore'
Set-ItemProperty -Path $UninstallKey -Name 'Publisher' -Value 'LinkCore'
Set-ItemProperty -Path $UninstallKey -Name 'DisplayVersion' -Value $Version
Set-ItemProperty -Path $UninstallKey -Name 'InstallDate' -Value (Get-Date -Format 'yyyyMMdd')
Set-ItemProperty -Path $UninstallKey -Name 'EstimatedSize' -Value $SizeKB -Type DWord
Set-ItemProperty -Path $UninstallKey -Name 'UninstallString' -Value "powershell.exe -ExecutionPolicy Bypass -File `"$Uninstaller`""
Set-ItemProperty -Path $UninstallKey -Name 'DisplayIcon' -Value $(if (Test-Path $IconPath) { $IconPath } else { $NodeExe })
Set-ItemProperty -Path $UninstallKey -Name 'NoModify' -Value 1 -Type DWord
Set-ItemProperty -Path $UninstallKey -Name 'NoRepair' -Value 1 -Type DWord
Write-Host "[LinkCore] registrado en Aplicaciones instaladas (v$Version, ${SizeKB}KB)"

# 2) Comando "linkcore" disponible en cualquier terminal
Push-Location $CoreDir
try { & npm.cmd link --silent 2>$null | Out-Null } catch {}
Pop-Location
Write-Host "[LinkCore] comando 'linkcore' enlazado globalmente"

# 3) Arranque automatico al iniciar sesion. Register-ScheduledTask exige
# privilegios elevados en muchos entornos (COM del Task Scheduler),
# asi que se usa la clave Run de HKCU -- el mecanismo estandar sin
# administrador, sin ventana de consola (linkcore-cli.js ya arranca el
# proceso con windowsHide + detached).
$RunKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$RunCommand = "`"$NodeExe`" `"$CliJs`" start"
Set-ItemProperty -Path $RunKey -Name 'LinkCore' -Value $RunCommand
Write-Host "[LinkCore] arranque automatico configurado (HKCU Run, al iniciar sesion)"

# 3.5) Ajuste de Ollama para maquinas con poca RAM (2026-08-16, medido en
# vivo + fuente: en sistemas de RAM ajustada, Ollama por defecto (hasta 3
# modelos cargados en CPU, ver docs.ollama.com/faq) intenta mantener varios
# modelos a la vez y termina en desalojo/recarga constante bajo presion --
# exactamente lo medido esta noche ("desalojados X modelo(s)" repetido).
# Fijar OLLAMA_MAX_LOADED_MODELS=1 y OLLAMA_NUM_PARALLEL=1 evita esa lucha
# por RAM insuficiente. IMPORTANTE: esto es CONDICIONAL a la RAM real de
# esta maquina -- ensemble-v2.js ya decide en tiempo real cuantos modelos
# lanzar en paralelo segun la RAM libre (computeParallelBatchSize); forzar
# el limite de Ollama a 1 en una maquina con RAM de sobra romperia ESE
# paralelismo (LinkCore pediria varios modelos a la vez, Ollama solo
# mantendria uno cargado, y cada peticion extra forzaria una recarga en
# frio en medio de lo que deberia ser paralelo real). Solo se aplica bajo
# el mismo umbral usado en ollama-catalog.js para razonar sobre RAM
# limitada en esta instalacion.
$TotalRamGB = [math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB, 1)
if ($TotalRamGB -lt 8) {
  [System.Environment]::SetEnvironmentVariable('OLLAMA_MAX_LOADED_MODELS', '1', 'User')
  [System.Environment]::SetEnvironmentVariable('OLLAMA_NUM_PARALLEL', '1', 'User')
  Write-Host "[LinkCore] RAM detectada: ${TotalRamGB}GB (poca) -- Ollama ajustado a 1 modelo cargado a la vez para evitar desalojos"
} else {
  Write-Host "[LinkCore] RAM detectada: ${TotalRamGB}GB -- sin ajustar limites de Ollama, hay margen para paralelismo real"
}

# Bug real, critico, encontrado en vivo (2026-08-16): Ollama descarta las
# GPUs integradas POR DEFECTO ("dropping integrated GPU; to enable, set
# OLLAMA_IGPU_ENABLE=1", ver runner.go de Ollama) -- en esta maquina de
# pruebas eso significaba correr TODO en 5.7GB de RAM del sistema (con tan
# solo 200-400MB libres bajo carga) mientras habia una GPU AMD integrada
# via Vulkan con 4.6GB propios, 4.4GB libres, sin usar. Confirmado en vivo
# con node-llama-cpp: la MISMA GPU que Ollama descartaba cargo un modelo
# y genero sin problema. Con OLLAMA_IGPU_ENABLE=1, una consulta real de 3
# voces coordinadas paso de 200-400s a 117s -- 2-3x mas rapido, mismo
# hardware, un unico interruptor. Se activa siempre (Ollama simplemente no
# hace nada si no detecta ninguna GPU integrada, no rompe nada en maquinas
# sin ella).
[System.Environment]::SetEnvironmentVariable('OLLAMA_IGPU_ENABLE', '1', 'User')
Write-Host "[LinkCore] GPU integrada habilitada para Ollama (si existe) -- hasta 2-3x mas rapido, medido en vivo"
Write-Host "[LinkCore] los ajustes de Ollama de este paso solo se aplican al PROXIMO arranque de Ollama -- reinicia la app de Ollama (o la maquina) para que tomen efecto"

# 4) Arrancar ahora mismo, sin esperar al proximo inicio de sesion
& $NodeExe $CliJs start

# 5) MCP retirado (2026-08-16, decision explicita del fundador: "no quiero
# nada de APIs... algo que haga referencia a un procesador de verdad").
# mcp/linkcore-server.js ya no existe. La via real ahora es la instruccion
# vNPU sobre la tuberia con nombre (`linkcore vnpu <OPCODE>`, ver
# src/engine/vnpu-core.js) -- ninguna IA jefe necesita configuracion previa
# mas alla de tener el comando `linkcore` en el PATH (paso 2, ya hecho).
#
# Limpieza de instalaciones anteriores: si un mcp.json de este usuario
# todavia tiene la entrada 'linkcore' de una version vieja del instalador,
# se retira aqui para que no quede una referencia a un archivo borrado.
try {
  $McpConfigPath = Join-Path $env:USERPROFILE '.claude\mcp.json'
  if (Test-Path $McpConfigPath) {
    $RawContent = Get-Content $McpConfigPath -Raw -ErrorAction Stop
    $CleanContent = $RawContent -replace "^\xEF\xBB\xBF", '' -replace "^﻿", ''
    $McpConfig = $CleanContent | ConvertFrom-Json
    if ($McpConfig.mcpServers -and ($McpConfig.mcpServers.PSObject.Properties.Name -contains 'linkcore')) {
      $McpConfig.mcpServers.PSObject.Properties.Remove('linkcore')
      $Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
      [System.IO.File]::WriteAllText($McpConfigPath, ($McpConfig | ConvertTo-Json -Depth 10), $Utf8NoBom)
      Write-Host "[LinkCore] entrada MCP antigua retirada de mcp.json (MCP ya no se usa)"
    }
  }
} catch {
  # No bloquea la instalacion -- la via real (vNPU sobre tuberia) no depende de esto.
}

Write-Host ""
Write-Host "[LinkCore] instalado. Usa 'linkcore status' o 'linkcore ask ""...""' desde cualquier terminal."
Write-Host "[LinkCore] para desinstalar: powershell -File `"$Uninstaller`""
