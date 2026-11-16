import { app, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

import { log } from './logger';

/**
 * Armazenamento chave/valor do renderer (token JWT, utilizador, acesso
 * activo, configuração do terminal). Cada valor é cifrado com safeStorage
 * (DPAPI no Windows, ligado à conta do Windows) e o ficheiro fica em
 * userData. Leitura/escrita síncronas porque o TokenStorageService do
 * client é síncrono.
 */
type StoreFile = Record<string, string>; // chave -> base64 (cifrado) ou "plain:" + valor

let cache: StoreFile | null = null;

function filePath(): string {
  return path.join(app.getPath('userData'), 'secure-store.json');
}

function load(): StoreFile {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(filePath(), 'utf8')) as StoreFile;
  } catch {
    cache = {};
  }
  return cache;
}

function persist(): void {
  const target = filePath();
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cache ?? {}), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, target);
}

function encrypt(value: string): string {
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.encryptString(value).toString('base64');
  }
  // Só acontece em Linux sem keyring (desenvolvimento); no Windows a DPAPI
  // está sempre disponível.
  log.warn('safeStorage indisponível — valor guardado sem cifra');
  return `plain:${value}`;
}

function decrypt(stored: string): string | null {
  try {
    if (stored.startsWith('plain:')) return stored.slice('plain:'.length);
    return safeStorage.decryptString(Buffer.from(stored, 'base64'));
  } catch (err) {
    // Ex.: ficheiro copiado de outro PC/conta — a DPAPI não o abre.
    log.warn('Não foi possível decifrar um valor do store; a ignorar', err);
    return null;
  }
}

export const secureStore = {
  get(key: string): string | null {
    const stored = load()[key];
    return stored === undefined ? null : decrypt(stored);
  },
  set(key: string, value: string): void {
    load()[key] = encrypt(value);
    persist();
  },
  remove(key: string): void {
    const data = load();
    if (key in data) {
      delete data[key];
      persist();
    }
  },
};
