# BIN_SIZE: szerokość koszyczka m/z w Daltonach.
# Punkty m/z w odległości <= BIN_SIZE/2 od centrum binu są sumowane.
# Zmiana tego parametru wymaga ponownego uruchomienia scripts/01_preprocess.py.
BIN_SIZE: float = 0.3  # Da

# Zakres m/z danych (wyznaczony empirycznie z pliku imzML)
MZ_MIN: float = 300.0  # Da
MZ_MAX: float = 1500.0  # Da

# Granice tkanek na osi X (1-indexed, włącznie), potwierdzone wizualnie
# Tkanka 1 = referencyjna (skrajnie lewa)
TISSUE_BOUNDS: dict[str, tuple[int, int]] = {
    "T1_ref": (35, 107),
    "T2":     (156, 208),
    "T3":     (296, 348),
    "T4":     (402, 457),
}
