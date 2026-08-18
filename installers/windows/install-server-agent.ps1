[CmdletBinding()]
param(
    [string]$Endpoint = 'https://pr-sistemas-base-conhecimento.onrender.com/api/unit-versions/ingest',
    [string]$Token,
    [string]$InstallDir = "$env:ProgramData\PR-Sistemas-UnitVersionsAgent",
    [string]$TaskName = 'PR Sistemas Unit Versions Agent',
    [string]$SqlServer = 'localhost',
    [string]$SqlDatabase = 'cadastro',
    [string]$SqlUser = '',
    [string]$SqlPassword = '',
    [string]$SqlConnectionString = '',
    [string]$SqlQuery = @'
SET NOCOUNT ON;

DECLARE @Empresa varchar(200);

SELECT TOP (1)
    @Empresa = LTRIM(RTRIM(HOSP1))
FROM cadastro.dbo.Hospital
WHERE NULLIF(LTRIM(RTRIM(HOSP1)), '') IS NOT NULL;

DECLARE @Resultado TABLE
(
    ordem          int,
    modulo         varchar(100),
    versao         varchar(200),
    ultimo_uso     datetime NULL,
    fonte          varchar(200),
    observacao     varchar(300) NULL
);

INSERT INTO @Resultado
SELECT TOP (1)
    1,
    'Recepcao',
    LTRIM(RTRIM(VERSAO)),
    DTATENDE,
    'RECEPCAO.dbo.movimentos',
    NULL
FROM RECEPCAO.dbo.movimentos
WHERE VERSAO LIKE 'Recepcao:%'
ORDER BY DTATENDE DESC;

INSERT INTO @Resultado
SELECT TOP (1)
    2,
    'Internacao',
    LTRIM(RTRIM(VERSAO)),
    DTATENDE,
    'RECEPCAO.dbo.movimentos',
    NULL
FROM RECEPCAO.dbo.movimentos
WHERE VERSAO LIKE 'Interna%:%'
ORDER BY DTATENDE DESC;

INSERT INTO @Resultado
SELECT TOP (1)
    3,
    'Medico',
    LTRIM(RTRIM(L.VERSAO)),
    L.DATA_HORA,
    'ACESSO.dbo.LOG_LOGIN',
    NULL
FROM ACESSO.dbo.LOG_LOGIN AS L
WHERE L.SISTEMA = 25
  AND NULLIF(LTRIM(RTRIM(L.VERSAO)), '') IS NOT NULL
ORDER BY L.DATA_HORA DESC;

INSERT INTO @Resultado
SELECT TOP (1)
    4,
    'Assistencial',
    LTRIM(RTRIM(versao)),
    datahora,
    'RECEPCAO.dbo.controle_pac',
    NULL
FROM RECEPCAO.dbo.controle_pac
WHERE NULLIF(LTRIM(RTRIM(versao)), '') IS NOT NULL
ORDER BY datahora DESC;

INSERT INTO @Resultado
SELECT TOP (1)
    5,
    'Centro Cirurgico',
    LTRIM(RTRIM(versao)),
    DTHORA,
    'cirurgia.dbo.AvisoCirurgia',
    'Build: ' + COALESCE(LTRIM(RTRIM(dataver)), 'nao registrado')
FROM cirurgia.dbo.AvisoCirurgia
WHERE NULLIF(LTRIM(RTRIM(versao)), '') IS NOT NULL
ORDER BY DTHORA DESC;

INSERT INTO @Resultado
SELECT TOP (1)
    6,
    'Estoque',
    LTRIM(RTRIM(versao)),
    DATAHORA,
    'MATERIAS.dbo.MOVIMENTO',
    'Versao utilizada na movimentacao mais recente'
FROM MATERIAS.dbo.MOVIMENTO
WHERE NULLIF(LTRIM(RTRIM(versao)), '') IS NOT NULL
ORDER BY DATAHORA DESC, CODIGO DESC;

INSERT INTO @Resultado VALUES
(
    7,
    'Banco de Sangue',
    'NAO IDENTIFICADA',
    NULL,
    'C:\BCOSANGUE\BcoSangue.exe',
    'Executavel de 13/06/2024 sem FileVersion ou ProductVersion'
);

INSERT INTO @Resultado VALUES
(
    8,
    'MEDSQL',
    'Versao 1.8',
    NULL,
    'C:\CadMed\medsql.exe',
    'Versao identificada no executavel; arquivo de 15/09/2022'
);

INSERT INTO @Resultado VALUES
(
    9,
    'CadSis - Manutencao de Sistemas',
    'NAO IDENTIFICADA',
    NULL,
    'C:\Cadsis\CadSis.exe',
    'Executavel de 13/05/2019 sem FileVersion ou ProductVersion'
);

SELECT
    @Empresa AS nome_empresa,
    modulo,
    versao,
    ultimo_uso,
    fonte,
    observacao
FROM @Resultado
ORDER BY ordem;
'@,
    [int]$PollIntervalMs = 30000,
    [int]$RetryIntervalMs = 10000,
    [switch]$Watch,
    [switch]$Once
)

$ErrorActionPreference = 'Stop'

function Write-Info {
    param([string]$Message)
    Write-Host "[unit-versions-installer] $Message"
}

function Test-Administrator {
    $currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($currentIdentity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
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

    return $null
}

function Install-NodeJs {
    Write-Info 'Node.js nao encontrado. Tentando instalar via winget...'

    $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
    if (-not $winget) {
        throw 'Node.js nao encontrado e winget nao esta disponivel. Instale Node.js LTS manualmente e rode o instalador novamente.'
    }

    & $winget.Source install --id OpenJS.NodeJS.LTS -e --silent --accept-package-agreements --accept-source-agreements | Out-Null

    Start-Sleep -Seconds 10
    $nodePath = Resolve-NodePath
    if (-not $nodePath) {
        throw 'Node.js nao foi localizado apos a instalacao automatica.'
    }

    return $nodePath
}

function Get-ConnectionString {
    param(
        [string]$Server,
        [string]$Database,
        [string]$User,
        [string]$Password,
        [string]$ConnectionString
    )

    if ($ConnectionString) {
        return $ConnectionString
    }

    $builder = New-Object System.Data.SqlClient.SqlConnectionStringBuilder
    $builder['Data Source'] = $Server
    $builder['Initial Catalog'] = $Database
    $builder['TrustServerCertificate'] = $true
    $builder['Encrypt'] = $false

    if ($User) {
        $builder['Integrated Security'] = $false
        $builder['User ID'] = $User
        $builder['Password'] = $Password
    } else {
        $builder['Integrated Security'] = $true
    }

    return $builder.ToString()
}

function New-AgentPackageJson {
    param([string]$TargetDir)

    $package = [ordered]@{
        name = 'pr-sistemas-unit-versions-agent'
        private = $true
        type = 'module'
        version = '1.0.0'
        dependencies = @{
            mssql = '^12.7.0'
        }
    }

    $package | ConvertTo-Json -Depth 6 | Set-Content -Path (Join-Path $TargetDir 'package.json') -Encoding UTF8
}

function New-LauncherScript {
    param(
        [string]$TargetDir,
        [string]$NodePath
    )

    $agentPath = Join-Path $TargetDir 'unit-versions-agent.mjs'
    $configPath = Join-Path $TargetDir 'unit-versions-agent.config.json'
    $logPath = Join-Path $TargetDir 'agent.log'

    @"
@echo off
setlocal
"$NodePath" "$agentPath" --config "$configPath" >> "$logPath" 2>>&1
"@ | Set-Content -Path (Join-Path $TargetDir 'run-unit-versions-agent.cmd') -Encoding ASCII
}

function New-AgentConfig {
    param(
        [string]$TargetDir,
        [string]$EndpointValue,
        [string]$TokenValue,
        [string]$SqlConnectionStringValue,
        [string]$SqlQueryValue,
        [int]$PollIntervalValue,
        [int]$RetryIntervalValue,
        [bool]$WatchValue,
        [bool]$OnceValue
    )

    $config = [ordered]@{
        endpoint = $EndpointValue
        token = $TokenValue
        source = [ordered]@{
            type = 'sql'
            sql = [ordered]@{
                connectionString = $SqlConnectionStringValue
                query = $SqlQueryValue
                queryTimeoutMs = 15000
            }
        }
        pollIntervalMs = $PollIntervalValue
        retryIntervalMs = $RetryIntervalValue
        watch = $WatchValue
        once = $OnceValue
    }

    $config | ConvertTo-Json -Depth 12 | Set-Content -Path (Join-Path $TargetDir 'unit-versions-agent.config.json') -Encoding UTF8
}

function Install-Dependencies {
    param([string]$TargetDir)

    Write-Info 'Instalando dependencias do agente...'
    Push-Location $TargetDir
    try {
        npm install --omit=dev --no-fund --no-audit | Out-Host
    } finally {
        Pop-Location
    }
}

function Register-AgentTask {
    param(
        [string]$TaskNameValue,
        [string]$TargetDir
    )

    $launcher = Join-Path $TargetDir 'run-unit-versions-agent.cmd'
    $taskCommand = 'cmd.exe /c "' + $launcher + '"'
    Write-Info "Registrando tarefa agendada '$TaskNameValue'..."
    schtasks /Delete /TN $TaskNameValue /F | Out-Null 2>$null
    schtasks /Create /TN $TaskNameValue /SC ONSTART /RL HIGHEST /RU SYSTEM /TR $taskCommand | Out-Null
    schtasks /Run /TN $TaskNameValue | Out-Null
}

if (-not (Test-Administrator)) {
    throw 'Execute este instalador em um PowerShell com permissao de administrador.'
}

function Read-SecretPlainText {
    param([string]$Prompt)

    $secure = Read-Host $Prompt -AsSecureString
    if (-not $secure) {
        return ''
    }

    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
}

if (-not $Token) {
    $Token = Read-Host 'Token do Render (UNIT_VERSIONS_INGEST_TOKEN)'
}

if (-not $SqlConnectionString) {
    if (-not $PSBoundParameters.ContainsKey('SqlServer')) {
        $value = Read-Host "Servidor SQL [$SqlServer]"
        if ($value) { $SqlServer = $value }
    }

    if (-not $PSBoundParameters.ContainsKey('SqlDatabase')) {
        $value = Read-Host "Banco SQL [$SqlDatabase]"
        if ($value) { $SqlDatabase = $value }
    }

    if (-not $PSBoundParameters.ContainsKey('SqlUser')) {
        $SqlUser = Read-Host 'Usuario SQL (Enter para Windows Auth)'
    }

    if ($SqlUser) {
        $SqlPassword = Read-SecretPlainText 'Senha SQL'
    }
}

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$agentSource = Join-Path $repoRoot 'agent\unit-versions-agent.mjs'
$agentConfigSource = Join-Path $repoRoot 'agent\unit-versions-agent.config.example.json'

if (-not (Test-Path $agentSource)) {
    throw "Arquivo do agente nao encontrado: $agentSource"
}

$nodePath = Resolve-NodePath
if (-not $nodePath) {
    $nodePath = Install-NodeJs
}

$sqlConnectionStringValue = Get-ConnectionString -Server $SqlServer -Database $SqlDatabase -User $SqlUser -Password $SqlPassword -ConnectionString $SqlConnectionString

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Copy-Item -Force $agentSource (Join-Path $InstallDir 'unit-versions-agent.mjs')
if (Test-Path $agentConfigSource) {
    Copy-Item -Force $agentConfigSource (Join-Path $InstallDir 'unit-versions-agent.config.example.json')
}

New-AgentPackageJson -TargetDir $InstallDir
Install-Dependencies -TargetDir $InstallDir
New-AgentConfig -TargetDir $InstallDir -EndpointValue $Endpoint -TokenValue $Token -SqlConnectionStringValue $sqlConnectionStringValue -SqlQueryValue $SqlQuery -PollIntervalValue $PollIntervalMs -RetryIntervalValue $RetryIntervalMs -WatchValue ([bool]$Watch) -OnceValue ([bool]$Once)
New-LauncherScript -TargetDir $InstallDir -NodePath $nodePath
Register-AgentTask -TaskNameValue $TaskName -TargetDir $InstallDir

Write-Info "Agente instalado com sucesso em $InstallDir"
Write-Info "Config: $(Join-Path $InstallDir 'unit-versions-agent.config.json')"
Write-Info "Launcher: $(Join-Path $InstallDir 'run-unit-versions-agent.cmd')"
Write-Info "Log: $(Join-Path $InstallDir 'agent.log')"
