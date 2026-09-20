# PyInstaller spec for the praSzczur FastAPI sidecar.
# Run from the project ROOT (not from app/sidecar/):
#   pyinstaller app/sidecar/sidecar.spec
#
# The spec bundles src/msi/ so the compiled binary works without a Python
# environment on end-user machines.

import sys
from pathlib import Path

project_root = Path(SPECPATH).parents[1]  # app/sidecar/ → app/ → praSzczur/

a = Analysis(
    [str(project_root / "app" / "sidecar" / "main.py")],
    pathex=[str(project_root)],
    binaries=[],
    datas=[],
    hiddenimports=[
        "src.msi",
        "src.msi.loader",
        "src.msi.constants",
        "pyimzml",
        "pyimzml.ImzMLParser",
        "fastapi",
        "uvicorn",
        "uvicorn.logging",
        "uvicorn.loops",
        "uvicorn.loops.auto",
        "uvicorn.protocols",
        "uvicorn.protocols.http",
        "uvicorn.protocols.http.auto",
        "uvicorn.lifespan",
        "uvicorn.lifespan.on",
        "anyio",
        "anyio._backends._asyncio",
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        "matplotlib", "jupyter", "ipykernel", "seaborn", "pandas",
        "scikit-learn", "sklearn", "scipy",
    ],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="sidecar",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
