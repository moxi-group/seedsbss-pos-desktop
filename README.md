# SeedsBSS POS (Windows)

App desktop do ponto de venda do SeedsBSS. É uma shell **Electron** à volta do
ecrã de venda que já existe no `seedsbss-client` (Angular): os ecrãs, os
serviços e as regras fiscais são os mesmos do web. Este repo só acrescenta o que
o browser não faz bem no balcão:

- impressão **silenciosa** do talão térmico (80/58 mm), sem diálogo;
- abertura da **gaveta** (comando ESC/POS pela impressora de talões);
- leitor de **código de barras** (USB em modo teclado) e atalhos F2/F8/F9/Esc;
- token guardado **cifrado** (safeStorage/DPAPI) em vez de `localStorage`;
- terminal ligado a um POS: o operador seguinte só tem de entrar;
- instalador **NSIS** e **actualizações automáticas** (instalam ao fechar a app).

A venda continua a ser feita online pela API (numeração, hash e assinatura AGT
ficam no servidor). Não há modo offline nesta versão.

## Como usa o client

O Angular não é copiado para aqui: `npm run build:renderer` corre o build
`desktop` do `seedsbss-client` e copia o resultado para `renderer/`.

```
seeds-bss/
  seedsbss-client/          # Angular (web + build desktop)
  seedsbss-pos-desktop/     # este repo
```

`CLIENT_DIR` muda a pasta do client (omissão: `../seedsbss-client`).

No client, a parte desktop está em:

| Ficheiro | O quê |
| --- | --- |
| `src/main.desktop.ts`, `src/index.desktop.html`, `tsconfig.desktop.json` | Entrada do build desktop |
| `src/app/desktop/` | Rotas, moldura, primeiro arranque (escolher POS) e definições do terminal |
| `src/app/core/platform/desktop-bridge.ts` | Contrato com o preload (igual a `src/shared/bridge.ts` daqui) |
| `src/app/core/platform/terminal-config.service.ts` | POS do terminal, impressora, gaveta, modo balcão |
| `src/app/core/platform/pdf-viewer.service.ts` | Abre PDFs (pop-up no web, janela da app no desktop) |
| `angular.json` → configurações `desktop` e `desktop-development` | |

No browser nada muda: sem `window.seedsDesktop`, o client comporta-se como antes.

## Desenvolvimento

Requisitos: Node 22.12+.

```bash
npm install

# 1) Com o build do client (como em produção):
npm run build:renderer
SEEDS_API_URL=http://127.0.0.1:8000/api/v1 npm start

# 2) Com hot-reload do Angular:
#    no client:  npm run start:desktop     (ng serve na porta 4300)
#    aqui:       npm run dev               (API em 127.0.0.1:8000)
```

F12 abre as DevTools fora da app instalada (ou com `--debug` / `SEEDS_DEBUG=1`).

Parâmetros úteis:

| | |
| --- | --- |
| `--api-url=...` ou `SEEDS_API_URL` | Usar outra API (ex.: staging) |
| `SEEDS_RENDERER_URL` | Carregar o renderer de um `ng serve` (só em desenvolvimento) |
| `SEEDS_DEBUG=1` / `--debug` | DevTools na app instalada |

Logs: `%APPDATA%\SeedsBSS POS\logs\main.log`.

## API: CORS

O Angular é servido em `app://pos`. A API tem de aceitar essa origem:

```
CORS_ORIGINS=https://bss.sementes.ao,app://pos
```

## Instalador e actualizações

```bash
npm run dist        # release/SeedsBSS-POS-Setup-<versão>.exe + latest.yml
```

Em Windows corre directamente. Em macOS/Linux o último passo precisa de Wine,
por isso o normal é usar o workflow `.github/workflows/build-windows.yml`
(tag `vX.Y.Z` ou manual). O workflow precisa de:

| Onde | Nome | Para quê |
| --- | --- | --- |
| Secret | `CLIENT_REPO_TOKEN` | Ler o `moxi-group/seedsbss-client` (privado) |
| Secret | `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD` | Assinatura de código (.pfx em base64) |
| Variable | `SEEDS_UPDATE_URL` | URL pública do feed de actualizações |

Para as actualizações chegarem aos clientes, publicar `latest.yml`, o `.exe` e
o `.blockmap` em `SEEDS_UPDATE_URL`. A app procura actualizações ao arrancar e a
cada 6 horas, descarrega em segundo plano e instala ao fechar (ou quando o
operador carrega em "Reiniciar e instalar").

Para lançar uma versão: subir `version` no `package.json`, criar a tag `vX.Y.Z`.

## Hardware

- **Impressora de talões:** qualquer impressora instalada no Windows. Escolhe-se
  em *Terminal → Impressora de talões* (botão *Testar*).
- **Gaveta:** ligada à impressora (RJ11). O comando é `ESC p 0 25 250`, enviado
  em RAW pelo spooler do Windows. Por omissão abre em vendas pagas em
  numerário; as formas de pagamento escolhem-se nas definições.
- **Leitor de código de barras:** USB em modo teclado, com Enter no fim. O
  produto com esse código entra logo no carrinho.

## Segurança

`contextIsolation`, `sandbox` e sem `nodeIntegration`. O renderer só vê
`window.seedsDesktop` (ver `src/preload.ts`), e o IPC só aceita pedidos da
janela principal carregada de `app://pos`. Há CSP sem scripts inline, não se
navega para fora da app e os links externos abrem no browser do sistema.
