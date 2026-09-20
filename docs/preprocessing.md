# Preprocessing

## Uruchomienie

```bash
uv run python scripts/01_preprocess.py
```

Wymagane przy zmianie `BIN_SIZE` lub `TISSUE_BOUNDS` w `src/msi/constants.py`.

## Binning m/z

- **BIN_SIZE** = 0.3 Da (zmienna w `constants.py`)
- Zakres: 300–1500 Da → **4000 binów**
- Metoda: suma intensywności punktów w oknie [centrum − 0.15, centrum + 0.15] Da
- Punkty w przedziale między tkankami są odrzucane

## Segmentacja tkanek

Granice na osi X (1-indexed, potwierdzone wizualnie z TIC):

| ID | Rola | x_min | x_max | n_spektrów |
|----|------|-------|-------|-----------|
| T1_ref | referencyjna | 35 | 107 | 4037 |
| T2 | badana | 156 | 208 | 4006 |
| T3 | badana | 296 | 348 | 4242 |
| T4 | badana | 402 | 457 | 4053 |

## Format wyjściowy

`data/processed/<tissue>.npz`:
- `spectra`  : float32 `(n_spektrów, 4000)` — zbinnowane intensywności
- `coords`   : int16 `(n_spektrów, 2)` — (x, y) w układzie oryginalnym
- `mz_bins`  : float64 `(4000,)` — centra binów [Da]
