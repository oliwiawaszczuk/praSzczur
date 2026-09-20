"""Loader for imzML/ibd MALDI-MSI datasets."""

from pathlib import Path
from typing import NamedTuple

import numpy as np
from pyimzml.ImzMLParser import ImzMLParser


DATA_DIR = Path(__file__).parents[2] / "source"
DEFAULT_FILE = DATA_DIR / "FMP10_Rat_brain_breg_084.imzML"


class DatasetMeta(NamedTuple):
    n_spectra: int
    x_range: tuple[int, int]
    y_range: tuple[int, int]
    mz_len: int
    mz_min: float
    mz_max: float


def open_parser(path: Path = DEFAULT_FILE) -> ImzMLParser:
    return ImzMLParser(str(path))


def get_metadata(p: ImzMLParser) -> DatasetMeta:
    coords = np.array(p.coordinates)
    xs, ys = coords[:, 0], coords[:, 1]
    mz, _ = p.getspectrum(0)
    return DatasetMeta(
        n_spectra=len(p.coordinates),
        x_range=(int(xs.min()), int(xs.max())),
        y_range=(int(ys.min()), int(ys.max())),
        mz_len=len(mz),
        mz_min=float(mz.min()),
        mz_max=float(mz.max()),
    )


def get_ion_image(p: ImzMLParser, target_mz: float, tol: float = 0.1) -> np.ndarray:
    """Return 2-D ion image (intensity at target_mz ± tol) as float32 array."""
    coords = np.array(p.coordinates)
    x_max = coords[:, 0].max()
    y_max = coords[:, 1].max()
    img = np.zeros((y_max, x_max), dtype=np.float32)
    for i, (x, y, *_) in enumerate(p.coordinates):
        mz, intensities = p.getspectrum(i)
        mask = np.abs(mz - target_mz) <= tol
        img[y - 1, x - 1] = intensities[mask].sum()
    return img
