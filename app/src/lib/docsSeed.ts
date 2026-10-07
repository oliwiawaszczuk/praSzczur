// Domyślna treść zakładki "Dokumentacja" — poradnik/opis DZIAŁANIA appki
// praSzczur (nie kodu). Używana jako fallback, dopóki user nie nadpisze
// sekcji przyciskiem "Edytuj" (patrz appdocs.svelte.ts: wartości edytowane
// zapisują się do app_docs.json i odtąd przesłaniają poniższy tekst).
//
// Kolejność TAB_DOCS odzwierciedla kolejność zakładek w +page.svelte.

export interface TabDocMeta {
  key: string;
  title: string;
  body: string;
}

export const TAB_DOCS: TabDocMeta[] = [
  {
    key: "dane",
    title: "Dane",
    body: `Punkt wejścia do appki — tu wczytujesz plik źródłowy .imzML/.ibd (dataset MALDI-TOF).

Co można zrobić w tej zakładce:
- Wczytać/zmienić plik imzML dla bieżącego workspace'u.
- Zdefiniować tkanki (bounding boxy x/y na obrazie), nadać im etykiety i kolory.
- Uruchomić preprocessing (binowanie widm) — wynik trafia do workspaces/<id>/processed/<tkanka>.npz i dopiero od tego momentu reszta appki (m/z, Widma, Node Graph) ma na czym pracować.

To jedyne miejsce, gdzie zmienia się "surowe" źródło danych workspace'u — wszystkie inne zakładki czytają już przetworzone/zbinowane dane.`,
  },
  {
    key: "zestawDanych",
    title: "Zestaw danych",
    body: `Zarządzanie "zestawami danych" (datasets) — niezależnymi wariantami przetworzonych danych dla tego samego pliku imzML, np. różne parametry binowania albo różny łańcuch przetwarzania wstępnego widm.

Co można zrobić:
- Tworzyć, zmieniać nazwę i usuwać zestawy danych.
- Aktywować wybrany zestaw (reszta appki — m/z, Widma, Node Graph — operuje na aktywnym zestawie).
- Edytować łańcuch "pre-node'ów" (wygładzanie, korekcja linii bazowej itd.) stosowany do widm w danym zestawie, zanim trafią do zapytań m/z.`,
  },
  {
    key: "mz",
    title: "m/z",
    body: `Zapytania o mapy jonowe (ion images) dla konkretnej wartości m/z ± tolerancja. Ma cztery podzakładki:

- m/z — samo zapytanie: wpisujesz m/z i tolerancję, dostajesz mapę intensywności per tkanka (siatka obrazów), z panelem bocznym do zakresu wyświetlania i inwersji kolorów.
- Grupy — wiele zapytań m/z naraz obok siebie (kolumny), do porównywania kilku jonów równolegle.
  Kolumn może być wiele zestawów (przełącznik i "+" w pasku nad kolumnami, jak przy grafach); każdy zestaw ma własne kolumny, zaznaczenia i tryb łączenia. Zmiana nazwy i usuwanie zestawów: Ustawienia → karta "Zestawy grup m/z".
- Łączenie — łączenie/kombinowanie kilku map pikseli w jedną (np. suma, średnia, maksimum kanałów).
- Zapisane — biblioteka zapisanych map pikseli; stąd mapę można wysłać dalej do Node Grapha jako node źródłowy.`,
  },
  {
    key: "widma",
    title: "Widma",
    body: `Widmo masowe pojedynczego piksela (surowe dane, bez przetwarzania wstępnego) jako interaktywny wykres.

Co można zrobić:
- Kliknąć piksel na powiązanej mapie (panel pikseli), żeby zobaczyć jego pełne widmo.
- Zapisać widmo do biblioteki "Zapisane widma" i wysłać je dalej do Node Grapha jako źródło.`,
  },
  {
    key: "prewidma",
    title: "preWidma",
    body: `Jak "Widma", ale pokazuje widmo PO przetworzeniu wstępnym (łańcuch pre-node'ów z zakładki "Zestaw danych": wygładzanie, korekcja linii bazowej itd.) zestawione z widmem surowym — do oceny, co dokładnie zmienia dany krok przetwarzania na konkretnym pikselu.`,
  },
  {
    key: "preprocessing",
    title: "Preprocessing",
    body: `Zakładka w budowie (placeholder). Docelowo: osobny panel do konfiguracji globalnego przetwarzania wstępnego widm (normalizacja, korekcja linii bazowej, redukcja szumu). Dziś konfigurację przetwarzania wstępnego robi się przez edytor łańcucha pre-node'ów w zakładce "Zestaw danych".`,
  },
  {
    key: "nodegraph",
    title: "Node Graph",
    body: `Wizualny edytor przepływu przetwarzania danych MSI w stylu Blendera — łączysz node'y w graf zamiast klikać przez kolejne zakładki ręcznie.

Kluczowe pojęcia:
- Wiele niezależnych grafów per workspace — przełącznik grafów i "+" (nowy graf) są w prawym panelu, nad listą typów node'ów.
- Cztery domeny node'ów: Widmo, Mapa pikseli, Segmentacja, Analiza grup — każda ma własne node'y źródłowe (np. "Mapa m/z", "Segment", "Widmo"), przetwarzające (zakres intensywności, krzywa, łączenie map, k-means, operacje na segmentach, wygładzanie/baseline/peak-picking widma) i wynikowe (zapis do biblioteki).
- Domena "Analiza grup" odtwarza workflow z MATLAB-a (PLS-DA lek vs kontrola): zestaw próbek (tkanki / segmenty / widma, port "Zestaw widm") → Preprocessing zestawu → PLS-DA (walidacja krzyżowa, okno "Diagnostyka") → Top m/z (lista do wklejenia w zakładce m/z). Próbką jest widmo tkanki lub segmentu, nie piksel.
- Gniazda (porty) łączą się tylko między tym samym rodzajem danych (kolor kropki = rodzaj) — appka nie pozwoli podłączyć np. segmentu tam, gdzie oczekiwana jest mapa.
- Każdy node ma ikonkę "(i)" w nagłówku — najechanie pokazuje opis node'a, kliknięcie przenosi do tej Dokumentacji, do sekcji opisującej dokładnie ten typ node'a (i na odwrót: edycja opisu tutaj od razu zmienia to, co pokazuje tooltip "(i)").
- "Wyślij do Node Graph" w innych zakładkach (m/z/Widma/Zapisane) pozwala wstawić zapisany obiekt bezpośrednio jako node źródłowy.`,
  },
  {
    key: "tablica",
    title: "Tablica",
    body: `Wolna, niezależna od workspace'ów tablica typu Miro (whiteboard) — obrazy i tekst, przeciąganie/skalowanie/obracanie, zoom/pan, zaznaczanie wielu obiektów naraz, kopiuj-wklej. Jedna wspólna lista tablic widoczna niezależnie od tego, który workspace jest aktywny — przydatna np. do zbierania screenshotów/notatek wizualnych poza konkretnym projektem.`,
  },
  {
    key: "notatki",
    title: "Notatki",
    body: `Swobodne notatki tekstowe, globalne (nie per-workspace). Lista z wyszukiwarką po lewej (nawigacja strzałkami), pełny edytor tekstu po kliknięciu notatki. Notatkę można przypiąć (📌) — wtedy pokazuje się jako mała pływająca notatka w prawym górnym rogu appki, widoczna niezależnie od tego, w której zakładce aktualnie jesteś.`,
  },
  {
    key: "settings",
    title: "Ustawienia",
    body: `Zarządzanie workspace'ami i zestawami danych appki.

Co można zrobić:
- Tworzyć, przełączać, zmieniać nazwę, usuwać, eksportować i importować workspace'y.
- Zarządzać zestawami danych (jak w zakładce "Zestaw danych").
- Karta "Node Graphy" — zmiana nazwy/usuwanie zapisanych grafów Node Grapha w bieżącym workspace.
- Karta "Zestawy grup m/z" — zmiana nazwy/usuwanie zestawów kolumn z zakładki m/z → Grupy w bieżącym workspace.
- Globalne ustawienia appki niezależne od workspace'u (np. czułość zoomu/przesuwania płótna — wspólna dla wszystkich Node Graphów i Tablicy).`,
  },
  {
    key: "dokumentacja",
    title: "Dokumentacja",
    body: `Ta zakładka — poradnik i opis działania appki praSzczur (nie kodu). Po lewej spis wszystkich zakładek appki oraz typów node'ów Node Grapha, po prawej pełna treść wybranej sekcji.

Każda sekcja ma przycisk "Edytuj" w prawym górnym rogu — po kliknięciu treść staje się edytowalnym polem tekstowym, "Zapisz" zachowuje zmiany (globalnie, niezależnie od workspace'u).

Sekcje node'ów Node Grapha są zsynchronizowane z tooltipem "(i)" pokazywanym na każdym node'ie na płótnie: to ta sama treść w dwóch miejscach — edycja w Dokumentacji od razu zmienia tooltip, a kliknięcie ikonki "(i)" na node'ie przenosi tutaj, do właściwej sekcji.`,
  },
];
