/**
 * Contrato da ponte renderer <-> processo principal.
 *
 * A forma de `SeedsDesktopBridge` TEM de ser igual à de
 * `seedsbss-client/src/app/core/platform/desktop-bridge.ts` — é esse
 * ficheiro que o Angular usa. Ao mudar um lado, mudar o outro.
 */
export type ReceiptPaperWidth = '80mm' | '58mm';

export interface DesktopPrinter {
  name: string;
  displayName: string;
  isDefault: boolean;
}

export interface DesktopPrintHtmlOptions {
  printer?: string | null;
  paperWidth: ReceiptPaperWidth;
}

export interface DesktopDrawerOptions {
  printer?: string | null;
}

export interface DesktopAppInfo {
  version: string;
  platform: string;
  apiUrl: string | null;
}

export type DesktopUpdateStatus =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'available'; version: string }
  | { state: 'not-available' }
  | { state: 'downloading'; percent: number }
  | { state: 'downloaded'; version: string }
  | { state: 'error'; message: string };

export interface DesktopSecureStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface SeedsDesktopBridge {
  readonly isDesktop: true;
  readonly store: DesktopSecureStore;
  appInfo(): Promise<DesktopAppInfo>;
  apiUrlOverride(): string | null;
  listPrinters(): Promise<DesktopPrinter[]>;
  printHtml(html: string, options: DesktopPrintHtmlOptions): Promise<void>;
  openPdf(data: ArrayBuffer, title: string): Promise<void>;
  openCashDrawer(options: DesktopDrawerOptions): Promise<void>;
  checkForUpdates(): Promise<void>;
  installUpdateAndRestart(): Promise<void>;
  onUpdateStatus(callback: (status: DesktopUpdateStatus) => void): () => void;
  setKioskMode(enabled: boolean): Promise<void>;
}

/** Canais IPC. O preload é empacotado (esbuild) com este ficheiro, por isso
 * pode importar daqui mesmo correndo em sandbox. */
export const IPC = {
  storeGet: 'store:get',
  storeSet: 'store:set',
  storeRemove: 'store:remove',
  apiOverride: 'app:api-override',
  appInfo: 'app:info',
  listPrinters: 'printer:list',
  printHtml: 'printer:print-html',
  openPdf: 'pdf:open',
  openDrawer: 'drawer:open',
  updateCheck: 'update:check',
  updateInstall: 'update:install',
  updateStatus: 'update:status',
  kiosk: 'window:kiosk',
} as const;

/** Chave onde o Angular guarda a configuração do terminal (ver
 * TerminalConfigService no client) — o processo principal lê-a no
 * arranque para aplicar o modo balcão antes de mostrar a janela. */
export const TERMINAL_CONFIG_KEY = 'sb_terminal_config';
