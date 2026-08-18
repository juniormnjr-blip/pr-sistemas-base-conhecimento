[CmdletBinding()]
param(
    [string]$CompanyServer = 'localhost',
    [string]$CompanyDatabase = 'cadastro',
    [string]$VersionServer = 'localhost',
    [string]$VersionDatabase = 'RECEPCAO'
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

$companyQuery = @"
SELECT LTRIM(RTRIM(nome)) AS companyName
FROM dbo.empresa
WHERE nome IS NOT NULL
  AND LTRIM(RTRIM(nome)) <> ''
ORDER BY nome;
"@

$versionQuery = @"
WITH latest AS (
    SELECT
        Modulo,
        versao,
        Dthora,
        ROW_NUMBER() OVER (PARTITION BY Modulo ORDER BY Dthora DESC, cod DESC) AS rn
    FROM dbo.Versao
)
SELECT
    '$VersionDatabase' AS unitName,
    LTRIM(RTRIM(Modulo)) AS moduleName,
    LTRIM(RTRIM(versao)) AS version,
    CONVERT(varchar(33), Dthora, 126) AS updatedAt
FROM latest
WHERE rn = 1
ORDER BY moduleName;
"@

$companyRows = Invoke-SqlRows -Server $CompanyServer -Database $CompanyDatabase -Query $companyQuery
$versionRows = Invoke-SqlRows -Server $VersionServer -Database $VersionDatabase -Query $versionQuery

$payload = [ordered]@{
    unitName = $VersionDatabase
    companyNames = @(
        $companyRows | ForEach-Object { [string]$_.companyName } | Where-Object { $_ -and $_.Trim() }
    )
    moduleVersions = @(
        $versionRows | ForEach-Object {
            [ordered]@{
                moduleName = [string]$_.moduleName
                version = [string]$_.version
                updatedAt = [string]$_.updatedAt
            }
        }
    )
}

$payload | ConvertTo-Json -Depth 8
