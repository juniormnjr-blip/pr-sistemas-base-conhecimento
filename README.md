# PR Sistemas - Base de Conhecimento

Sistema de base de conhecimento com login, artigos, anexos de imagem e banco PostgreSQL pronto para deploy na nuvem.

## Como rodar localmente

1. Crie um banco PostgreSQL.
2. Copie `.env.example` para `.env` e ajuste `DATABASE_URL`.
3. Instale as dependências:

```bash
npm install
```

4. Inicie o servidor:

```bash
npm start
```

5. Abra `http://localhost:3000`.

## Credenciais iniciais

- Usuário: `admin`
- Senha: `admin`

## Deploy na nuvem

### Opção recomendada: Render

1. Crie um novo **Web Service** apontando para este repositório.
2. O Render vai ler o arquivo [render.yaml](/C:/Users/User/Desktop/Base3/render.yaml).
3. Adicione um banco **Render Postgres** no mesmo projeto.
4. Copie a `DATABASE_URL` do banco para a variável de ambiente do serviço web.
5. Mantenha `PGSSL=true` em produção.

### Variáveis de ambiente

- `DATABASE_URL`
- `JWT_SECRET`
- `PORT`
- `PGSSL`

## Observação importante

Os anexos estão sendo armazenados em `jsonb` no PostgreSQL como base64. Isso funciona bem para imagens pequenas e médias, mas para muitos arquivos ou imagens grandes o ideal é mover os anexos para um storage de objetos, como Supabase Storage, S3 ou Cloudflare R2.
