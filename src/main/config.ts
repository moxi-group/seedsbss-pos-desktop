import { app } from 'electron';
import path from 'node:path';

/** API por omissão — tem de bater com environment.desktop.ts do client. */
export const DEFAULT_API_URL = 'https://api.seeds.ao/api/v1';

/** Esquema e host internos onde o Angular é servido (app://pos/...). A API
 * tem de aceitar esta origem no CORS (CORS_ORIGINS=...,app://pos). */
export const APP_SCHEME = 'app';
export const APP_HOST = 'pos';
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;

function argValue(name: string): string | null {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

/** Override da API: `--api-url=https://staging...` ou SEEDS_API_URL. */
export function apiUrlOverride(): string | null {
  const value = argValue('api-url') ?? process.env['SEEDS_API_URL'] ?? null;
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return value.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

export function effectiveApiUrl(): string {
  return apiUrlOverride() ?? DEFAULT_API_URL;
}

/** Em desenvolvimento pode-se apontar para o `ng serve` do client
 * (SEEDS_RENDERER_URL=http://localhost:4300) em vez da pasta renderer/. */
export function devRendererUrl(): string | null {
  if (app.isPackaged) return null;
  return process.env['SEEDS_RENDERER_URL'] ?? null;
}

/** Pasta com o build Angular (copiada por scripts/build-renderer.mjs). */
export function rendererDir(): string {
  return path.join(app.getAppPath(), 'renderer');
}

export function debugEnabled(): boolean {
  return !app.isPackaged || process.env['SEEDS_DEBUG'] === '1' || process.argv.includes('--debug');
}
