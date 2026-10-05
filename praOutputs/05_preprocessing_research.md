# Raport: preprocessing widm MALDI-TOF (FMP10) — co działa, a co nie

**Skrypty**: `scripts/05_preproc_benchmark.py` (test półsyntetyczny), `scripts/06_real_data_validation.py` (dane rzeczywiste).
**Próbka**: 300 losowych SUROWYCH widm (35 700 pkt, krok 0,0336 Da), cache w `data/interim/raw_sample.npz`.
**Obrazy**: `05a`–`05c`, `06a`, `06b`.

## 1. Co pokazują same dane (ważniejsze niż wybór algorytmu)

| Fakt | Wartość | Konsekwencja |
|---|---|---|
| Offset detektora | mediana ≈ 0,75 (>1000 Da) – 1,0 (300–500 Da), nie 0 | Surowy TIC to w ~**87% offset**, nie sygnał. Normalizować dopiero PO korekcji tła. |
| Szum biały σ | 0,053 (300–600 Da) → 0,027 (>1000 Da) | Szum zależy od m/z — próg SNR musi być **lokalny**, nie globalny. |
| Autokorelacja szumu (lag 1) | 0,5–0,64 (<1000 Da), 0,16 (>1000) | Szum nie jest biały, wygładzanie daje mniej, niż sugeruje teoria. |
| Szum nie jest Poissonowski | var/mean ≈ 0,004 w tle | Transformacje stabilizujące wariancję (Anscombe, sqrt) nie mają tu uzasadnienia. |
| FWHM piku | 0,088 Da (300–450) → 0,16 Da (800–1100); ≈ 2,6 → 4,8 pkt | Szerokość rośnie z m/z (R ≈ 4–6 tys.). Okno wygładzania musi być dopasowane do piku. |
| Rozdzielczość binningu 0,3 Da | pik 0,09 Da mieści się w ~1 binie | Wszystko, co robimy PO binningu, działa na pojedynczych punktach na pik. |
| „Pusty” region 900–1500 Da | zawiera realne piki/spike'i (do 16,7 a.u. przy σ=0,03) | Do estymacji szumu używać MAD (odpornego), nie SD. |

## 2. Test półsyntetyczny (05a): wstrzyknięte piki w realne tło

Piki Gaussa FWHM 0,08 Da, losowe pozycje, amplituda 1,5–10 σ. Próg każdej metody skalibrowany na widmach bez pików na 0,5 FP/100 Da. Czułość (TPR) przy amplitudzie 6σ:

| Metoda | TPR@6σ | Uwagi |
|---|---|---|
| Gauss σ=1 pkt (filtr dopasowany) | 0,94 | najlepsza, razem z STFT / MA3 / SG 7/2 |
| STFT (moc w paśmie pików) | 0,94 | = filtr pasmowy, matematycznie to samo co filtr dopasowany |
| SG 7/2, MA 3 | 0,92–0,94 | |
| CWT Ricker (szer. 1–4 pkt) | 0,87 | nieco gorsza od Gaussa |
| bez wygładzania | 0,83 | |
| MA 5 → kwadrat, MA 5 | 0,78 | kwadrat **nie zmienia rankingu** (monotoniczny) |
| Tompkins (pochodna² → okno 5) | 0,64 | gorszy niż brak filtra |
| **SG 15/3 (domyślne w appce)** | **0,53** | najgorsza; zachowuje tylko 37% wysokości piku |

**Binning 0,3 Da** (prawy panel): suma w binie obniża czułość z 0,83 do 0,53 (@6σ), a SG 15/3 po binningu praktycznie zabija piki (retencja wysokości 16%, TPR 0,02). **Binning przez MAX (`peak_apex`) zachowuje czułość surowych danych (0,87)**.

## 3. Walidacja na danych rzeczywistych (06a, 06b) — „od dużych pików do małych”

Piki referencyjne ze średniego widma 300 pikseli, podzielone wg siły względem szumu pojedynczego piksela: 360 silnych, 330 średnich, 32 słabe. Recall na pojedynczym pikselu przy **równym** poziomie fałszywych detekcji (2/100 Da):

| Metoda | silne | średnie | słabe |
|---|---|---|---|
| surowe | 0,896 | 0,159 | 0,013 |
| Gauss σ=1 | 0,875 | 0,169 | 0,004 |
| SG 7/2 | 0,865 | 0,158 | 0,002 |
| MA 3 | 0,861 | 0,144 | 0,003 |
| SG 15/3 (appka) | 0,598 | 0,055 | 0,000 |

**Wniosek:** na rzeczywistych danych wygładzanie spektralne **nie poprawia** wykrywania względem surowych (różnice w granicach błędu), a szerokie SG je wyraźnie psuje. Piki „średnie” i „słabe” na pojedynczym pikselu są poza zasięgiem jakiegokolwiek filtru spektralnego — poprawa musi pochodzić z wymiaru przestrzennego (uśrednianie sąsiednich pikseli, filtrowanie obrazów jonowych), czego tu nie testowałem.

## 4. Ocena pomysłów z listy

| Pomysł | Werdykt | Uzasadnienie |
|---|---|---|
| **SNR i próg/klasyfikacja** | **TAK → node `Piki wg SNR`** | Standard (MALDIquant `detectPeaks`, SNR=3 LOD, 10 LOQ). Obecny `peakpick` ma próg = ułamek maksimum widma, niezależny od szumu. Na pojedynczym pikselu surowych danych SNR 3 daje dużo FP (8,6/100 Da), próg ~4 odpowiada 2 FP/100 Da. |
| **Średnia ruchoma + szerokość okna** | **Częściowo → node `Wygładzanie dopasowane`** | Okno ma sens tylko dopasowane do pików (2–5 pkt). Zrobiłem Gauss o σ z FWHM = m/z / R, bo FWHM rośnie z m/z. Zysk jest mały (patrz sekcja 3), ale nie szkodzi, a SG 15 szkodzi. |
| **CV (współczynnik zmienności)** | **Tylko analiza, nie node** | CV kanału to miara *między pikselami*, nie pojedynczego widma. W tle CV rośnie z m/z (0,85 → 3,3), w pikach ≈ 0,9. AUC piki-vs-tło: CV = 0,17 (czyli odwrócone 0,83), a sama średnia intensywność = 0,91. Przydatne jako filtr kanałów m/z „stabilnych w tkance” przed analizą wielowymiarową (PCA/klasteryzacja), nie jako preprocessing widma. |
| **Okienko, średnia, kwadrat** | **NIE** | Kwadrat jest transformacją monotoniczną; po kalibracji progu daje identyczne wyniki jak sama średnia (05a: MA 5 → kwadrat = MA 5). |
| **STFT w oknie** | **NIE** | Moc w paśmie pików to filtr pasmowy ≈ filtr dopasowany Gaussa: wynik identyczny (0,94), koszt wyższy. Idea „weryfikacji na dużych pikach” jest dobra, ale realizuje ją kalibracja FWHM(m/z) z silnych pików (06a), co dało parametr R. |
| **Przekształcenia Tompkinsa** | **NIE** | Zaprojektowane dla QRS w EKG (pik ≫ szerokie tło, stały kształt). Tu pochodna wzmacnia szum o wysokiej częstotliwości: TPR 0,64 vs 0,83 bez filtra. |
| **Transformacja falkowa (CWT)** | **Nie teraz** | Działa (0,87), ale nie lepiej od filtra dopasowanego, a Du i in. 2006 chwalą ją głównie za niezależność od linii bazowej i wygładzania; tu mamy SNIP i prosty szum. Warto wrócić przy nakładających się pikach (izotopy, <0,3 Da). |

## 5. Co dodano do appki

- `src/msi/preprocessing.py`: `local_noise`, `smooth_matched`, `peak_pick_snr`, `apply_extra_step`.
- Nody preWidma: **Wygładzanie dopasowane** (`smooth_matched`, param R) i **Piki wg SNR** (`peakpick_snr`: SNR, okno szumu [Da], min. odstęp, tryb centroidy/profil). Podpięte w `/preprocess_chain` i w budowaniu zestawu danych.
- Testy: `tests/test_preprocessing_extra.py`.

## 6. Rekomendacje (do decyzji)

1. **Nie wygładzać po binningu SG o szerokim oknie**; domyślne SG 15 w appce obniża czułość i spłaszcza piki do 16–37% wysokości.
2. **Binning `peak_apex` zamiast `sum`** dla wąskich pików (opcja już jest w node `Bin size`).
3. **Korekcję tła robić przed normalizacją TIC.** TIC po korekcji tła ma CV międzypikselowe 12 najsilniejszych pików 0,50 vs 0,57 dla surowego TIC (proxy; tkanka niejednorodna, nie traktować jako dowodu). RMS po korekcji dał 0,46, ale RMS jest zdominowany przez najsilniejsze piki, więc wymaga osobnej walidacji (Deininger i in. wskazują normalizację do mediany/szumu jako odporniejszą na artefakty niż TIC).
4. **Następny krok o największym potencjale:** uśrednianie/filtrowanie przestrzenne (sąsiednie piksele), bo tylko ono może podnieść piki „średnie” i „słabe”.

## Ograniczenia

- Test półsyntetyczny używa pików Gaussa o stałym FWHM 0,08 Da (dolna granica realnych szerokości), więc przecenia zysk filtrów wąskich.
- Piki referencyjne pochodzą ze średniego widma; „FP” w sekcji 3 to detekcje bez pokrycia w tej liście, więc to proxy, nie prawdziwy odsetek fałszywych.
- Próbka 300 pikseli z losowych pozycji, 100 użytych do walidacji; bez podziału na tkanki.

## Źródła

- MALDIquant: `detectPeaks` (SNR, MAD/SuperSmoother, halfWindowSize) — https://rdrr.io/pkg/MALDIquant/man/detectPeaks-methods.html, https://arxiv.org/pdf/1607.03180
- Du P., Kibbe W., Lin S. (2006), *Bioinformatics* 22(17), CWT peak detection — pakiet MassSpecWavelet: https://bioconductor.statistik.tu-dortmund.de/packages/3.19/bioc/vignettes/MassSpecWavelet/inst/doc/MassSpecWavelet.html
- Cardinal (Bemis i in. 2015), pipeline MSI: https://mallicklab.stanford.edu/pdfs/2015-Bemis-cardinal_r_package_statistical_analysis_mass.pdf
- MALDIrppa: https://cran.r-project.org/web/packages/MALDIrppa/vignettes/MALDIrppa_vignette_v110.html
- Deininger i in. (2011), normalizacja MALDI-MSI: https://pmc.ncbi.nlm.nih.gov/articles/PMC3124646
