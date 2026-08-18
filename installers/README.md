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
