# Raport: jak ocenić, czy m/z naprawdę różnicuje tkanki (REF / KETAMIN / MDMA / PSYL)

**Dane:** FMP10_Rat_brain_breg_084, 4 skrawki (REF, KETAMIN, MDMA, PSYL), 16 341 surowych widm, matryca FMP-10.
**Skrypty:** `scripts/08_mz_marker_profile.py` (karta m/z + ranking), `09_mass_shift_check.py` (przesunięcie masy),
`10_recalibrated_ranking.py` (ranking po rekalibracji), `11_position_gradient_test.py` (gradient szkiełka).
**Obrazy:** `praOutputs/08_markery/` — `karta_<mz>.png` dla każdego m/z, `09_przesuniecie_masy.png`,
`10_ranking_po_rekalibracji.png`, `11_gradient_vs_tkanka.png`, `segmentacja_wspolna.png`.
**Lista badana:** m/z z Twoich workspace'ów (309,19; 353,2; 415; 424,5; 444,2; 480,3; 496; 508; 674,5; 690,2; 957,5). Jeśli Twoja lista 10 „dobrych” jest inna, podmień `USER_LIST` w skrypcie 08 (albo `--mz ...`).

## TL;DR

1. **Kalibracja masy różni się między skrawkami**: apeksy pików przesuwają się o +20 / +50 / +62 ppm (KETAMIN / MDMA / PSYL względem REF), w kolejności ułożenia na szkiełku. Wewnątrz skrawków przesunięcie rośnie też wzdłuż x i y (≈ 28 i 37 ppm na 100 px), co pasuje do nachylonej płytki lub różnej wysokości próbki.
2. **Większość Twoich m/z leży na zboczu piku, nie na wierzchołku.** Np. 496,0 przy apeksie 496,18; 674,5 przy 674,29; 444,2 przy 444,07. To wygląda na środki binów 0,5 Da, a nie apeksy. Przy stałym oknie ±tol na zboczu samo przesunięcie kalibracji tworzy pozorne różnicowanie.
3. **Po liczeniu pola całego piku** (wokół apeksu każdej tkanki) różnicowanie 496,0 i 508,0 znika (max |Cliff δ| z 0,71–0,72 do 0,15–0,24). Dla 353,2, 415 i 957,5 spada do małego. Zostaje umiarkowane dla 444,2 (0,45), 674,5 = dopamina 2A (0,46), 690,2 = noradrenalina 2A (0,44) i 424,5 (0,53). Dla 444,2 i 674,5 **odwraca się też kierunek**: w oknie stałym PSYL wypadał wyżej, w polu piku REF wypada wyżej.
4. **Nawet po korekcji 33% wszystkich pików ma idealnie monotoniczny porządek REF > KET > MDMA > PSYL (lub odwrotny).** Losowo spodziewalibyśmy się 8%. TIC po korekcji tła też maleje w tej kolejności (3666 → 2884). Z jednym skrawkiem na grupę i grupami ułożonymi w tej samej kolejności co gradient na szkiełku **nie da się rozdzielić efektu leku od efektu położenia/skrawka**. To jest główne ograniczenie, ważniejsze niż wybór metryki.
5. **Adnotacja (reguła FMP-10: 1A = M + 268,112; 2A = M + 2·268,112 − CH₃):** 674,29 = dopamina 2A (+15 ppm po rekalibracji), 690,27 = noradrenalina 2A (−7 ppm). 444,07 jako serotonina 1A (444,207) jest **wątpliwa**: −0,14 Da to więcej niż odchyłka kalibracji w tym zakresie, choć M+1/M = 0,33–0,35 pasuje do oczekiwanego 0,33. Do potwierdzenia potrzebne MS/MS albo FMP-10-d₃.

## 1. Kontekst, który zmienia interpretację

- **FMP-10 to matryca reaktywna:** dokleja się do grup fenolowych i aminowych (dopamina, serotonina, GABA, noradrenalina…). Każda derywatyzacja przesuwa masę o 268,1121. Podwójnie derywatyzowane formy tracą CH₃ (2A: M + 521,201) albo H (2B: M + 535,217). Potwierdzone tabelą kalibracji Met-ID (DA 1A 421,191; DA 2A 674,280; DA 2B 688,296; GABA 1A 371,175; GABA-H₂O 353,165; lock mass FMP-10 555,2231).
- **Bregma 0,84 = przekrój przez prążkowie** (caudate-putamen, nucleus accumbens), region bogaty w dopaminę.
- **Znana farmakologia:** MDMA ostro obniża 5-HT i 5-HIAA w prążkowiu (minimum ok. 3 h po podaniu, częściowy powrót po 24 h) i lekko podnosi DA. Ketamina i psylocybina zwiększają uwalnianie DA i 5-HT (mikrodializa, czyli poziomy pozakomórkowe, nie tkankowe). Bez czasu od podania i dawki trudno przewidzieć kierunek zmian w MSI.

## 2. Jak opisać „dobre różnicujące m/z” — parametry

Zestaw w 5 grupach. Każda odpowiada na inne pytanie, a wszystkie są liczone w karcie m/z (skrypt 08).

### A. Czy to w ogóle prawdziwy, jeden związek? (jakość piku)

| Parametr | Co mówi | Próg / interpretacja |
|---|---|---|
| **Apeks per tkanka** vs wpisane m/z | czy okno trafia w wierzchołek | odchyłka > ½ FWHM (~0,05 Da) oznacza, że mierzysz zbocze, nie pik |
| **Przesunięcie apeksu między tkankami** | stabilność kalibracji | > 10–20 ppm: rekalibruj przed porównaniem |
| **FWHM** | czy to jeden pik, czy zlepek | tu typowo 0,10–0,13 Da; > 0,2 Da (424,5: 0,24–0,34) sugeruje nakładające się piki |
| **SNR średniego piku, % pikseli z SNR ≥ 3** | wykrywalność | > 90% pikseli: sygnał „wszędzie”, porównanie ilościowe ma sens |
| **M+1/M (izotop +1,003)** | czy masa pasuje do wzoru | ≈ 1,08% × liczba C; pochodne FMP-10 1A: 0,27–0,40; zbyt wysokie (690: ~1,0 vs 0,52 oczekiwane) oznacza nakładający się pik w M+1 |
| **Kandydat FMP-10 (1A/2A/2B)** | możliwa tożsamość | po rekalibracji ±50 ppm; potwierdzenie: MS/MS, FMP-10-d₃ (przesunięcie +3,019 Da) |

### B. Jak mocno różnicuje? (wielkość efektu, nie p-wartość)

| Parametr | Definicja | Interpretacja |
|---|---|---|
| **Mediana per tkanka, log₂FC vs REF** | zmiana typowego poziomu | log₂FC 0,58 ≈ 1,5×; 1 = 2× |
| **AUC (ROC) para / 1-vs-reszta** | P(losowy piksel A > losowy piksel B) | 0,5 brak; > 0,7 lub < 0,3 wyraźne (konwencja MSI) |
| **Cliff δ = 2·AUC − 1** | nieparametryczna wielkość efektu | \|δ\| < 0,147 pomijalny, < 0,33 mały, < 0,474 średni, wyżej duży (Romano 2006) |
| **Hedges g** | efekt w odchyleniach standardowych | wrażliwy na ogony; pomocniczy |
| **ε² Kruskala-Wallisa** | jaka część zmienności rankingowej to „grupa” | > 0,14 duży, 0,06 średni |

**Nie używaj p-wartości z pikseli.** Piksele nie są niezależnymi replikami: przy ~4000 pikselach na tkankę każda różnica wychodzi „p < 10⁻¹⁰⁰”. Jednostką replikacji jest zwierzę lub skrawek, a tu jest n = 1 na grupę.

### C. Jak to wygląda w przestrzeni? (biologia czy szum)

| Parametr | Co mówi |
|---|---|
| **Moran I** (autokorelacja sąsiadów) | > 0,3 oznacza strukturę anatomiczną; ~0 to szum / pojedyncze piksele |
| **Gini, CV wewnątrz tkanki** | czy sygnał skupia się w hotspotach (wysoki Gini) czy jest równomierny |
| **% powierzchni > P75 globalnego** | czy różnica dotyczy całej tkanki, czy jednego regionu |
| **Mediana w regionach wspólnej segmentacji** | porównanie region-do-regionu zamiast całych skrawków (patrz pkt 3.4) |

### D. Czy różnica przetrwa zmianę obróbki? (odporność, czyli najważniejsze kryterium „poprawności”)

| Test | Dobry marker | Podejrzany |
|---|---|---|
| **Stałe okno ±tol vs pole piku wokół apeksu** | podobny wynik | duża różnica oznacza artefakt kalibracji (496, 508, 353) |
| **Tolerancja 0,05 / 0,1 / 0,25 / 0,5** | stabilne \|δ\| | skoki (415: 0,92 → 0,25) oznaczają, że okno tnie pik |
| **Normalizacja: brak / TIC / TIC po tle / RMS / szum** | ten sam kierunek AUC | zmiana znaku: wynik tworzy normalizacja |
| **ρ z odległością od krawędzi skrawka** | ~0 | \|ρ\| > 0,3: efekt brzegowy (delokalizacja, wysychanie matrycy) |
| **ρ z jonem matrycy (555,22)** | ~0 | wysoka: pokrycie matrycą / efektywność derywatyzacji |
| **Monotoniczność wzdłuż szkiełka** (REF < KET < MDMA < PSYL) | brak | idealny porządek zgodny z położeniem: podejrzenie gradientu |

### E. Kontekst

- **Kolokalizacja (Spearman z innymi pikami):** izotopy, addukty, ta sama ścieżka metaboliczna (np. 674,29 = DA 2A koreluje najsilniej z 941–943 = DA 3B, 941,385, ρ = 0,7–0,78, i z 688 = DA 2B, ρ = 0,61). Trzy formy derywatyzacji tej samej cząsteczki o wspólnym rozkładzie to mocny argument za dopaminą.

## 3. Wyniki

### 3.1 Twoja lista: stałe okno (jak w appce) vs pole piku

| m/z (Twoje) | apeks REF → PSYL | max \|δ\| okno ±0,1 | max \|δ\| pole piku | mediany pola REF/KET/MDMA/PSYL | ocena |
|---|---|---|---|---|---|
| 309,19 | 309,00 → 309,03 | 0,18 | 0,19 | 18,0/17,5/16,5/16,3 | nie różnicuje |
| 353,2 (GABA-H₂O?) | 353,06 → 353,08 | **0,66** | 0,32 | 10,8/10,5/9,0/8,8 | głównie artefakt okna; mały efekt |
| 415 | 415,04 → 415,08 | 0,49 | 0,27 | 6,8/6,5/5,9/5,7 | mały efekt, monotoniczny |
| 424,5 | 424,2 (szeroki) | 0,54 | **0,53** | 75/84/86/95 | duży, ale FWHM 0,3 = prawdopodobnie kilka pików |
| **444,2** | 444,07 → 444,10 | 0,67 | **0,45** | 9,2/8,7/7,9/7,7 | średni; REF > reszta, monotoniczny |
| 480,3 | 480,14 → 480,17 | 0,28 | 0,30 | 2,7/2,8/2,9/3,1 | mały |
| 496 | 496,17 → 496,20 | **0,72** | 0,15 | 5,3/5,1/5,5/5,4 | **artefakt** (okno na lewym zboczu) |
| 508 | 508,16 → 508,19 | **0,71** | 0,24 | 2,8/3,0/3,2/2,9 | **artefakt** |
| 674,5 (DA 2A) | 674,29 → 674,33 | 0,20 | **0,46** | 3,5/3,3/2,9/2,5 | okno 674,5 mijało pik; na apeksie średni efekt |
| 690,2 (NA 2A) | 690,27 → 690,31 | 0,73 | **0,44** | 2,5/2,4/2,0/2,0 | średni; REF/KET > MDMA/PSYL |
| 957,5 | 957,40 → 957,46 | 0,32 | 0,11 | 0,39/0,40/0,35/0,40 | nie różnicuje |

### 3.2 444,2 pod lupą (`karta_444.20.png`)

- **Pik:** wierzchołek przy 444,07 (REF) – 444,10 (PSYL), FWHM 0,10–0,13 Da, SNR średniego piku 41–56, wykrywalny w > 99% pikseli. M+1/M = 0,33–0,35 zgadza się z oczekiwanym dla serotoniny-FMP-10 (C₃₀, 0,33). Masa jest jednak 0,13 Da poniżej teorii (444,207). Kalibranty w pobliżu (DA 1A 421: −0,08; GABA 371: −0,09) sugerują odchyłkę rzędu −0,08, więc identyfikacja jako 5-HT jest **możliwa, ale niepotwierdzona**.
- **Okno 444,2 ± 0,1 mierzy prawe zbocze** (szary pas na wykresie). Ponieważ pik przesuwa się w prawo REF → PSYL, okno łapie u PSYL więcej sygnału, stąd pozorne PSYL > REF (Cliff −0,67).
- **Pole piku daje odwrotny kierunek:** REF 9,2 > KET 8,7 > MDMA 7,9 > PSYL 7,7 (REF vs PSYL δ = +0,45, REF vs MDMA +0,39). Gdyby to była 5-HT, spadek w MDMA zgadzałby się z literaturą. Jest jednak monotoniczny wzdłuż szkiełka, tak jak 33% wszystkich pików, więc **nie można go przypisać lekowi**.
- **Przestrzeń:** Moran I 0,61–0,73, wyraźna anatomia (ciemniejsze ciało modzelowate i komory). Region-do-regionu (heatmapa) REF > PSYL utrzymuje się w każdym regionie, czyli to przesunięcie poziomu całego skrawka, nie zmiana jednego regionu.
- **Kolokalizacja:** najsilniej z 601, 586, 570, 569, 701 Da (ρ ≈ 0,66–0,71) i z 353 (GABA-H₂O?, 0,66). Nie ma partnera typu 2A/2B serotoniny (697,30 / 711,31), jakiego można by oczekiwać przy 5-HT; 690 (NA 2A) koreluje z 711 tylko na poziomie 0,58. Pasmo 550–610 dominuje też w rankingu różnicowania (24/40) i wymaga identyfikacji.

### 3.3 Ranking całego widma po rekalibracji (`ranking_po_rekalibracji.csv`)

- 1065 pików; per-pikselowa korekcja ppm z jonu matrycy (mediany: REF −6,5; KET +12,6; MDMA +39; PSYL +53 ppm).
- Czołówka (np. 602,23; 907,37; 429,95; 701,33; 744,39; 587,23) to prawie same wzorce **REF > KET > MDMA > PSYL**, |δ| 0,6–0,78. Z Twojej listy najwyżej są 444,07 (percentyl 92) i 690,27 (89).
- Znane pochodne: tauryna 2B (660,25) |δ| = 0,65; MDA 2A? (700,27) 0,46; dopamina 2A 0,45; histamina 2A 0,43 (jako jedna z nielicznych rośnie REF → PSYL); noradrenalina 2A 0,42. Sam lek (MDMA 2A/2B, ketamina, psylocyna) **nie jest widoczny** (|δ| ≈ 0,1). Może to oznaczać zbyt niskie stężenie, długi czas od podania albo brak derywatyzacji.

### 3.4 Dlaczego nie da się (jeszcze) powiedzieć „to efekt leku”

- **n = 1 skrawek na grupę.** Różnicę między grupami mogą tworzyć zwierzę, grubość skrawka, poziom cięcia albo położenie na szkiełku.
- **Pomieszanie z położeniem:** grupy leżą na szkiełku w kolejności REF → KET → MDMA → PSYL. W tej samej kolejności rośnie przesunięcie masy, spada TIC, a 33% pików zmienia się monotonicznie. Test nachyleń (skrypt 11) wypadł niejednoznacznie. Trendy wewnątrz skrawków są silniejsze niż między nimi (głównie przez zmianę TIC), więc prosta „nachylona płytka” nie wyjaśnia wszystkiego, ale też tego nie wyklucza.
- **Inny skład regionów:** wspólna segmentacja (6 regionów) daje bardzo różne udziały. Np. region 1 to 56% REF i 6% PSYL, region 5 to 11% REF i 43% PSYL. Skrawki różnią się kształtem i poziomem cięcia, a część „regionów” to po prostu przesunięcie poziomu całych skrawków. Porównanie średniej całej tkanki miesza więc anatomię z grupą.

## 4. Rekomendacje

**Analiza (od zaraz):**
1. Każde m/z ustawiać na **apeksie piku** i liczyć **pole piku** (±0,2 Da), nie stałe okno wokół okrągłej liczby.
2. **Rekalibrować** per piksel (lock mass FMP-10 555,2231, najlepiej plus 2–3 znane pochodne dla krzywej nieliniowej: przy 350–450 Da zostaje ok. −0,1 Da błędu).
3. Raportować **wielkość efektu (Cliff δ / AUC) i stabilność**, nie p-wartości z pikseli. Za „poprawny” marker uznawać tylko taki, który przechodzi testy z grupy D.
4. Porównywać **region do regionu** (np. CPu REF vs CPu MDMA), nie całe skrawki.

**Eksperyment (jeśli to możliwe):**
5. Więcej niż 1 zwierzę na grupę. Skrawki z różnych grup **przeplatać lub losować** na szkiełkach. REF warto mieć na każdym szkiełku.
6. Wzorzec wewnętrzny (np. deuterowany DA/5-HT natryśnięty z matrycą) do normalizacji między skrawkami. Potwierdzenie tożsamości przez MS/MS lub FMP-10-d₃.

**Aplikacja (propozycje, nie wdrożone):**
- **Node „Rekalibracja m/z (lock mass)”** w preWidma: przesunięcie ppm per piksel wg 555,2231, opcjonalnie wiele kalibrantów.
- **Mapa m/z wg apeksu:** przy wpisaniu m/z appka sama znajduje najbliższy apeks i liczy pole piku, z ostrzeżeniem, gdy apeks jest > 0,05 Da od wpisanej wartości.
- **Zakładka / node „Karta m/z”**: metryki A–E i panele jak w `karta_*.png`.

## Ograniczenia

- Adnotacje to dopasowania masy (± kilkadziesiąt ppm na TOF o R ≈ 4–6 tys.), nie identyfikacje.
- Korekcja masy to jeden kalibrant i model stałego ppm; przy niskich m/z zostaje błąd ~−0,1 Da.
- Pole piku ±0,2 Da może obejmować sąsiednie piki (np. 424,5).
- Segmentacja wspólna (k-means, k = 6) jest pomocnicza i bez weryfikacji anatomicznej.

## Źródła

- Shariatgorji i in. 2019, *Nat Methods*, FMP-10: https://www.nature.com/articles/s41592-019-0551-3
- Protokół FMP-10 (*Nat Protoc* 2021): https://www.nature.com/articles/s41596-021-00538-w
- Met-ID, tabela kalibracji pochodnych FMP-10 (SI): https://www.biorxiv.org/content/10.1101/2025.01.24.634674v1.full.pdf
- Vallianatou 2025, FMP-10-d₃: https://chemistry-europe.onlinelibrary.wiley.com/doi/10.1002/cmtd.202500062
- Statystyka MALDI-MSI, niezależność pikseli: https://www.ncbi.nlm.nih.gov/pmc/articles/PMC3489526/
- ROC/AUC do wyboru m/z w MSI: https://dx.doi.org/10.3390/ijms26189084
- Progi Cliff δ (Romano 2006): https://rdrr.io/cran/rstatix/man/cliff_delta.html
- MDMA a 5-HT w prążkowiu: https://pubmed.ncbi.nlm.nih.gov/2902215
- Ketamina / psylocybina a neuroprzekaźniki: https://www.ncbi.nlm.nih.gov/pmc/articles/PMC9224489/
- Moran I w MSI: https://www.biorxiv.org/content/10.1101/2025.10.27.684518.full.pdf
