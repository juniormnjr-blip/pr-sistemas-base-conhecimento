# PR Sistemas - Base de Conhecimento

Sistema de base de conhecimento com login, artigos, anexos de imagem e banco PostgreSQL pronto para deploy na nuvem.

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

## Observacao importante

Os anexos estao sendo armazenados em `jsonb` no PostgreSQL como base64. Isso funciona bem para imagens pequenas e medias, mas para muitos arquivos ou imagens grandes o ideal e mover os anexos para um storage de objetos, como Supabase Storage, S3 ou Cloudflare R2.

## App Android

Tambem deixei o projeto preparado para gerar um APK Android que abre a versao publicada na nuvem.

- Pasta do projeto: [android](/C:/Users/User/Desktop/Base3/android)
- Build automatico: [.github/workflows/build-android-apk.yml](/C:/Users/User/Desktop/Base3/.github/workflows/build-android-apk.yml)

O APK sai como artefato do workflow `Build Android APK`. O pipeline tenta gerar uma APK release assinada e, se a assinatura nao estiver disponivel ou falhar, ele cai automaticamente para uma APK debug instalavel em celulares e tablets porque carrega a interface web responsiva do sistema.
