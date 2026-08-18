require('dotenv').config();

const crypto = require('crypto');
const path = require('path');
const { URL } = require('url');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

const app = express();
const port = Number(process.env.PORT) || 3000;
const jwtSecret = process.env.JWT_SECRET || 'change-me-in-production';
const databaseUrl = normalizeDatabaseUrl(process.env.DATABASE_URL);
const fallbackDatabaseUrl = buildFallbackDatabaseUrl(databaseUrl);
const unitVersionsSourceUrl = String(process.env.UNIT_VERSIONS_SOURCE_URL || '').trim();
const unitVersionsIngestToken = String(process.env.UNIT_VERSIONS_INGEST_TOKEN || '').trim();
const unitVersionsSyncIntervalMs = Math.max(Number(process.env.UNIT_VERSIONS_SYNC_INTERVAL_MS || 300000), 60000);
const realtimeClients = new Set();
let dbListenerClient = null;
let unitVersionsSyncTimer = null;

if (!databaseUrl) {
  console.warn('AVISO: DATABASE_URL não definido. O servidor precisa de um PostgreSQL na nuvem ou local.');
}

const pool = databaseUrl
  ? new Pool({
      connectionString: databaseUrl,
      ssl: (() => {
        if (process.env.PGSSL === 'false') return false;
        if (process.env.PGSSL === 'true') return { rejectUnauthorized: false };
        if (/localhost|127\.0\.0\.1/i.test(databaseUrl)) return false;
        return { rejectUnauthorized: false };
      })()
    })
  : null;

app.use(express.json({ limit: '50mb' }));
app.use(cookieParser());
app.use(express.static(__dirname));

function requireDatabase() {
  if (!pool) {
    throw new Error('DATABASE_URL não configurado.');
  }
}

function normalizeDatabaseUrl(connectionString) {
  if (!connectionString) return null;

  const trimmed = String(connectionString).trim().replace(/^["']|["']$/g, '');
  const protocolMatch = trimmed.match(/postgres(?:ql)?:\/\//i);
  if (!protocolMatch) return trimmed;

  const protocolIndex = protocolMatch.index || 0;
  const rest = trimmed.slice(protocolIndex);
  const nextProtocolIndex = rest.slice(1).search(/postgres(?:ql)?:\/\//i);

  if (nextProtocolIndex >= 0) {
    return rest.slice(0, nextProtocolIndex + 1).replace(/[\s"'`]+$/g, '');
  }

  return rest;
}

function buildFallbackDatabaseUrl(connectionString) {
  if (!connectionString) return null;

  try {
    const parsed = new URL(connectionString);
    const host = parsed.hostname || '';

    if (host.includes('.render.com')) {
      return null;
    }

    if (host.startsWith('dpg-')) {
      parsed.hostname = `${host}.virginia-postgres.render.com`;
      return parsed.toString();
    }
  } catch (error) {
    return null;
  }

  return null;
}

function toSafeUser(row) {
  if (!row) return null;

  return {
    id: row.id,
    user: row.username,
    role: row.role
  };
}

function toSafeConfig(row) {
  return {
    modules: Array.isArray(row?.modules) && row.modules.length > 0 ? row.modules : ['Geral'],
    categories: Array.isArray(row?.categories) && row.categories.length > 0 ? row.categories : ['Erro']
  };
}

function toSafePost(row) {
  return {
    id: row.id,
    title: row.title,
    module: row.module,
    category: row.category,
    problem: row.problem,
    solution: row.solution,
    date: row.date_text,
    updatedAt: row.updated_at_text,
    author: row.author,
    problemImages: Array.isArray(row.problem_images) ? row.problem_images : [],
    solutionImages: Array.isArray(row.solution_images) ? row.solution_images : []
  };
}

async function query(text, params = []) {
  requireDatabase();

  try {
    return await pool.query(text, params);
  } catch (error) {
    const isDnsIssue = error?.code === 'ENOTFOUND' || /getaddrinfo ENOTFOUND/i.test(String(error?.message || ''));
    if (fallbackDatabaseUrl && isDnsIssue) {
      const fallbackPool = new Pool({
        connectionString: fallbackDatabaseUrl,
        ssl: { rejectUnauthorized: false }
      });

      const result = await fallbackPool.query(text, params);
      await fallbackPool.end().catch(() => {});
      return result;
    }

    throw error;
  }
}

async function ensureSchema() {
  requireDatabase();

  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin', 'editor', 'leitor')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      modules JSONB NOT NULL DEFAULT '["Geral"]'::jsonb,
      categories JSONB NOT NULL DEFAULT '["Erro"]'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS posts (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      module TEXT NOT NULL,
      category TEXT NOT NULL,
      problem TEXT NOT NULL,
      solution TEXT NOT NULL,
      author TEXT NOT NULL,
      date_text TEXT NOT NULL,
      updated_at_text TEXT NOT NULL,
      problem_images JSONB NOT NULL DEFAULT '[]'::jsonb,
      solution_images JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS unit_versions (
      id SERIAL PRIMARY KEY,
      unit_name TEXT NOT NULL UNIQUE,
      company_names JSONB NOT NULL DEFAULT '[]'::jsonb,
      module_versions JSONB NOT NULL DEFAULT '[]'::jsonb,
      source_updated_at TIMESTAMPTZ,
      synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await query(`
    ALTER TABLE unit_versions
    ADD COLUMN IF NOT EXISTS company_names JSONB NOT NULL DEFAULT '[]'::jsonb;
  `);

  await query(`
    INSERT INTO settings (id, modules, categories)
    VALUES (1, '["Geral"]'::jsonb, '["Erro"]'::jsonb)
    ON CONFLICT (id) DO NOTHING;
  `);

  await query(`
    CREATE OR REPLACE FUNCTION notify_realtime_change()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      PERFORM pg_notify(
        'prs_realtime',
        json_build_object(
          'table', TG_TABLE_NAME,
          'operation', TG_OP,
          'changed_at', NOW()
        )::text
      );

      RETURN COALESCE(NEW, OLD);
    END;
    $$;
  `);

  const realtimeTables = ['users', 'settings', 'posts', 'unit_versions'];
  for (const tableName of realtimeTables) {
    await query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_trigger t
          JOIN pg_class c ON c.oid = t.tgrelid
          WHERE t.tgname = 'prs_realtime_${tableName}_trigger'
            AND c.relname = '${tableName}'
        ) THEN
          CREATE TRIGGER prs_realtime_${tableName}_trigger
          AFTER INSERT OR UPDATE OR DELETE ON ${tableName}
          FOR EACH ROW
          EXECUTE FUNCTION notify_realtime_change();
        END IF;
      END;
      $$;
    `);
  }

  const adminCount = await query(`SELECT COUNT(*)::int AS total FROM users;`);
  if (adminCount.rows[0].total === 0) {
    const passwordHash = await bcrypt.hash('admin', 10);
    await query(
      `INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3);`,
      ['admin', passwordHash, 'admin']
    );
  }
}

async function getCurrentUser(req) {
  const token = req.cookies.prs_token;
  if (!token) return null;

  try {
    const payload = jwt.verify(token, jwtSecret);
    const result = await query(`SELECT id, username, role FROM users WHERE id = $1`, [payload.userId]);
    return toSafeUser(result.rows[0]);
  } catch (error) {
    return null;
  }
}

async function getConfigs() {
  const result = await query(`SELECT modules, categories FROM settings WHERE id = 1`);
  return toSafeConfig(result.rows[0]);
}

function toSafeUnitVersion(row) {
  if (!row) return null;

  return {
    id: row.id,
    unitName: row.unit_name,
    companyNames: normalizeCompanyNames(row.company_names),
    moduleVersions: normalizeModuleVersions(row.module_versions),
    sourceUpdatedAt: row.source_updated_at,
    syncedAt: row.synced_at,
    updatedAt: row.updated_at,
    createdAt: row.created_at
  };
}

function normalizeCompanyNames(value) {
  if (!value) return [];

  if (Array.isArray(value)) {
    return value
      .map(item => {
        if (!item) return '';
        if (typeof item === 'string') return String(item).trim();
        if (typeof item === 'object') {
          return String(item.companyName || item.company_name || item.nome || item.name || '').trim();
        }
        return String(item).trim();
      })
      .filter(Boolean);
  }

  if (typeof value === 'object') {
    return Object.values(value)
      .map(item => String(item || '').trim())
      .filter(Boolean);
  }

  const text = String(value || '').trim();
  return text ? [text] : [];
}

function normalizeModuleVersions(value) {
  if (!value) return [];

  if (Array.isArray(value)) {
    return value
      .map(item => {
        if (!item) return null;

        if (typeof item === 'string') {
          return { moduleName: item, version: '' };
        }

        if (Array.isArray(item)) {
          return {
            moduleName: String(item[0] || '').trim(),
            version: String(item[1] || '').trim()
          };
        }

        const moduleName = String(
          item.moduleName || item.module || item.name || item.modulo || item.module_name || ''
        ).trim();
        const version = String(item.version || item.versao || item.versionName || item.value || '').trim();
        const updatedAt = item.updatedAt || item.atualizadoEm || item.sourceUpdatedAt || null;
        const source = String(item.source || item.fonte || item.origin || item.sourceName || '').trim();
        const observation = String(item.observation || item.observacao || item.note || item.notes || '').trim();

        return {
          moduleName,
          version,
          updatedAt,
          source,
          observation
        };
      })
      .filter(item => item && item.moduleName);
  }

  if (typeof value === 'object') {
    return Object.entries(value)
      .map(([moduleName, version]) => ({
        moduleName: String(moduleName || '').trim(),
        version: typeof version === 'object' && version !== null
          ? String(version.version || version.versao || version.value || '').trim()
          : String(version || '').trim(),
        updatedAt: typeof version === 'object' && version !== null ? (version.updatedAt || version.atualizadoEm || version.sourceUpdatedAt || null) : null,
        source: typeof version === 'object' && version !== null ? String(version.source || version.fonte || version.origin || '').trim() : '',
        observation: typeof version === 'object' && version !== null ? String(version.observation || version.observacao || version.note || '').trim() : ''
      }))
      .filter(item => item.moduleName);
  }

  return [];
}

function extractUnitVersionRecords(payload) {
  if (!payload) return [];

  if (Array.isArray(payload)) {
    return payload;
  }

  if (typeof payload === 'object') {
    const keys = ['unitVersions', 'unit_versions', 'units', 'unidades', 'items', 'data', 'results', 'records'];
    for (const key of keys) {
      if (Array.isArray(payload[key])) {
        return payload[key];
      }
    }

    if (payload.unitName || payload.unit || payload.unidade) {
      return [payload];
    }
  }

  return [];
}

function normalizeUnitVersionRecord(record) {
  if (!record) return null;

  const unitName = String(record.unitName || record.unit || record.unidade || record.name || '').trim();
  if (!unitName) {
    return null;
  }

  const companyNames = normalizeCompanyNames(
    record.companyNames || record.company_names || record.companies || record.empresas || record.companyName || record.company_name || []
  );
  const moduleVersionsSource = record.moduleVersions || record.module_versions || record.modules || record.modulos || record.versions || record.versiones || {};
  const moduleVersions = normalizeModuleVersions(moduleVersionsSource);
  const sourceUpdatedAt = record.sourceUpdatedAt || record.updatedAt || record.atualizadoEm || record.syncedAt || null;

  return {
    unitName,
    companyNames,
    moduleVersions,
    sourceUpdatedAt
  };
}

function extractBearerToken(headerValue) {
  const value = String(headerValue || '').trim();
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function canAcceptUnitVersionIngest(req) {
  if (!unitVersionsIngestToken) {
    return false;
  }

  const bearerToken = extractBearerToken(req.headers.authorization);
  const headerToken = String(req.headers['x-unit-versions-token'] || '').trim();
  return bearerToken === unitVersionsIngestToken || headerToken === unitVersionsIngestToken;
}

async function getUnitVersions() {
  const result = await query(`SELECT * FROM unit_versions ORDER BY unit_name ASC`);
  return result.rows.map(toSafeUnitVersion);
}

async function upsertUnitVersion(record) {
  await query(
    `
      INSERT INTO unit_versions (unit_name, company_names, module_versions, source_updated_at, synced_at, updated_at)
      VALUES ($1, $2::jsonb, $3::jsonb, $4, NOW(), NOW())
      ON CONFLICT (unit_name)
      DO UPDATE SET
        company_names = EXCLUDED.company_names,
        module_versions = EXCLUDED.module_versions,
        source_updated_at = EXCLUDED.source_updated_at,
        synced_at = NOW(),
        updated_at = NOW()
    `,
    [
      record.unitName,
      JSON.stringify(record.companyNames || []),
      JSON.stringify(record.moduleVersions || []),
      record.sourceUpdatedAt || null
    ]
  );
}

async function syncUnitVersionsFromSource() {
  if (!unitVersionsSourceUrl) {
    return { synced: false, reason: 'UNIT_VERSIONS_SOURCE_URL not configured' };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(unitVersionsSourceUrl, {
      method: 'GET',
      headers: {
        Accept: 'application/json'
      },
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`Source server returned HTTP ${response.status}`);
    }

    const payload = await response.json();
    const records = extractUnitVersionRecords(payload)
      .map(normalizeUnitVersionRecord)
      .filter(Boolean);

    for (const record of records) {
      await upsertUnitVersion(record);
    }

    return {
      synced: true,
      total: records.length
    };
  } finally {
    clearTimeout(timeout);
  }
}

function startUnitVersionSyncScheduler() {
  if (!unitVersionsSourceUrl || unitVersionsSyncTimer) {
    return;
  }

  const runSync = async () => {
    try {
      const result = await syncUnitVersionsFromSource();
      if (result?.synced) {
        console.log(`Sincronização de versões concluída: ${result.total} unidade(s).`);
      }
    } catch (error) {
      console.error('Falha ao sincronizar versões da unidade:', error);
    }
  };

  runSync();
  unitVersionsSyncTimer = setInterval(runSync, unitVersionsSyncIntervalMs);
}

function broadcastRealtimeChange(payload) {
  const message = `data: ${JSON.stringify(payload)}\n\n`;

  for (const client of realtimeClients) {
    try {
      client.write(message);
    } catch (error) {
      realtimeClients.delete(client);
    }
  }
}

async function startRealtimeListener() {
  requireDatabase();

  if (dbListenerClient) {
    return;
  }

  const listenerConnectionString = fallbackDatabaseUrl || databaseUrl;
  const listenerPool = listenerConnectionString === databaseUrl
    ? pool
    : new Pool({
        connectionString: listenerConnectionString,
        ssl: {
          rejectUnauthorized: false
        }
      });

  try {
    dbListenerClient = await listenerPool.connect();
    await dbListenerClient.query(`LISTEN prs_realtime`);

    dbListenerClient.on('notification', notification => {
      if (!notification || notification.channel !== 'prs_realtime') {
        return;
      }

      let payload = {};
      try {
        payload = JSON.parse(notification.payload || '{}');
      } catch (error) {
        payload = { raw: notification.payload || null };
      }

      broadcastRealtimeChange({
        type: 'db-change',
        ...payload
      });
    });

    dbListenerClient.on('error', error => {
      console.error('Erro no listener realtime do PostgreSQL:', error);
    });
  } catch (error) {
    if (dbListenerClient) {
      try {
        dbListenerClient.release();
      } catch (releaseError) {
        // ignore release errors
      }
      dbListenerClient = null;
    }

    const isDnsIssue = error?.code === 'ENOTFOUND' || /getaddrinfo ENOTFOUND/i.test(String(error?.message || ''));
    if (isDnsIssue) {
      console.warn('Listener realtime indisponível. O servidor continuará funcionando sem push em tempo real.');
      return;
    }

    throw error;
  }
}

async function setConfigs(updater) {
  const current = await getConfigs();
  const next = updater(current);

  await query(
    `
      UPDATE settings
      SET modules = $1::jsonb,
          categories = $2::jsonb,
          updated_at = NOW()
      WHERE id = 1
    `,
    [JSON.stringify(next.modules), JSON.stringify(next.categories)]
  );

  return next;
}

async function getPosts() {
  const result = await query(`SELECT * FROM posts ORDER BY created_at DESC`);
  return result.rows.map(toSafePost);
}

async function getUsers() {
  const result = await query(`SELECT id, username, role FROM users ORDER BY created_at ASC`);
  return result.rows.map(toSafeUser);
}

app.get('/api/bootstrap', async (req, res) => {
  try {
    const user = await getCurrentUser(req);
    const [posts, configs, unitVersions] = await Promise.all([getPosts(), getConfigs(), getUnitVersions()]);
    const users = user?.role === 'admin' ? await getUsers() : [];

    res.json({
      user,
      posts,
      configs,
      users,
      unitVersions,
      unitVersionsSourceConfigured: Boolean(unitVersionsSourceUrl),
      unitVersionsIngestConfigured: Boolean(unitVersionsIngestToken)
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Não foi possível carregar os dados.' });
  }
});

app.get('/api/unit-versions', async (req, res) => {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return res.status(401).json({ error: 'Não autorizado.' });
    }

    res.json({
      unitVersions: await getUnitVersions(),
      sourceConfigured: Boolean(unitVersionsSourceUrl),
      ingestConfigured: Boolean(unitVersionsIngestToken)
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Falha ao listar versões da unidade.' });
  }
});

app.post('/api/unit-versions/ingest', async (req, res) => {
  try {
    if (!canAcceptUnitVersionIngest(req)) {
      return res.status(401).json({ error: 'Token inválido ou ausente.' });
    }

    const payload = req.body;
    const records = extractUnitVersionRecords(payload)
      .map(normalizeUnitVersionRecord)
      .filter(Boolean);

    if (records.length === 0) {
      return res.status(400).json({ error: 'Nenhum registro de versão válido foi enviado.' });
    }

    for (const record of records) {
      await upsertUnitVersion(record);
    }

    broadcastRealtimeChange({
      type: 'unit-versions-updated',
      records: records.map(record => record.unitName)
    });

    res.json({
      ok: true,
      processed: records.length,
      unitVersions: await getUnitVersions()
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Falha ao receber versões da unidade.' });
  }
});

app.post('/api/unit-versions/sync', async (req, res) => {
  try {
    const user = await getCurrentUser(req);
    if (!user || !['admin', 'editor'].includes(user.role)) {
      return res.status(403).json({ error: 'Sem permissão.' });
    }

    const result = await syncUnitVersionsFromSource();
    const unitVersions = await getUnitVersions();

    res.json({
      ...result,
      unitVersions,
      sourceConfigured: Boolean(unitVersionsSourceUrl)
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Falha ao sincronizar versões da unidade.' });
  }
});

app.delete('/api/unit-versions/:unitName', async (req, res) => {
  try {
    const user = await getCurrentUser(req);
    if (!user || !['admin', 'editor'].includes(user.role)) {
      return res.status(403).json({ error: 'Sem permissÃ£o.' });
    }

    const unitName = decodeURIComponent(String(req.params.unitName || '')).trim();
    if (!unitName) {
      return res.status(400).json({ error: 'Informe a unidade.' });
    }

    const result = await query(
      `DELETE FROM unit_versions WHERE unit_name = $1 RETURNING unit_name`,
      [unitName]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'VersÃ£o da unidade nÃ£o encontrada.' });
    }

    broadcastRealtimeChange({
      type: 'unit-versions-updated',
      records: [unitName]
    });

    res.json({
      ok: true,
      unitVersions: await getUnitVersions()
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Falha ao excluir versÃ£o da unidade.' });
  }
});

app.get('/api/events', async (req, res) => {
  try {
    const user = await getCurrentUser(req);
    if (!user) {
      return res.status(401).json({ error: 'Não autorizado.' });
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });

    res.write('retry: 3000\n\n');
    res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);

    realtimeClients.add(res);

    const heartbeat = setInterval(() => {
      res.write(': keep-alive\n\n');
    }, 25000);

    req.on('close', () => {
      clearInterval(heartbeat);
      realtimeClients.delete(res);
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Falha ao abrir o canal realtime.' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const username = String(req.body.user || '').trim();
    const password = String(req.body.pass || '');

    if (!username || !password) {
      return res.status(400).json({ error: 'Usuário e senha são obrigatórios.' });
    }

    const result = await query(
      `SELECT id, username, password_hash, role FROM users WHERE LOWER(username) = LOWER($1) LIMIT 1`,
      [username]
    );

    const user = result.rows[0];
    if (!user) {
      return res.status(401).json({ error: 'Acesso negado.' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Acesso negado.' });
    }

    const token = jwt.sign({ userId: user.id }, jwtSecret, { expiresIn: '7d' });
    res.cookie('prs_token', token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 7 * 24 * 60 * 60 * 1000
    });

    res.json({ user: toSafeUser(user) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Falha ao autenticar.' });
  }
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('prs_token', {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production'
  });

  res.json({ ok: true });
});

app.get('/api/me', async (req, res) => {
  try {
    const user = await getCurrentUser(req);
    res.json({ user });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Falha ao obter sessão.' });
  }
});

app.post('/api/posts', async (req, res) => {
  try {
    const user = await getCurrentUser(req);
    if (!user || !['admin', 'editor'].includes(user.role)) {
      return res.status(403).json({ error: 'Sem permissão.' });
    }

    const title = String(req.body.title || '').trim();
    const moduleName = String(req.body.module || '').trim();
    const category = String(req.body.category || '').trim();
    const problem = String(req.body.problem || '').trim();
    const solution = String(req.body.solution || '').trim();
    const problemImages = Array.isArray(req.body.problemImages) ? req.body.problemImages : [];
    const solutionImages = Array.isArray(req.body.solutionImages) ? req.body.solutionImages : [];

    if (!title || !moduleName || !category || !problem || !solution) {
      return res.status(400).json({ error: 'Preencha todos os campos obrigatórios.' });
    }

    const id = `post_${crypto.randomUUID()}`;
    const dateText = new Date().toLocaleDateString('pt-BR');
    const updatedText = dateText;

    const result = await query(
      `
        INSERT INTO posts (
          id, title, module, category, problem, solution, author,
          date_text, updated_at_text, problem_images, solution_images, created_by, updated_by
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12, $13)
        RETURNING *
      `,
      [
        id,
        title,
        moduleName,
        category,
        problem,
        solution,
        user.user,
        dateText,
        updatedText,
        JSON.stringify(problemImages),
        JSON.stringify(solutionImages),
        user.id,
        user.id
      ]
    );

    res.status(201).json({ post: toSafePost(result.rows[0]) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Falha ao salvar artigo.' });
  }
});

app.put('/api/posts/:id', async (req, res) => {
  try {
    const user = await getCurrentUser(req);
    if (!user || !['admin', 'editor'].includes(user.role)) {
      return res.status(403).json({ error: 'Sem permissão.' });
    }

    const postId = String(req.params.id);
    const currentResult = await query(`SELECT * FROM posts WHERE id = $1`, [postId]);
    const current = currentResult.rows[0];

    if (!current) {
      return res.status(404).json({ error: 'Artigo não encontrado.' });
    }

    const title = String(req.body.title || '').trim();
    const moduleName = String(req.body.module || '').trim();
    const category = String(req.body.category || '').trim();
    const problem = String(req.body.problem || '').trim();
    const solution = String(req.body.solution || '').trim();
    const problemImages = Array.isArray(req.body.problemImages) ? req.body.problemImages : current.problem_images || [];
    const solutionImages = Array.isArray(req.body.solutionImages) ? req.body.solutionImages : current.solution_images || [];

    if (!title || !moduleName || !category || !problem || !solution) {
      return res.status(400).json({ error: 'Preencha todos os campos obrigatórios.' });
    }

    const updatedText = new Date().toLocaleDateString('pt-BR');

    const result = await query(
      `
        UPDATE posts
        SET title = $2,
            module = $3,
            category = $4,
            problem = $5,
            solution = $6,
            updated_at_text = $7,
            problem_images = $8::jsonb,
            solution_images = $9::jsonb,
            updated_by = $10,
            updated_at = NOW()
        WHERE id = $1
        RETURNING *
      `,
      [
        postId,
        title,
        moduleName,
        category,
        problem,
        solution,
        updatedText,
        JSON.stringify(problemImages),
        JSON.stringify(solutionImages),
        user.id
      ]
    );

    res.json({ post: toSafePost(result.rows[0]) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Falha ao atualizar artigo.' });
  }
});

app.delete('/api/posts/:id', async (req, res) => {
  try {
    const user = await getCurrentUser(req);
    if (!user || !['admin', 'editor'].includes(user.role)) {
      return res.status(403).json({ error: 'Sem permissão.' });
    }

    await query(`DELETE FROM posts WHERE id = $1`, [String(req.params.id)]);
    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Falha ao excluir artigo.' });
  }
});

app.get('/api/users', async (req, res) => {
  try {
    const user = await getCurrentUser(req);
    if (!user || user.role !== 'admin') {
      return res.status(403).json({ error: 'Sem permissão.' });
    }

    res.json({ users: await getUsers() });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Falha ao listar usuários.' });
  }
});

app.post('/api/users', async (req, res) => {
  try {
    const user = await getCurrentUser(req);
    if (!user || user.role !== 'admin') {
      return res.status(403).json({ error: 'Sem permissão.' });
    }

    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    const role = String(req.body.role || 'leitor').trim();

    if (!username || !password) {
      return res.status(400).json({ error: 'Login e senha são obrigatórios.' });
    }

    if (!['admin', 'editor', 'leitor'].includes(role)) {
      return res.status(400).json({ error: 'Função inválida.' });
    }

    const exists = await query(`SELECT 1 FROM users WHERE LOWER(username) = LOWER($1)`, [username]);
    if (exists.rows.length > 0) {
      return res.status(409).json({ error: 'Esse usuário já existe.' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const result = await query(
      `INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3) RETURNING id, username, role`,
      [username, passwordHash, role]
    );

    res.status(201).json({ user: toSafeUser(result.rows[0]) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Falha ao criar usuário.' });
  }
});

app.delete('/api/users/:username', async (req, res) => {
  try {
    const user = await getCurrentUser(req);
    if (!user || user.role !== 'admin') {
      return res.status(403).json({ error: 'Sem permissão.' });
    }

    const username = String(req.params.username || '').trim();
    if (!username || username.toLowerCase() === 'admin') {
      return res.status(400).json({ error: 'Não é possível remover esse usuário.' });
    }

    await query(`DELETE FROM users WHERE LOWER(username) = LOWER($1)`, [username]);
    res.json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Falha ao remover usuário.' });
  }
});

app.post('/api/configs/modules', async (req, res) => {
  try {
    const user = await getCurrentUser(req);
    if (!user || user.role !== 'admin') {
      return res.status(403).json({ error: 'Sem permissão.' });
    }

    const name = String(req.body.name || '').trim();
    if (!name) {
      return res.status(400).json({ error: 'Informe um módulo.' });
    }

    const configs = await setConfigs(current => {
      const modules = Array.from(new Set([...current.modules, name]));
      return { ...current, modules };
    });

    res.json({ configs });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Falha ao adicionar módulo.' });
  }
});

app.delete('/api/configs/modules/:name', async (req, res) => {
  try {
    const user = await getCurrentUser(req);
    if (!user || user.role !== 'admin') {
      return res.status(403).json({ error: 'Sem permissão.' });
    }

    const name = String(req.params.name || '');
    const configs = await setConfigs(current => ({
      ...current,
      modules: current.modules.filter(item => item !== name)
    }));

    res.json({ configs });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Falha ao remover módulo.' });
  }
});

app.post('/api/configs/categories', async (req, res) => {
  try {
    const user = await getCurrentUser(req);
    if (!user || user.role !== 'admin') {
      return res.status(403).json({ error: 'Sem permissão.' });
    }

    const name = String(req.body.name || '').trim();
    if (!name) {
      return res.status(400).json({ error: 'Informe uma categoria.' });
    }

    const configs = await setConfigs(current => {
      const categories = Array.from(new Set([...current.categories, name]));
      return { ...current, categories };
    });

    res.json({ configs });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Falha ao adicionar categoria.' });
  }
});

app.delete('/api/configs/categories/:name', async (req, res) => {
  try {
    const user = await getCurrentUser(req);
    if (!user || user.role !== 'admin') {
      return res.status(403).json({ error: 'Sem permissão.' });
    }

    const name = String(req.params.name || '');
    const configs = await setConfigs(current => ({
      ...current,
      categories: current.categories.filter(item => item !== name)
    }));

    res.json({ configs });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Falha ao remover categoria.' });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

async function start() {
  try {
    await ensureSchema();
    await startRealtimeListener();
    startUnitVersionSyncScheduler();
    app.listen(port, () => {
      console.log(`Servidor rodando em http://localhost:${port}`);
    });
  } catch (error) {
    console.error('Não foi possível iniciar o servidor.');
    console.error(error);
    process.exit(1);
  }
}

start();
