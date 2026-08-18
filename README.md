# PR Sistemas - Base de Conhecimento

Sistema de base de conhecimento com login, artigos, anexos de imagem, versoes por unidade e banco PostgreSQL pronto para deploy na nuvem.

## Como rodar localmente

1. Crie um banco PostgreSQL.
2. Copie `.env.example` para `.env` e ajuste `DATABASE_URL`.
3. Instale as dependencias:

```bash
npm install
```

4. Inicie o servidor:

```bash
npm start
```

5. Abra `http://localhost:3000`.

## Credenciais iniciais

- Usuario: `admin`
- Senha: `admin`

## Deploy na nuvem

### Opcao recomendada: Render

1. Crie um novo **Web Service** apontando para este repositorio.
2. O Render vai ler o arquivo [render.yaml](/C:/Users/User/Desktop/Base3/render.yaml).
3. Adicione um banco **Render Postgres** no mesmo projeto.
4. Copie a `DATABASE_URL` do banco para a variavel de ambiente do servico web.
5. Mantenha `PGSSL=true` em producao.

### Variaveis de ambiente

- `DATABASE_URL`
- `JWT_SECRET`
- `PORT`
- `PGSSL`
- `UNIT_VERSIONS_SOURCE_URL`
- `UNIT_VERSIONS_SYNC_INTERVAL_MS`
- `UNIT_VERSIONS_INGEST_TOKEN`

## Observacao importante

Os anexos estao sendo armazenados em `jsonb` no PostgreSQL como base64. Isso funciona bem para imagens pequenas e medias, mas para muitos arquivos ou imagens grandes o ideal e mover os anexos para um storage de objetos, como Supabase Storage, S3 ou Cloudflare R2.

O sistema tambem sincroniza alteracoes em tempo real: o PostgreSQL notifica o backend e o frontend atualizado recebe os dados sem precisar recarregar a pagina.

### Versoes na unidade

A aba **Versoes na Unidade** pode funcionar de dois jeitos:

1. Buscando automaticamente em um servidor de origem
2. Recebendo envios de um agente instalado em cada servidor

#### Modo 1: servidor de origem

Nesse modo o sistema da nuvem consulta um endpoint externo e salva os dados no PostgreSQL.

Configure estas variaveis de ambiente no Render ou no seu `.env`:

- `UNIT_VERSIONS_SOURCE_URL`
- `UNIT_VERSIONS_SYNC_INTERVAL_MS`

Formato aceito do JSON de origem:

```json
[
  {
    "unitName": "Unidade Centro",
    "moduleVersions": [
      { "moduleName": "Financeiro", "version": "1.2.0" },
      { "moduleName": "Fiscal", "version": "3.4.1" }
    ]
  }
]
```

Tambem sao aceitos campos equivalentes como `unidade`, `unit`, `modules`, `modulos`, `version` e `versao`.

#### Modo 2: agente instalado no servidor

Se voce quiser instalar um arquivo direto no servidor para enviar as informacoes automaticamente para a nuvem, use o agente em [`agent/unit-versions-agent.mjs`](C:/Users/User/Desktop/Base3/agent/unit-versions-agent.mjs).

Ele pode ler um JSON local ou executar um comando que devolve JSON e enviar tudo para:

`POST /api/unit-versions/ingest`

Exemplo de configuracao:

```json
{
  "endpoint": "https://pr-sistemas-base-conhecimento.onrender.com/api/unit-versions/ingest",
  "token": "COLE_AQUI_O_TOKEN",
  "sourcePath": "C:/PR-Sistemas/unit-versions.json",
  "pollIntervalMs": 30000,
  "retryIntervalMs": 10000,
  "watch": true
}
```

Exemplo de arquivo local:

```json
{
  "unitName": "Unidade Centro",
  "moduleVersions": [
    { "moduleName": "Financeiro", "version": "1.2.0" },
    { "moduleName": "Fiscal", "version": "3.4.1" }
  ]
}
```

Tambem e aceito um objeto simples:

```json
{
  "unitName": "Unidade Centro",
  "moduleVersions": {
    "Financeiro": "1.2.0",
    "Fiscal": "3.4.1"
  }
}
```

Para executar o agente:

```bash
node agent/unit-versions-agent.mjs --config agent/unit-versions-agent.config.json
```

## App Android

Tambem deixei o projeto preparado para gerar um APK Android que abre a versao publicada na nuvem.

- Pasta do projeto: [android](/C:/Users/User/Desktop/Base3/android)
- Build automatico: [.github/workflows/build-android-apk.yml](/C:/Users/User/Desktop/Base3/.github/workflows/build-android-apk.yml)

O APK sai como artefato do workflow `Build Android APK`. O pipeline tenta gerar uma APK release assinada e, se a assinatura nao estiver disponivel ou falhar, ele cai automaticamente para uma APK debug instalavel em celulares e tablets porque carrega a interface web responsiva do sistema.
