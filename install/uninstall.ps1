# ═══════════════════════════════════════════════════════════════
# LINKCORE — desinstalador de usuario
# Revierte exactamente lo que hace install.ps1: para el servicio,
# quita la tarea programada, quita la entrada de "Aplicaciones
# instaladas" y desenlaza el comando global. No toca los datos del
# usuario en ~/.linkcore (memoria, preferencias) -- si quiere borrarlos
# tambien, se le indica el camino al final.
# ═══════════════════════════════════════════════════════════════

$ErrorActionPreference = 'SilentlyContinue'

$CoreDir = Split-Path -Parent $PSScriptRoot
$CliJs = Join-Path $CoreDir 'bin\linkcore-cli.js'
$NodeExe = (Get-Command node.exe -ErrorAction SilentlyContinue).Source

Write-Host "[LinkCore] desinstalando..."

if ($NodeExe) { & $NodeExe $CliJs stop 2>$null | Out-Null }

Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'LinkCore'
Write-Host "[LinkCore] arranque automatico eliminado"

Remove-Item -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\LinkCore' -Force
Write-Host "[LinkCore] entrada de Aplicaciones instaladas eliminada"

Push-Location $CoreDir
& npm.cmd unlink --silent 2>$null | Out-Null
Pop-Location
Write-Host "[LinkCore] comando global desenlazado"

# MCP esta retirado (2026-08-16, ver install.ps1 paso 5) -- este paso
# queda solo para limpiar la entrada 'linkcore' en instalaciones que
# vengan de una version anterior. Deja todos los demas servidores del
# usuario intactos.
try {
  $McpConfigPath = Join-Path $env:USERPROFILE '.claude\mcp.json'
  if (Test-Path $McpConfigPath) {
    $RawContent = Get-Content $McpConfigPath -Raw -ErrorAction Stop
    $CleanContent = $RawContent -replace "^\xEF\xBB\xBF", '' -replace "^﻿", ''
    $McpConfig = $CleanContent | ConvertFrom-Json -ErrorAction Stop
    if ($McpConfig.mcpServers.PSObject.Properties.Name -contains 'linkcore') {
      $McpConfig.mcpServers.PSObject.Properties.Remove('linkcore')
      # Mismo fix que install.ps1: Set-Content -Encoding utf8 en Windows
      # PowerShell 5.1 escribe BOM siempre; se evita con WriteAllText.
      $Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
      [System.IO.File]::WriteAllText($McpConfigPath, ($McpConfig | ConvertTo-Json -Depth 10), $Utf8NoBom)
      Write-Host "[LinkCore] conexion MCP con Claude Code eliminada"
    }
  }
} catch {}

Write-Host ""
Write-Host "[LinkCore] desinstalado. Los datos en $env:USERPROFILE\.linkcore no se han tocado -- borralos a mano si quieres eliminarlos tambien."
