[CmdletBinding()]
param(
    [string]$OutputDir = '',
    [string]$ExeName = 'PR-Sistemas-Unit-Versions-Server-Installer.exe'
)

$ErrorActionPreference = 'Stop'

function Write-Info {
    param([string]$Message)
    Write-Host "[build-server-installer] $Message"
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$OutputDir = if ($OutputDir) { $OutputDir } else { Join-Path $repoRoot 'dist' }
$stagingRoot = Join-Path $PSScriptRoot 'staging-server-installer'
$payloadRoot = Join-Path $stagingRoot 'payload'
$bootstrapPath = Join-Path $stagingRoot 'bootstrap.ps1'
$sedPath = Join-Path $stagingRoot 'server-installer.sed'
$payloadZip = Join-Path $stagingRoot 'payload.zip'
$outputPath = Join-Path $OutputDir $ExeName

if (Test-Path $stagingRoot) {
    Remove-Item -LiteralPath $stagingRoot -Recurse -Force
}

New-Item -ItemType Directory -Force -Path $payloadRoot | Out-Null
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

Write-Info 'Copiando arquivos do agente...'
Copy-Item -Recurse -Force (Join-Path $repoRoot 'agent') (Join-Path $payloadRoot 'agent')
Copy-Item -Recurse -Force (Join-Path $repoRoot 'installers') (Join-Path $payloadRoot 'installers')

Write-Info 'Criando pacote ZIP de suporte...'
if (Test-Path $payloadZip) {
    Remove-Item -LiteralPath $payloadZip -Force
}

Compress-Archive -Path (Join-Path $payloadRoot '*') -DestinationPath $payloadZip -Force

Write-Info 'Gerando bootstrap...'
$bootstrapContent = @'
[CmdletBinding()]
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$ArgsFromExe
)

$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$payloadZip = Join-Path $here 'payload.zip'
$payloadExtracted = Join-Path $here 'payload'
$installer = Join-Path $payloadExtracted 'installers\windows\install-server-agent.ps1'

if (-not (Test-Path $payloadZip)) {
    throw "Arquivo payload.zip nao encontrado em $here"
}

if (-not (Test-Path $payloadExtracted)) {
    New-Item -ItemType Directory -Force -Path $payloadExtracted | Out-Null
    Expand-Archive -Path $payloadZip -DestinationPath $payloadExtracted -Force
}

Set-Location $payloadExtracted
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer @ArgsFromExe
'@

$bootstrapContent | Set-Content -Path $bootstrapPath -Encoding UTF8

Write-Info 'Montando SED do IExpress...'
$targetName = Join-Path $OutputDir $ExeName
$targetDisplay = 'PR Sistemas Unit Versions Server Installer'

$sedContent = @"
[Version]
Class=IEXPRESS
SEDVersion=3

[Options]
PackagePurpose=InstallApp
ShowInstallProgramWindow=1
HideExtractAnimation=1
UseLongFileName=1
InsideCompressed=0
CAB_FixedSize=0
CAB_ResvCodeSigning=0
RebootMode=N
TargetName=$targetName
FriendlyName=$targetDisplay
AppLaunched=cmd /c powershell.exe -ExecutionPolicy Bypass -File ".\bootstrap.ps1"
PostInstallCmd=<None>
SourceFiles=SourceFiles

[Strings]
TargetName=$targetName
FriendlyName=$targetDisplay
FILE0=bootstrap.ps1
FILE1=payload.zip

[SourceFiles]
SourceFiles0=$stagingRoot

[SourceFiles0]
%FILE0%=
%FILE1%=
"@

$sedContent | Set-Content -Path $sedPath -Encoding ASCII

Write-Info 'Executando IExpress...'
$iexpress = Get-Command iexpress.exe -ErrorAction SilentlyContinue
if (-not $iexpress) {
    throw 'iexpress.exe nao foi encontrado.'
}

& $iexpress.Source /N $sedPath | Out-Null

if (-not (Test-Path $targetName)) {
    throw "O executavel nao foi gerado em $targetName"
}

Write-Info "Executavel gerado em $targetName"
