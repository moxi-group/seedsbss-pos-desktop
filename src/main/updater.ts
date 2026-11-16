import { BrowserWindow, app } from 'electron';
import { autoUpdater } from 'electron-updater';

import { DesktopUpdateStatus, IPC } from '../shared/bridge';
import { log } from './logger';

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

let lastStatus: DesktopUpdateStatus = { state: 'idle' };
let getWindow: () => BrowserWindow | null = () => null;

function emit(status: DesktopUpdateStatus): void {
  lastStatus = status;
  const win = getWindow();
  if (win && !win.isDestroyed()) win.webContents.send(IPC.updateStatus, status);
}

/**
 * Actualizações automáticas (electron-updater, feed "generic" definido no
 * electron-builder.config.js). Descarrega em segundo plano e instala ao
 * fechar a app — nunca reinicia sozinha a meio de uma venda; o operador
 * pode forçar com "Reiniciar e instalar".
 */
export function setupAutoUpdates(windowGetter: () => BrowserWindow | null): void {
  getWindow = windowGetter;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = {
    info: (m: unknown) => log.info(`[updater] ${String(m)}`),
    warn: (m: unknown) => log.warn(`[updater] ${String(m)}`),
    error: (m: unknown) => log.error(`[updater] ${String(m)}`),
    debug: () => undefined,
  };

  autoUpdater.on('checking-for-update', () => emit({ state: 'checking' }));
  autoUpdater.on('update-available', (info) => emit({ state: 'available', version: info.version }));
  autoUpdater.on('update-not-available', () => emit({ state: 'not-available' }));
  autoUpdater.on('download-progress', (p) => emit({ state: 'downloading', percent: p.percent }));
  autoUpdater.on('update-downloaded', (info) => emit({ state: 'downloaded', version: info.version }));
  autoUpdater.on('error', (err) => emit({ state: 'error', message: err?.message ?? String(err) }));

  if (!app.isPackaged) {
    log.info('[updater] desactivado fora da app instalada');
    return;
  }
  void checkForUpdates();
  setInterval(() => void checkForUpdates(), CHECK_EVERY_MS).unref();
}

export async function checkForUpdates(): Promise<void> {
  if (!app.isPackaged) {
    emit({ state: 'error', message: 'Actualizações só funcionam na app instalada.' });
    return;
  }
  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    emit({ state: 'error', message: err instanceof Error ? err.message : String(err) });
  }
}

export function installAndRestart(): void {
  if (lastStatus.state !== 'downloaded') return;
  autoUpdater.quitAndInstall(false, true);
}

export function currentUpdateStatus(): DesktopUpdateStatus {
  return lastStatus;
}
