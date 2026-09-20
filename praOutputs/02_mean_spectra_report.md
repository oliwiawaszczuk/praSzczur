# Raport: Średnie widma MALDI-TOF per tkanka

**Dane**: FMP10 Rat Brain, bregma 0.84 | BIN_SIZE = 0.3 Da | zakres 300–1500 Da (4000 binów)

## Obrazy

- `02a_mean_spectra_overlay.png` — nałożone widma wszystkich 4 tkanek
- `02b_mean_spectra_panels.png` — osobne panele ± odchylenie standardowe
- `02c_mean_spectra_zoom.png` — zoom na trzy zakresy biologiczne

---

## Obserwacje

### 1. Ogólna struktura widm

Wszystkie cztery tkanki wykazują **bardzo zbliżony profil widmowy** — dominanty powtarzają się w tych samych pozycjach m/z. Sygnał koncentruje się w zakresie 300–800 Da, powyżej 900 Da intensywności gwałtownie maleją. To typowy obraz dla MALDI-TOF mózgu w trybie pozytywnym z matrycą DHB lub CHCA — dominują lipidy i małe cząsteczki.

### 2. Dominujące piki (top-5 per tkanka)

| m/z [Da] | T1_ref | T2 | T3 | T4 | Prawdopodobna klasa |
|----------|--------|----|----|----|--------------------|
| 310.95 | **225.5** | **231.7** | **207.2** | **205.2** | Fragment lipidowy / matryca |
| 569.25 | 148.5 | 152.3 | 135.9 | 124.2 | Fosfolipid (np. LPC lub DAG) |
| 424.05 | 104.7 | 110.1 | 97.9 | 98.0 | Lipid / ceramid |
| 523.35 | — | 97.9 | 104.5 | 93.0 | Fosfolipid |
| 312.15 | 101.6 | 106.7 | 94.5 | 92.8 | Izotop/fragment 310.95 |

### 3. Różnice między tkankami

- **T1_ref i T2** mają nieznacznie wyższe intensywności bezwzględne niż T3 i T4 — może odzwierciedlać większą gęstość tkanki lub różnice w ilości nałożonej matrycy (efekt preparatyki).
- **T3 i T4** wykazują relatywnie większy udział piku 523.35 Da w stosunku do 424.05 Da — subtelna różnica w profilu lipidowym.
- Powyżej **900 Da** widma są praktycznie płaskie — dla analiz wyższych mas (gangliozydy, sfingomieliny) zakres może być za niski lub sygnał zbyt słaby.

### 4. Wysoka wariancja wewnątrztankowa (SD)

Pasy ±SD (wykres 02b) są szerokie relative do sygnału średniego — szczególnie w zakresie 300–500 Da. Wskazuje to na **dużą heterogeniczność przestrzenną** wewnątrz każdej tkanki (co jest oczekiwane — różne regiony anatomiczne mózgu mają różne profile lipidowe). To uzasadnia konieczność analiz przestrzennych (ion images, clustering).

---

## Rekomendacje dla kolejnych kroków

1. **Normalizacja**: przed porównaniem tkanek konieczna normalizacja TIC (lub median) — różnice intensywności bezwzględnych mogą być artefaktem preparatyki.
2. **Peak picking**: zamiast porównania wszystkich 4000 binów — identyfikacja istotnych pików (SNR > próg) zredukuje wymiarowość i szum.
3. **Ion images**: wizualizacja rozkładu przestrzennego kluczowych m/z (szczególnie 569.25 i 523.35 Da) ujawni, czy różnice między tkankami są jednorodne czy lokalne.
4. **PCA/UMAP**: redukcja wymiarowości na zbinnowanych widmach pokaże, czy tkanka referencyjna (T1) grupuje się oddzielnie od badanych.
