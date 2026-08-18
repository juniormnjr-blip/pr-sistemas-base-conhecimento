# Instaladores do agente

Esses arquivos servem para deixar o agente rodando sozinho nos servidores e enviando as versoes para a nuvem.

## Windows Server

Use [installers/windows/install-agent.ps1](/C:/Users/User/Desktop/Base3/installers/windows/install-agent.ps1).

Exemplo:

```powershell
.\install-agent.ps1 -Token "COLE_AQUI_O_TOKEN" -SourcePath "C:\PR-Sistemas\unit-versions.json"
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

Exemplo de query:

```sql
SELECT
  UnidadeNome AS unitName,
  ModuloNome AS moduleName,
  Versao AS version,
  DataAtualizacao AS updatedAt
FROM VersoesDaUnidade
```
