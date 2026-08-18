# Instaladores do agente

Esses arquivos servem para deixar o agente rodando sozinho nos servidores e enviando as versoes para a nuvem.

## Windows Server

Use [installers/windows/install-agent.ps1](/C:/Users/User/Desktop/Base3/installers/windows/install-agent.ps1).

Exemplo:

```powershell
.\install-agent.ps1 -Token "COLE_AQUI_O_TOKEN" -SourcePath "C:\PR-Sistemas\unit-versions.json"
```

Para servidores que consultam SQL Server diretamente, use o instalador novo:

Use [installers/windows/install-server-agent.ps1](/C:/Users/User/Desktop/Base3/installers/windows/install-server-agent.ps1).

Exemplo:

```powershell
.\install-server-agent.ps1 -Token "COLE_AQUI_O_TOKEN" -SqlServer "SERVIDOR-SQL" -SqlDatabase "cadastro" -SqlUser "usuario_sql" -SqlPassword "SENHA_SQL"
```

Para execucao silenciosa em lote, use o executavel:

```powershell
PR-Sistemas-Unit-Versions-Server-Installer-Silent.exe -Token "COLE_AQUI_O_TOKEN" -SqlConnectionString "Server=SERVIDOR-SQL;Database=cadastro;User ID=usuario_sql;Password=SENHA_SQL;TrustServerCertificate=True;"
```

Se preferir, também existe o atalho em lote:

```bat
install-server-agent.cmd -Token "COLE_AQUI_O_TOKEN" -SqlConnectionString "Server=SERVIDOR-SQL;Database=cadastro;User ID=usuario_sql;Password=SENHA_SQL;TrustServerCertificate=True;"
```

Para remover a instalação, use:

```powershell
.\uninstall-server-agent.ps1
```

## Linux

Use [installers/linux/install-agent.sh](/C:/Users/User/Desktop/Base3/installers/linux/install-agent.sh).

Exemplo:

```bash
export TOKEN="COLE_AQUI_O_TOKEN"
export SOURCE_PATH="/opt/pr-sistemas/unit-versions.json"
sudo bash install-agent.sh
```

Os dois instaladores criam o arquivo de configuracao, copiam o agente e deixam o processo automatico ao iniciar o servidor.

## Modo SQL

O agente agora tambem entende `source.type = "sql"`. Nesse modo, o arquivo de configuracao aponta para o banco SQL Server local e para a query que deve retornar as colunas:

- `unitName`
- `moduleName`
- `version`
- `updatedAt` opcional

O instalador de servidor ja cria a configuracao nesse formato e registra a tarefa automatica.

Exemplo de query:

```sql
SELECT
  UnidadeNome AS unitName,
  ModuloNome AS moduleName,
  Versao AS version,
  DataAtualizacao AS updatedAt
FROM VersoesDaUnidade
```
