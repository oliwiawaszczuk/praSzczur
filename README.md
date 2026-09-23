# praSzczur

Desktop application for interactive MALDI-MSI data exploration and preprocessing.  
Built with **Tauri v2** (Rust) + **SvelteKit** (frontend) + **Python FastAPI** sidecar.

---

## What it does

- Load any `.imzML` / `.ibd` file pair and inspect the full-resolution spectrum
- Explore the effect of bin size on spectral resolution with a live bin-preview window
- Detect tissue regions automatically from pixel coordinates
- Preprocess data (bin spectra by tissue, save as `.npz`) directly from the UI, with a choice of
  binning aggregation: sum, mean, or peak apex (max intensity in the bin window, per pixel)
- Query ion images by m/z ± tolerance — either from the preprocessed/binned data, or directly
  from the raw imzML file (bypassing binning)
- Inspect individual pixel spectra (binned or raw) on a Plotly chart, with bin markers overlaid
- Multiple **workspaces**: each is an independent project (its own imzML file, preprocessed
  data, and UI settings), switchable/exportable/importable from the Ustawienia (Settings) tab

---

## Download (release builds)

Go to [Releases](../../releases) and download the build for your platform:

| Platform | File |
|---|---|
| macOS (Apple Silicon) | `praSzczur_*.dmg` |
| Windows | `praSzczur_*_x64-setup.exe` |
| Linux | `praSzczur_*.AppImage` |

> **macOS**: the app is not code-signed. On first open: right-click → Open → Open anyway.  
> **Windows**: SmartScreen may warn. Click "More info" → "Run anyway".  
> **Linux**: `chmod +x praSzczur_*.AppImage && ./praSzczur_*.AppImage`

---

## Data requirements

The app does **not** include any dataset. You need:

- A MALDI-MSI dataset in `imzML` format (continuous mode tested)
- The matching `.ibd` binary file in the same directory

Tested with: `FMP10_Rat_brain_breg_084.imzML` (MALDI-TOF, 16 341 spectra, m/z 300–1500 Da, 35 700 points/spectrum).

---

## Workflow

1. **Dane tab** — select your `.imzML` file via the file picker
2. Inspect the mean spectrum, adjust the m/z range
3. Set **bin size** and binning aggregation (sum / mean / peak apex), check the bin preview to
   verify spectral resolution
4. Confirm tissue ROIs (auto-detected or manual bounds)
5. Click **Przetwórz** to bin and save preprocessed data
6. **m/z tab** — query ion images by m/z value (binned, or "Oryginalne m/z" for raw-from-imzML)
7. **Widma tab** — click pixels on a tissue map to inspect their spectra (binned or raw)

---

## Development (macOS only, local)

Requirements:
- [Rust](https://rustup.rs/) stable
- [Node.js](https://nodejs.org/) 20+, [pnpm](https://pnpm.io/)
- [uv](https://github.com/astral-sh/uv) — Python package manager (`brew install uv`)
- Xcode Command Line Tools (`xcode-select --install`)

```bash
# Install Python dependencies
uv sync

# Run in dev mode (hot reload)
cd app
pnpm install
pnpm tauri dev
```

The Python sidecar starts automatically on port 7432.  
`PRASZCZUR_ROOT` is resolved at compile time from the repository root — put your source data at
`source/`. Preprocessed data lives per-workspace under `workspaces/<id>/processed/`
(see [`app/README.md`](app/README.md) for the workspace concept).

### Build release (macOS)

```bash
cd app
pnpm tauri build
```

The `.app` bundle ends up in `app/src-tauri/target/release/bundle/macos/`.

---

## Architecture

```
praSzczur/
├── app/
│   ├── src/                  # SvelteKit frontend (Svelte 5, runes)
│   │   ├── lib/
│   │   │   ├── DaneTab.svelte      # Data tab: load file, detect tissue, bin size + preview
│   │   │   ├── IonGrid.svelte      # Ion image grid (m/z tab)
│   │   │   ├── Sidebar.svelte      # m/z query sidebar
│   │   │   ├── Widma.svelte        # Spectrum tab: pixel picker + Plotly chart
│   │   │   ├── WorkspaceSettings.svelte  # Workspace CRUD (Ustawienia tab)
│   │   │   ├── workspace.svelte.ts # Central per-workspace settings store (wsGet/wsSet)
│   │   │   └── colormap.ts         # Bruker-style LUT, shared m/z ↔ Widma
│   │   └── routes/+page.svelte     # App shell + tab routing
│   ├── sidecar/
│   │   └── main.py           # FastAPI backend (port 7432)
│   └── src-tauri/
│       └── src/lib.rs        # Rust: sidecar lifecycle management
├── src/msi/                  # Python analysis library
│   ├── loader.py             # imzML → numpy helpers
│   └── constants.py          # Dataset-specific bounds / parameters
├── scripts/                  # One-off analysis scripts
├── workspaces/                # Per-workspace preprocessed data + UI settings (gitignored)
└── source/                   # Raw imzML + ibd files (gitignored)
```

The Rust binary spawns the Python FastAPI server on startup and kills it on exit.  
All heavy computation (spectrum loading, binning, ion image extraction) runs in Python.  
The frontend communicates with the sidecar over HTTP (`localhost:7432`).

---

## CI / Release

Pushing a tag `v*.*.*` triggers GitHub Actions to build for all three platforms.  
The workflow uses [PyInstaller](https://pyinstaller.org/) to package the Python sidecar into a self-contained binary — no Python installation required on end-user machines.

```bash
# Create and push a release tag
git tag v0.2.0
git push origin v0.2.0
```

See [`.github/workflows/release.yml`](.github/workflows/release.yml) for details.
