[CmdletBinding()]
param(
    [string]$Endpoint = 'https://pr-sistemas-base-conhecimento.onrender.com/api/unit-versions/ingest',
    [Parameter(Mandatory = $true)]
    [string]$Token,
    [Parameter(Mandatory = $true)]
    [string]$SourcePath,
    [string]$InstallDir = "$env:ProgramData\PR-Sistemas-UnitVersionsAgent",
    [string]$TaskName = 'PR Sistemas Unit Versions Agent',
    [int]$PollIntervalMs = 30000,
    [int]$RetryIntervalMs = 10000,
    [switch]$Watch,
    [switch]$Once,
    [string]$Command = '',
    [string]$CommandCwd = ''
)

$ErrorActionPreference = 'Stop'

function Write-Info {
    param([string]$Message)
    Write-Host "[unit-versions-installer] $Message"
}

function Resolve-NodePath {
    $node = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($node) {
        return $node.Source
    }

    $fallbacks = @(
        'C:\Program Files\nodejs\node.exe',
        'C:\Program Files (x86)\nodejs\node.exe'
    )

    foreach ($candidate in $fallbacks) {
        if (Test-Path $candidate) {
            return $candidate
        }
    }

    throw 'Node.js nao foi encontrado. Instale Node.js antes de registrar o agente.'
}

function Resolve-SourcePath {
    param([string]$Value)

    if ([System.IO.Path]::IsPathRooted($Value)) {
        return $Value
    }

    return (Resolve-Path $Value).Path
}

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$agentSource = Join-Path $repoRoot 'agent\unit-versions-agent.mjs'
$agentConfigSource = Join-Path $repoRoot 'agent\unit-versions-agent.config.example.json'

if (-not (Test-Path $agentSource)) {
    throw "Arquivo do agente nao encontrado: $agentSource"
}

$resolvedSourcePath = Resolve-SourcePath -Value $SourcePath
$resolvedCommandCwd = if ($CommandCwd) { Resolve-SourcePath -Value $CommandCwd } else { '' }

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Copy-Item -Force $agentSource (Join-Path $InstallDir 'unit-versions-agent.mjs')
if (Test-Path $agentConfigSource) {
    Copy-Item -Force $agentConfigSource (Join-Path $InstallDir 'unit-versions-agent.config.example.json')
}

$config = @{
    endpoint = $Endpoint
    token = $Token
    sourcePath = $resolvedSourcePath
    command = $Command
    commandCwd = $resolvedCommandCwd
    pollIntervalMs = $PollIntervalMs
    retryIntervalMs = $RetryIntervalMs
    watch = [bool]$Watch
    once = [bool]$Once
} | ConvertTo-Json -Depth 8

$configPath = Join-Path $InstallDir 'unit-versions-agent.config.json'
$config | Set-Content -Path $configPath -Encoding UTF8

$nodePath = Resolve-NodePath
$taskAction = "cmd.exe /c `"$nodePath`" `"$InstallDir\unit-versions-agent.mjs`" --config `"$configPath`""

Write-Info "Registrando tarefa agendada '$TaskName'..."
schtasks /Delete /TN $TaskName /F | Out-Null 2>$null
schtasks /Create /TN $TaskName /SC ONSTART /RL HIGHEST /RU SYSTEM /TR $taskAction | Out-Null

Write-Info "Ativando tarefa '$TaskName'..."
schtasks /Run /TN $TaskName | Out-Null

Write-Info "Agente instalado com sucesso em $InstallDir"
Write-Info "Config: $configPath"
Write-Info "Para verificar: schtasks /Query /TN `"$TaskName`" /V /FO LIST"
