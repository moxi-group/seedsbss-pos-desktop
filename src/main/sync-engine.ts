import { BrowserWindow } from 'electron';

import { IPC, MutationKind, OfflineSyncEvent, PendingMutation } from '../shared/bridge';
import { effectiveApiUrl } from './config';
import { log } from './logger';
import { offlineStore } from './offline-store';
import { secureStore } from './secure-store';

const HEALTH_CHECK_EVERY_MS = 20_000;
const HEALTH_CHECK_TIMEOUT_MS = 5_000;
const TOKEN_KEY = 'sb_access_token';
const MAX_BACKOFF_MS = 60_000;

let getWindow: () => BrowserWindow | null = () => null;
let online = false;
let syncing = false;
// Backoff por mutação (em memória — reinicia se a app reiniciar, o que é
// razoável: um reinício já é uma nova oportunidade de tentar mais cedo).
const nextAttemptAt = new Map<string, number>();

function emit(event: OfflineSyncEvent): void {
  const win = getWindow();
  if (win && !win.isDestroyed()) win.webContents.send(IPC.offlineSyncEvent, event);
}

function emitStatus(): void {
  emit({ type: 'status', online, syncing, pendingCount: offlineStore.listPendingOrFailed().length });
}

/** Alcançável de verdade (não só "o OS diz que há rede") — pede `/health`,
 * que já existe na API, com um timeout curto. */
async function checkConnectivity(): Promise<boolean> {
  try {
    const base = new URL(effectiveApiUrl()).origin;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);
    try {
      const res = await fetch(`${base}/health`, { signal: controller.signal });
      return res.ok;
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return false;
  }
}

function resolvePath(mutation: PendingMutation): string | null {
  if (!mutation.path.includes('{{session_local_id}}')) return mutation.path;
  if (!mutation.dependsOnLocalId) return mutation.path;
  const parent = offlineStore.get(mutation.dependsOnLocalId);
  if (!parent || parent.status !== 'synced' || !parent.serverId) return null; // ainda não resolvido
  return mutation.path.replace('{{session_local_id}}', parent.serverId);
}

interface ReplayOutcome {
  ok: boolean;
  retryable: boolean;
  serverId: string | null;
  result: Record<string, unknown>;
  error: string | null;
}

async function replay(base: string, token: string, mutation: PendingMutation, path: string): Promise<ReplayOutcome> {
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(mutation.payload),
    });
  } catch (err) {
    return { ok: false, retryable: true, serverId: null, result: {}, error: errorMessage(err) };
  }

  if (res.ok) {
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: true, retryable: false, serverId: typeof body.id === 'string' ? body.id : null, result: body, error: null };
  }

  const detail = await extractDetail(res);

  // Reconciliação: perdas de rede a meio podem fazer com que o servidor
  // já tenha aplicado a mutação apesar de não termos recebido a resposta
  // (ou outro dispositivo já a aplicou entretanto). Nestes dois casos
  // específicos a verdade está no estado actual, não na resposta deste
  // pedido — ver seed_service/pos_session_service para as mensagens.
  if (mutation.kind === 'session_open' && res.status === 409) {
    const current = await fetchCurrentSession(base, token, mutation.companyId, mutation.posId);
    if (current) return { ok: true, retryable: false, serverId: String(current.id), result: current, error: null };
  }
  if (mutation.kind === 'session_close' && res.status === 409 && detail.includes('já está fechada')) {
    return { ok: true, retryable: false, serverId: null, result: {}, error: null };
  }

  const retryable = res.status >= 500;
  return { ok: false, retryable, serverId: null, result: {}, error: detail || `HTTP ${res.status}` };
}

async function fetchCurrentSession(
  base: string,
  token: string,
  companyId: string,
  posId: string,
): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`${base}/companies/${companyId}/pos/${posId}/sessions/current`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const body = await res.json();
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function extractDetail(res: Response): Promise<string> {
  try {
    const body = await res.json();
    return typeof body?.detail === 'string' ? body.detail : JSON.stringify(body);
  } catch {
    return '';
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function processQueue(): Promise<void> {
  if (syncing) return;
  syncing = true;
  emitStatus();
  try {
    const base = new URL(effectiveApiUrl()).origin;
    const token = secureStore.get(TOKEN_KEY);
    if (!token) {
      log.warn('[sync] sem sessão — a aguardar login para sincronizar a fila offline');
      return;
    }

    for (const mutation of offlineStore.listPendingOrFailed()) {
      const dueAt = nextAttemptAt.get(mutation.id) ?? 0;
      if (Date.now() < dueAt) continue;

      const path = resolvePath(mutation);
      if (path === null) continue; // depende de uma mutação ainda não sincronizada; tenta mais tarde

      offlineStore.markSyncing(mutation.id);
      const outcome = await replay(base, token, mutation, path);

      if (outcome.ok) {
        offlineStore.markSynced(mutation.id, outcome.serverId, outcome.result);
        nextAttemptAt.delete(mutation.id);
        log.info(`[sync] ${mutation.kind} ${mutation.localRef} sincronizado`);
        emit({ type: 'mutation-synced', mutation: { ...mutation, status: 'synced', serverId: outcome.serverId, result: outcome.result } });
      } else {
        offlineStore.markFailed(mutation.id, outcome.error ?? 'Erro desconhecido');
        if (outcome.retryable) {
          const backoff = Math.min(MAX_BACKOFF_MS, 2 ** Math.min(mutation.attempts + 1, 6) * 1000);
          nextAttemptAt.set(mutation.id, Date.now() + backoff);
        } else {
          log.warn(`[sync] ${mutation.kind} ${mutation.localRef} falhou (sem retry): ${outcome.error}`);
        }
      }
    }
  } finally {
    syncing = false;
    emitStatus();
  }
}

export function enqueueMutation(input: {
  id: string;
  kind: MutationKind;
  path: string;
  payload: Record<string, unknown>;
  companyId: string;
  posId: string;
  dependsOnLocalId?: string | null;
}): PendingMutation {
  const mutation = offlineStore.enqueue(input);
  emitStatus();
  void processQueue();
  return mutation;
}

export function listMutations(companyId: string): PendingMutation[] {
  return offlineStore.listAll(companyId);
}

export function startSyncEngine(windowGetter: () => BrowserWindow | null): void {
  getWindow = windowGetter;

  const tick = async () => {
    const reachable = await checkConnectivity();
    if (reachable !== online) {
      online = reachable;
      emit({ type: 'connectivity', online });
      log.info(`[sync] conectividade: ${online ? 'online' : 'offline'}`);
    }
    if (online) await processQueue();
    emitStatus();
  };

  void tick();
  setInterval(() => void tick(), HEALTH_CHECK_EVERY_MS).unref();
}
