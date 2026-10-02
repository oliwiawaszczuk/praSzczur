"""Postprocessing segmentacji (operacje na OBRAZIE/masce 2D, nie na widmie —
stad osobny plik od src/msi/preprocessing.py, ktory operuje na widmie
pojedynczego piksela).

Dwie metody, obie wywolywane z nowych wezlow domeny Segmentacja w Node Graph
(patrz docs/node-graph.md):

- `morphological_snakes_refine` — dopasowuje gladki, zamkniety kontur do
  zaszumionej maski (skimage.segmentation.morphological_chan_vese),
  uzywany przez wezel "segmentacja/active_contour".
- `cosine_scores` — liczy dla kazdego piksela tkanki podobienstwo kosinusowe
  do widma referencyjnego "rdzenia" segmentu i widma referencyjnego "tla",
  uzywany przez wezel "segmentacja/spectral_refine" ("Dopasowanie do widm") —
  jedyne miejsce, gdzie postprocessing segmentacji wraca do oryginalnych
  widm zamiast zostac czysto geometryczna operacja na masce 0/1. Erozja
  maski 2D (zeby referencja liczyla sie tylko z "pewnego" rdzenia/tla, nie
  z zaszumionego brzegu) dzieje sie PRZED wywolaniem tej funkcji, w
  main.py, na faktycznej siatce 2D tkanki (ten sam uklad co /ion_image) —
  ta funkcja dostaje juz gotowe, plaskie maski 0/1 wyrownane z wierszami
  `spectra`.
"""

from __future__ import annotations

import numpy as np
from skimage.segmentation import morphological_chan_vese


def morphological_snakes_refine(
    mask: np.ndarray, iterations: int = 20, smoothing: int = 2,
) -> np.ndarray:
    """Dopasowuje aktywny kontur (Chan-Vese, wariant morfologiczny) do binarnej
    maski — energia REGIONALNA (wariancja wewnatrz/na zewnatrz konturu), wiec
    odporna na pojedyncze piksele szumu i dziury w przeciwienstwie do progu
    piksel-po-pikselu. Inicjalizacja = podana maska (kontur "osiada" na
    dominujacym ksztalcie widocznym makroskopowo). Zwraca binarna maske 0/1.
    """
    init = (mask >= 0.5).astype(np.uint8)
    if init.sum() == 0:
        return init
    result = morphological_chan_vese(
        mask.astype(float), num_iter=int(iterations), init_level_set=init, smoothing=int(smoothing),
    )
    return result.astype(np.uint8)


def cosine_scores(spectra: np.ndarray, core_ref: np.ndarray, bg_ref: np.ndarray) -> np.ndarray:
    """Podobienstwo kosinusowe KAZDEGO wiersza `spectra` (N x n_mz) do dwoch
    widm referencyjnych, zwraca `score` w [-1, 1] = podobienstwo do rdzenia
    minus podobienstwo do tla (wyzsze = bardziej "nalezy do segmentu")."""
    def cosine_to(ref: np.ndarray) -> np.ndarray:
        ref_norm = np.linalg.norm(ref)
        if ref_norm <= 0:
            return np.zeros(spectra.shape[0])
        spectra_norm = np.linalg.norm(spectra, axis=1)
        spectra_norm = np.where(spectra_norm > 0, spectra_norm, 1.0)
        return (spectra @ ref) / (spectra_norm * ref_norm)

    return cosine_to(core_ref) - cosine_to(bg_ref)
