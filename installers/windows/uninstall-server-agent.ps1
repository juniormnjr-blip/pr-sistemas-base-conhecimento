[CmdletBinding()]
param(
    [string]$InstallDir = "$env:ProgramData\PR-Sistemas-UnitVersionsAgent",
    [string]$TaskName = 'PR Sistemas Unit Versions Agent'
)

$ErrorActionPreference = 'Stop'

function Write-Info {
    param([string]$Message)
    Write-Host "[unit-versions-uninstaller] $Message"
}

Write-Info "Removendo tarefa agendada '$TaskName'..."
schtasks /Delete /TN $TaskName /F | Out-Null 2>$null

if (Test-Path $InstallDir) {
    Write-Info "Removendo pasta $InstallDir..."
    Remove-Item -LiteralPath $InstallDir -Recurse -Force
}

Write-Info 'Remocao concluida.'
