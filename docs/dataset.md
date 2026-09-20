# Dataset — FMP10 Rat Brain (bregma 084)

## Parametry akwizycji

| Parametr | Wartość |
|---|---|
| Instrument | Bruker MALDI-TOF (flex series) |
| Jonizacja | MALDI |
| Tryb | continuous (wspólna oś m/z dla wszystkich pikseli) |
| Piksel | ~150 µm |
| Wymiary obrazu | 457 × 139 pikseli |
| Obszar | 68 550 × 20 850 µm |
| Liczba spektrów | 16 341 |
| Zakres m/z | 300 – 1500 Da |
| Punkty m/z | 35 700 |
| Format danych | 64-bit float, brak kompresji |
| Kodowanie | external binary (.ibd) |

## Uwagi

- Współrzędne pikseli: x ∈ [35, 457], y ∈ [35, 139] — offset od (35,35), obraz nie wypełnia całej siatki.
- Ostrzeżenia pyimzML przy ładowaniu są kosmetyczne (niezgodność nazw w ontologii IMS/MS).
- Skan meandryczny (meandering), kierunek: top-down, linia prawa→lewa.
