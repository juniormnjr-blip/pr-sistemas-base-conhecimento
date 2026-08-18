#!/usr/bin/env node

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_CONFIG_PATH = path.join(__dirname, 'unit-versions-agent.config.json');
const DEFAULT_ENDPOINT = 'https://pr-sistemas-base-conhecimento.onrender.com/api/unit-versions/ingest';
const DEFAULT_INTERVAL_MS = 30000;
const DEFAULT_RETRY_MS = 10000;
const require = createRequire(import.meta.url);
const { ConnectionPool } = require('mssql');

const args = parseArgs(process.argv.slice(2));
const configPath = path.resolve(args.config || DEFAULT_CONFIG_PATH);
const runtimeConfig = await loadConfig(configPath, args);

let inFlight = false;
let timer = null;
let lastSignature = '';
let watchInitialized = false;

main().catch(error => {
  console.error('[unit-versions-agent] erro fatal:', error);
  process.exitCode = 1;
});

async function main() {
  log(`config carregada de ${configPath}`);
  log(`endpoint: ${runtimeConfig.endpoint}`);
  log(`origem: ${runtimeConfig.source.type}`);

  if (!runtimeConfig.token) {
    throw new Error('token ausente. Defina "token" no arquivo de configuracao ou via --token.');
  }

  if (runtimeConfig.watch && runtimeConfig.source.type === 'json' && runtimeConfig.source.path) {
    startWatcher();
  }

  await runOnce();

  if (runtimeConfig.once) {
    return;
  }

  scheduleNext(runtimeConfig.pollIntervalMs);

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function runOnce() {
  if (inFlight) return null;
  inFlight = true;

  try {
    const payload = await loadPayload();
    const signature = stableStringify(payload);

    if (signature === lastSignature) {
      log('nenhuma mudanca detectada');
      return;
    }

    const response = await postPayload(payload);
    lastSignature = signature;

    log(`enviado com sucesso. ${response.processed || 0} registro(s) processado(s).`);
    return true;
  } catch (error) {
    console.error('[unit-versions-agent] falha ao enviar:', error.message || error);
    return false;
  } finally {
    inFlight = false;
  }
}

function scheduleNext(delayMs) {
  if (runtimeConfig.once) return;

  clearTimeout(timer);
  timer = setTimeout(async () => {
    const result = await runOnce();
    if (result === null) {
      scheduleNext(runtimeConfig.pollIntervalMs);
      return;
    }
    scheduleNext(result ? runtimeConfig.pollIntervalMs : runtimeConfig.retryIntervalMs);
  }, delayMs);
}

function startWatcher() {
  if (watchInitialized) return;
  watchInitialized = true;

  const watchedPath = runtimeConfig.source.path;
  let debounceTimer = null;

  try {
    fs.watch(watchedPath, { persistent: true }, () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        runOnce().catch(error => {
          console.error('[unit-versions-agent] falha no watcher:', error);
        });
      }, 750);
    });

    log(`watch ativo em ${watchedPath}`);
  } catch (error) {
    console.error(`[unit-versions-agent] nao foi possivel observar ${watchedPath}:`, error.message || error);
  }
}

async function loadPayload() {
  return loadSourcePayload(runtimeConfig.source);
}

async function loadSourcePayload(source) {
  if (!source || !source.type) {
    throw new Error('defina source.type no arquivo de configuracao.');
  }

  if (source.type === 'sql') {
    return loadPayloadFromSql(source.sql);
  }

  if (source.type === 'command') {
    if (!source.command) {
      throw new Error('defina source.command no arquivo de configuracao.');
    }

    return loadPayloadFromCommand(source.command, source.commandCwd);
  }

  if (!source.path) {
    throw new Error('defina source.path no arquivo de configuracao.');
  }

  return loadPayloadFromFile(source.path);
}

async function loadPayloadFromFile(filePath) {
  const content = await fsp.readFile(filePath, 'utf8');
  return parseJsonMaybe(content, filePath);
}

async function loadPayloadFromSql(sqlConfig = {}) {
  const connectionString = String(sqlConfig.connectionString || '').trim();
  const query = String(sqlConfig.query || '').trim();
  const queryTimeoutMs = normalizeInterval(sqlConfig.queryTimeoutMs, 15000, 1000);

  if (!connectionString) {
    throw new Error('defina source.sql.connectionString no arquivo de configuracao.');
  }

  if (!query) {
    throw new Error('defina source.sql.query no arquivo de configuracao.');
  }

  const pool = new ConnectionPool({
    connectionString,
    options: {
      encrypt: toBoolean(sqlConfig.encrypt),
      trustServerCertificate: sqlConfig.trustServerCertificate === undefined
        ? true
        : toBoolean(sqlConfig.trustServerCertificate)
    }
  });

  try {
    await pool.connect();
    const request = pool.request();
    request.timeout = queryTimeoutMs;
    const result = await request.query(query);
    return rowsToUnitVersionPayload(result.recordset || []);
  } finally {
    await pool.close().catch(() => {});
  }
}

function loadPayloadFromCommand(command, cwd) {
  const output = execSync(command, {
    cwd: cwd || process.cwd(),
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true
  });

  return parseJsonMaybe(output, 'command output');
}

function parseJsonMaybe(value, sourceLabel) {
  if (value && typeof value === 'object') {
    return value;
  }

  const text = String(value || '').trim();
  if (!text) {
    throw new Error(`conteudo vazio em ${sourceLabel}`);
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`o conteudo em ${sourceLabel} nao e JSON valido`);
  }
}

function rowsToUnitVersionPayload(rows) {
  if (!Array.isArray(rows)) {
    return rows;
  }

  const units = new Map();

  for (const row of rows) {
    if (!row || typeof row !== 'object') {
      continue;
    }

    const unitName = String(row.unitName || row.unit_name || row.unidade || row.nomeUnidade || row.name || '').trim();
    if (!unitName) {
      continue;
    }

    const existing = units.get(unitName) || {
      unitName,
      moduleVersions: [],
      sourceUpdatedAt: row.sourceUpdatedAt || row.source_updated_at || row.updatedAt || row.updated_at || null
    };

    const aggregated = row.moduleVersions || row.module_versions || row.modules || row.modulos;
    const normalizedAggregated = normalizeModuleVersions(aggregated);
    if (normalizedAggregated.length > 0) {
      existing.moduleVersions = mergeModuleVersions(existing.moduleVersions, normalizedAggregated);
      if (!existing.sourceUpdatedAt) {
        existing.sourceUpdatedAt = row.sourceUpdatedAt || row.source_updated_at || row.updatedAt || row.updated_at || null;
      }
      units.set(unitName, existing);
      continue;
    }

    const moduleName = String(row.moduleName || row.module_name || row.modulo || row.nomeModulo || row.module || '').trim();
    const version = String(row.version || row.versao || row.version_name || row.value || '').trim();

    if (moduleName) {
      existing.moduleVersions = mergeModuleVersions(existing.moduleVersions, [{
        moduleName,
        version,
        updatedAt: row.updatedAt || row.updated_at || row.sourceUpdatedAt || row.source_updated_at || null
      }]);
    }

    units.set(unitName, existing);
  }

  return Array.from(units.values());
}

function mergeModuleVersions(current = [], incoming = []) {
  const map = new Map();

  for (const item of [...current, ...incoming]) {
    if (!item || !item.moduleName) {
      continue;
    }

    map.set(String(item.moduleName).trim().toLowerCase(), {
      moduleName: String(item.moduleName).trim(),
      version: String(item.version || '').trim(),
      updatedAt: item.updatedAt || null
    });
  }

  return Array.from(map.values());
}

async function postPayload(payload) {
  const response = await fetch(runtimeConfig.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${runtimeConfig.token}`,
      'x-unit-versions-token': runtimeConfig.token
    },
    body: JSON.stringify(payload)
  });

  const text = await response.text();
  let data = {};

  if (text) {
    try {
      data = JSON.parse(text);
    } catch (error) {
      data = { raw: text };
    }
  }

  if (!response.ok) {
    const message = data.error || `HTTP ${response.status}`;
    throw new Error(message);
  }

  return data;
}

async function loadConfig(filePath, cliArgs) {
  const fileConfig = await readConfigFile(filePath);
  const merged = {
    endpoint: DEFAULT_ENDPOINT,
    token: '',
    source: {},
    sourceType: '',
    sourcePath: '',
    command: '',
    commandCwd: '',
    sqlConnectionString: '',
    sqlQuery: '',
    sqlEncrypt: undefined,
    sqlTrustServerCertificate: undefined,
    sqlQueryTimeoutMs: undefined,
    pollIntervalMs: DEFAULT_INTERVAL_MS,
    retryIntervalMs: DEFAULT_RETRY_MS,
    watch: false,
    once: false,
    ...fileConfig,
    ...cliArgs
  };

  const baseDir = path.dirname(filePath);
  const source = normalizeSourceConfig(merged, baseDir);

  return {
    endpoint: String(merged.endpoint || DEFAULT_ENDPOINT).trim(),
    token: String(merged.token || '').trim(),
    source,
    pollIntervalMs: normalizeInterval(merged.pollIntervalMs, DEFAULT_INTERVAL_MS, 10000),
    retryIntervalMs: normalizeInterval(merged.retryIntervalMs, DEFAULT_RETRY_MS, 5000),
    watch: toBoolean(merged.watch),
    once: toBoolean(merged.once)
  };
}

function normalizeSourceConfig(merged, baseDir) {
  const fileSource = merged.source && typeof merged.source === 'object' ? merged.source : {};
  const sqlSource = fileSource.sql && typeof fileSource.sql === 'object' ? fileSource.sql : {};
  const sourceType = String(
    fileSource.type
    || merged.sourceType
    || inferSourceType(merged)
  ).trim().toLowerCase();

  if (sourceType === 'sql') {
    return {
      type: 'sql',
      sql: {
        connectionString: String(
          sqlSource.connectionString
          || merged.sqlConnectionString
          || merged.connectionString
          || ''
        ).trim(),
        query: String(sqlSource.query || merged.sqlQuery || merged.query || '').trim(),
        encrypt: sqlSource.encrypt ?? merged.sqlEncrypt,
        trustServerCertificate: sqlSource.trustServerCertificate ?? merged.sqlTrustServerCertificate,
        queryTimeoutMs: sqlSource.queryTimeoutMs ?? merged.sqlQueryTimeoutMs
      },
      path: '',
      command: '',
      commandCwd: ''
    };
  }

  if (sourceType === 'command') {
    return {
      type: 'command',
      command: String(fileSource.command || merged.command || '').trim(),
      commandCwd: fileSource.commandCwd
        ? path.resolve(baseDir, String(fileSource.commandCwd))
        : (merged.commandCwd ? path.resolve(baseDir, String(merged.commandCwd)) : ''),
      path: '',
      sql: {}
    };
  }

  return {
    type: 'json',
    path: fileSource.path
      ? path.resolve(baseDir, String(fileSource.path))
      : (merged.sourcePath ? path.resolve(baseDir, String(merged.sourcePath)) : ''),
    command: '',
    commandCwd: '',
    sql: {}
  };
}

function inferSourceType(merged) {
  if ((merged.source && typeof merged.source === 'object' && merged.source.type) || merged.sqlConnectionString || merged.sqlQuery) {
    return 'sql';
  }

  if (merged.command || merged.source?.command) {
    return 'command';
  }

  return 'json';
}

async function readConfigFile(filePath) {
  try {
    const content = await fsp.readFile(filePath, 'utf8');
    return parseJsonMaybe(content, filePath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {};
    }
    throw error;
  }
}

function normalizeInterval(value, fallback, minimum) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return fallback;
  }

  return Math.max(Math.floor(numeric), minimum);
}

function toBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const text = String(value || '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(text);
}

function parseArgs(argv) {
  const result = {};

  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) continue;

    const [flag, inlineValue] = item.split('=', 2);
    const key = flag.replace(/^--/, '').replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());

    if (inlineValue !== undefined) {
      result[key] = inlineValue;
      continue;
    }

    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      result[key] = next;
      index += 1;
    } else {
      result[key] = true;
    }
  }

  return result;
}

function stableStringify(value) {
  return JSON.stringify(sortValue(value));
}

function sortValue(value) {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }

  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        acc[key] = sortValue(value[key]);
        return acc;
      }, {});
  }

  return value;
}

function log(message) {
  console.log(`[unit-versions-agent] ${message}`);
}

function shutdown() {
  clearTimeout(timer);
  log('encerrando');
  process.exit(0);
}
