# Windows packaging

The installer is built with **electron-builder** (NSIS, x64) from `apps/desktop`.

```powershell
# On Windows 10/11 with Node.js 22
npm ci
npm run dist -w @store/desktop
# → apps/desktop/release/StoreManager-Setup-<version>.exe
```

`npm run dist` runs `electron-vite build` (main, preload and renderer bundles in
`apps/desktop/out/`) and `electron-builder --win --x64`. SQLite access uses
`better-sqlite3`, which ships Node-API prebuilt binaries for Windows, macOS and Linux
(x64/arm64); they are ABI-stable, so nothing is compiled for the Electron version and no
Visual Studio Build Tools are required. The `.node` binary is kept outside the asar
archive (`asarUnpack`).

The GitHub Actions workflow `.github/workflows/ci.yml` builds the installer on
`windows-latest` for tags `v*` and manual runs, and uploads it as an artifact.

## Electron version policy

Electron ships inside the installer, so it is part of the product's security surface.
Electron supports only the latest three major versions: keep `electron` (pinned exactly
in `apps/desktop/package.json`, currently 44.x) on a supported major and take patch
releases promptly. From Electron 44 the binary is no longer downloaded by
`npm install`; `npm run desktop:dev` and `npm run test:ui` call `install-electron`
first (electron-builder downloads its own copy when packaging).

## Installer behaviour (`apps/desktop/electron-builder.yml`)

* Per-user install by default (no admin rights needed); the user may choose the folder.
* Desktop and Start-menu shortcuts "Store Manager".
* Business data is **not** in the installation folder: it lives in
  `%LOCALAPPDATA%\StoreCo\StoreManager` and is kept on uninstall and upgrade.
* Only one instance runs at a time (a second launch focuses the existing window).

## Code signing

Unsigned installers trigger SmartScreen warnings. Provide a code-signing certificate
via environment variables before `npm run dist`:

```powershell
$env:CSC_LINK = "C:\certs\storeco.pfx"     # or a base64 string
$env:CSC_KEY_PASSWORD = "..."
```

(For EV certificates on hardware tokens, use electron-builder's `win.signtoolOptions`
or Azure Trusted Signing.)

## Branding

Put `icon.ico` (256×256) in `apps/desktop/build/` and set `productName` / `appId` in
`electron-builder.yml`. To change the data folder name, edit `COMPANY_DIR` / `APP_DIR`
in `apps/desktop/electron/main.ts` (do this before the first production install).

## Upgrades

Install the new version over the old one. On first start the app:

1. takes a `pre-migrate` backup of `store.db` if the local schema changes,
2. applies pending SQLite migrations,
3. resumes synchronising from where it stopped (pending transactions are kept).

Upgrade the central server before the desktops whenever a release changes the sync
event format or the API.

## Local development

```bash
npm run desktop:dev        # Vite + Electron with reload
npm run dist:dir -w @store/desktop   # unpacked build for the current OS (quick packaging check)
```
