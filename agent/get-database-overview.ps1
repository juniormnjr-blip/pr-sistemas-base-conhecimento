[CmdletBinding()]
param(
    [string]$Server = 'localhost',
    [string]$Database = 'cadastro'
)

$ErrorActionPreference = 'Stop'

function Open-SqlConnection {
    param(
        [string]$Server,
        [string]$Database
    )

    $connection = New-Object System.Data.SqlClient.SqlConnection
    $connection.ConnectionString = "Server=$Server;Database=$Database;Integrated Security=True;TrustServerCertificate=True;"
    $connection.Open()
    return $connection
}

function Invoke-SqlRows {
    param(
        [string]$Server,
        [string]$Database,
        [string]$Query
    )

    $connection = Open-SqlConnection -Server $Server -Database $Database
    try {
        $command = $connection.CreateCommand()
        $command.CommandText = $Query
        $reader = $command.ExecuteReader()
        try {
            $table = New-Object System.Data.DataTable
            $table.Load($reader)
            return $table.Rows
        } finally {
        $reader.Close()
        }
    } finally {
        $connection.Close()
    }
}

$reportQuery = @"
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
"@

$reportRows = Invoke-SqlRows -Server $Server -Database $Database -Query $reportQuery
$reportRows = @($reportRows)

if ($reportRows.Count -eq 0) {
    throw 'Relatorio consolidado nao retornou linhas.'
}

$companyName = [string]$reportRows[0].nome_empresa
$companyNames = @()
if ($companyName.Trim()) {
    $companyNames += $companyName.Trim()
}

$payload = [ordered]@{
    unitName = $companyName
    companyNames = $companyNames
    moduleVersions = @(
    $reportRows | ForEach-Object {
        $updatedAt = $null
        if ($_.ultimo_uso) {
            try {
                $updatedAt = ([datetime]$_.ultimo_uso).ToString('o')
            } catch {
                $updatedAt = [string]$_.ultimo_uso
            }
        }

            [ordered]@{
                moduleName = [string]$_.modulo
                version = [string]$_.versao
                updatedAt = $updatedAt
                source = [string]$_.fonte
                observation = [string]$_.observacao
            }
        }
    )
}

$payload | ConvertTo-Json -Depth 8
