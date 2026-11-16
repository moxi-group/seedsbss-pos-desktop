import { contextBridge, ipcRenderer } from 'electron';

import {
  DesktopAppInfo,
  DesktopDrawerOptions,
  DesktopPrintHtmlOptions,
  DesktopPrinter,
  DesktopUpdateStatus,
  IPC,
  SeedsDesktopBridge,
} from './shared/bridge';

/** O Electron embrulha os erros do processo principal em
 * "Error invoking remote method 'x': Error: ..." — o operador só precisa
 * da mensagem final. */
async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  try {
    return (await ipcRenderer.invoke(channel, ...args)) as T;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(message.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, ''));
  }
}

/**
 * Única superfície que o renderer (Angular) vê do sistema. Nada de Node
 * nem de ipcRenderer directo: só estas funções, com argumentos simples.
 */
const bridge: SeedsDesktopBridge = {
  isDesktop: true,

  // Síncrono de propósito: o TokenStorageService do client é síncrono.
  store: {
    getItem: (key: string) => ipcRenderer.sendSync(IPC.storeGet, String(key)) as string | null,
    setItem: (key: string, value: string) => {
      ipcRenderer.sendSync(IPC.storeSet, String(key), String(value));
    },
    removeItem: (key: string) => {
      ipcRenderer.sendSync(IPC.storeRemove, String(key));
    },
  },

  apiUrlOverride: () => ipcRenderer.sendSync(IPC.apiOverride) as string | null,
  appInfo: () => call<DesktopAppInfo>(IPC.appInfo),

  listPrinters: () => call<DesktopPrinter[]>(IPC.listPrinters),
  printHtml: (html: string, options: DesktopPrintHtmlOptions) =>
    call<void>(IPC.printHtml, String(html), {
      printer: options?.printer ?? null,
      paperWidth: options?.paperWidth === '58mm' ? '58mm' : '80mm',
    }),
  openPdf: (data: ArrayBuffer, title: string) => call<void>(IPC.openPdf, data, String(title ?? '')),
  openCashDrawer: (options: DesktopDrawerOptions) =>
    call<void>(IPC.openDrawer, { printer: options?.printer ?? null }),

  checkForUpdates: () => call<void>(IPC.updateCheck),
  installUpdateAndRestart: () => call<void>(IPC.updateInstall),
  onUpdateStatus: (callback: (status: DesktopUpdateStatus) => void) => {
    const listener = (_event: unknown, status: DesktopUpdateStatus) => callback(status);
    ipcRenderer.on(IPC.updateStatus, listener);
    return () => {
      ipcRenderer.removeListener(IPC.updateStatus, listener);
    };
  },

  setKioskMode: (enabled: boolean) => call<void>(IPC.kiosk, !!enabled),
};

contextBridge.exposeInMainWorld('seedsDesktop', bridge);
