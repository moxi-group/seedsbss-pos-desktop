import Database from 'better-sqlite3';
import { app, safeStorage } from 'electron';
import path from 'node:path';

import { MutationKind, MutationStatus, PendingMutation } from '../shared/bridge';
import { log } from './logger';

/**
 * Fila local durável de mutações do POS (vendas, abertura/fecho de
 * caixa, movimentos de caixa) feitas sem ligação à API. Processada pelo
 * `sync-engine.ts`. O payload de cada mutação fica cifrado em repouso
 * com `safeStorage` — mesma primitiva já usada em `secure-store.ts` para
 * o token, sem acrescentar nenhuma dependência de criptografia nova.
 *
 * `better-sqlite3` é síncrono (sem await) — a fila nunca é grande
 * (no máximo algumas centenas de mutações por terminal) e isto evita
 * complicar o resto do código principal, que já é maioritariamente
 * síncrono (ver secure-store.ts).
 */
interface Row {
  id: string;
  kind: string;
  method: string;
  path: string;
  payload_encrypted: string;
  status: string;
  attempts: number;
  last_error: string | null;
  local_ref: string;
  company_id: string;
  pos_id: string;
  depends_on_local_id: string | null;
  server_id: string | null;
  result_encrypted: string | null;
  created_at: string;
  synced_at: string | null;
}

let db: Database.Database | null = null;

function encrypt(value: unknown): string {
  const json = JSON.stringify(value);
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.encryptString(json).toString('base64');
  }
  log.warn('safeStorage indisponível — mutação offline guardada sem cifra');
  return `plain:${json}`;
}

function decrypt<T>(stored: string | null): T | null {
  if (stored === null) return null;
  try {
    const json = stored.startsWith('plain:')
      ? stored.slice('plain:'.length)
      : safeStorage.decryptString(Buffer.from(stored, 'base64'));
    return JSON.parse(json) as T;
  } catch (err) {
    log.warn('Não foi possível decifrar uma mutação offline; a ignorar', err);
    return null;
  }
}

function fromRow(row: Row): PendingMutation {
  return {
    id: row.id,
    kind: row.kind as MutationKind,
    path: row.path,
    payload: decrypt<Record<string, unknown>>(row.payload_encrypted) ?? {},
    status: row.status as MutationStatus,
    attempts: row.attempts,
    lastError: row.last_error,
    localRef: row.local_ref,
    companyId: row.company_id,
    posId: row.pos_id,
    dependsOnLocalId: row.depends_on_local_id,
    serverId: row.server_id,
    result: decrypt<Record<string, unknown>>(row.result_encrypted),
    createdAt: row.created_at,
    syncedAt: row.synced_at,
  };
}

function open(): Database.Database {
  if (db) return db;
  const file = path.join(app.getPath('userData'), 'offline-queue.db');
  db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS pending_mutations (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      payload_encrypted TEXT NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      local_ref TEXT NOT NULL,
      company_id TEXT NOT NULL,
      pos_id TEXT NOT NULL,
      depends_on_local_id TEXT,
      server_id TEXT,
      result_encrypted TEXT,
      created_at TEXT NOT NULL,
      synced_at TEXT
    );
    CREATE TABLE IF NOT EXISTS local_counters (
      company_id TEXT PRIMARY KEY,
      next_ref INTEGER NOT NULL DEFAULT 1
    );
  `);
  return db;
}

/** Referência humana sequencial por empresa (ex.: `OFFLINE-00042`) — só
 * para o operador/talão provisório acompanhar, nunca é um número fiscal. */
function nextLocalRef(companyId: string): string {
  const conn = open();
  conn
    .prepare('INSERT INTO local_counters (company_id, next_ref) VALUES (?, 1) ON CONFLICT(company_id) DO UPDATE SET next_ref = next_ref + 1')
    .run(companyId);
  const row = conn.prepare('SELECT next_ref FROM local_counters WHERE company_id = ?').get(companyId) as { next_ref: number };
  return `OFFLINE-${String(row.next_ref).padStart(5, '0')}`;
}

export const offlineStore = {
  enqueue(input: {
    id: string;
    kind: MutationKind;
    path: string;
    payload: Record<string, unknown>;
    companyId: string;
    posId: string;
    dependsOnLocalId?: string | null;
  }): PendingMutation {
    const conn = open();
    const localRef = nextLocalRef(input.companyId);
    const createdAt = new Date().toISOString();
    conn
      .prepare(
        `INSERT INTO pending_mutations
           (id, kind, method, path, payload_encrypted, status, attempts, last_error,
            local_ref, company_id, pos_id, depends_on_local_id, server_id, result_encrypted,
            created_at, synced_at)
         VALUES (?, ?, 'POST', ?, ?, 'pending', 0, NULL, ?, ?, ?, ?, NULL, NULL, ?, NULL)`,
      )
      .run(
        input.id,
        input.kind,
        input.path,
        encrypt(input.payload),
        localRef,
        input.companyId,
        input.posId,
        input.dependsOnLocalId ?? null,
        createdAt,
      );
    log.info(`[offline-queue] enfileirado ${input.kind} ${localRef} (empresa=${input.companyId})`);
    return this.get(input.id)!;
  },

  get(id: string): PendingMutation | null {
    const row = open().prepare('SELECT * FROM pending_mutations WHERE id = ?').get(id) as Row | undefined;
    return row ? fromRow(row) : null;
  },

  /** Mutações por sincronizar, por ordem de criação (FIFO) — garante que
   * uma `session_open` é sempre tentada antes dos filhos que dependem
   * dela (ver sync-engine.ts). */
  listPendingOrFailed(): PendingMutation[] {
    const rows = open()
      .prepare("SELECT * FROM pending_mutations WHERE status IN ('pending', 'failed') ORDER BY created_at ASC")
      .all() as Row[];
    return rows.map(fromRow);
  },

  /** Para a UI (contagem, lista de "vendas pendentes" no terminal). */
  listAll(companyId: string): PendingMutation[] {
    const rows = open()
      .prepare('SELECT * FROM pending_mutations WHERE company_id = ? ORDER BY created_at DESC LIMIT 200')
      .all(companyId) as Row[];
    return rows.map(fromRow);
  },

  markSyncing(id: string): void {
    open().prepare("UPDATE pending_mutations SET status = 'syncing' WHERE id = ?").run(id);
  },

  markSynced(id: string, serverId: string | null, result: Record<string, unknown>): void {
    open()
      .prepare(
        "UPDATE pending_mutations SET status = 'synced', server_id = ?, result_encrypted = ?, synced_at = ? WHERE id = ?",
      )
      .run(serverId, encrypt(result), new Date().toISOString(), id);
  },

  markFailed(id: string, error: string): void {
    open()
      .prepare(
        "UPDATE pending_mutations SET status = 'failed', attempts = attempts + 1, last_error = ? WHERE id = ?",
      )
      .run(error, id);
  },

  /** Devolve a mutação a `pending` para a próxima tentativa (backoff
   * controlado pelo sync-engine, não aqui). */
  markPending(id: string): void {
    open().prepare("UPDATE pending_mutations SET status = 'pending' WHERE id = ?").run(id);
  },
};
