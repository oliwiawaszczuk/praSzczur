<script lang="ts">
  import { onMount } from "svelte";
  import { wsGet, wsSet } from "$lib/workspace.svelte";
  import ConfirmModal from "$lib/ConfirmModal.svelte";
  import { fetchPreprocessChain, fetchImzmlNativeRange, type PreprocessChainResult } from "./api";
  import {
    NODE_TYPE_LIST, NODE_TYPES, CATEGORY_ORDER, CATEGORY_LABELS, defaultGraph, defaultDatasetGraph,
    originalDatasetGraph, graphFromSteps, defaultParams, makeId, buildChain,
    type PreGraph, type PreNode, type PreEdge, type PreViewport,
  } from "$lib/prenodes";
  import {
    datasets, loadDatasets, datasetsLoaded, activeDatasetId, createDataset, buildPipelineDataset,
    fetchDatasetGraph, saveDatasetGraph, RAW_DATASET_ID, type DatasetMeta,
  } from "$lib/datasets.svelte";

  interface Pixel { tissue: string; x: number; y: number; }

  interface Props {
    pixelLeft?: Pixel | null;
    pixelRight?: Pixel | null;
    onResult?: (side: "left" | "right", result: PreprocessChainResult | null) => void;
    /** Gdy podane: edytor pokazuje/edytuje graf TEGO zestawu danych (zapisywany
     * per-dataset w rejestrze sidecara), a węzeł "Wynik" służy do przebudowy
     * właśnie tego zestawu. Gdy pominięte (użycie w zakładce preWidma jako
     * podgląd łańcucha na 1-2 pikselach): graf jest globalnym scratchpadem
     * per-workspace jak dotychczas, a "Zapisz" tworzy/nadpisuje DOWOLNY inny
     * zestaw wskazany w dropdownie. */
    datasetId?: string;
    /** Czy ten edytor jest aktualnie widoczny (aktywna zakładka). Gdy `datasetId`
     * jest ustawione, przejście z niewidocznego na widoczny powoduje ponowne
     * pobranie grafu z sidecara — tak żeby zmiany zapisane w INNEJ instancji
     * edytora (np. w drugiej zakładce, dla tego samego zestawu) nie były
     * pokazywane jako nieaktualne po przełączeniu zakładki. */
    visible?: boolean;
  }
  let { pixelLeft = null, pixelRight = null, onResult, datasetId, visible = true }: Props = $props();

  // Zestaw "original" jest chroniony — pokazujemy jego graf (stały: źródło→wynik)
  // wyłącznie do podglądu, bez możliwości edycji/przebudowy.
  let readonly = $derived(datasetId === "original");

  onMount(async () => { if (!datasetsLoaded()) await loadDatasets(); });

  // Rzeczywisty (natywny) zakres m/z pliku imzML — ogranicza suwaki node'a
  // "Zakres m/z" do granic faktycznie obecnych w danych, zamiast dowolnych,
  // twardo zakodowanych wartości (np. nie da się ustawić 100–300, gdy plik
  // faktycznie zaczyna się od 300). `null` dopóki nie odpowie sidecar —
  // wtedy renderowanie korzysta ze statycznych domyślnych granic z prenodes.ts.
  let nativeMzRange = $state<{ mz_min: number; mz_max: number } | null>(null);
  onMount(async () => {
    const r = await fetchImzmlNativeRange(wsGet<string>("dane_imzmlPath", "") || undefined);
    if (r) nativeMzRange = r;
  });

  // Efektywne min/max dla parametru node'a — dla mz_range podmienia statyczne
  // wartości z prenodes.ts na realne granice pliku, gdy są już znane.
  function effectiveMin(nodeType: string, p: { key: string; min?: number }): number | undefined {
    if (nodeType === "mz_range" && nativeMzRange) {
      if (p.key === "mz_min") return nativeMzRange.mz_min;
      if (p.key === "mz_max") return nativeMzRange.mz_min;
    }
    return p.min;
  }
  function effectiveMax(nodeType: string, p: { key: string; max?: number }): number | undefined {
    if (nodeType === "mz_range" && nativeMzRange) {
      if (p.key === "mz_min") return nativeMzRange.mz_max;
      if (p.key === "mz_max") return nativeMzRange.mz_max;
    }
    return p.max;
  }

  function setNodeDataset(node: PreNode, datasetId: string) {
    if (readonly) return;
    const idx = graph.nodes.findIndex((n) => n.id === node.id);
    if (idx === -1) return;
    graph.nodes[idx] = { ...graph.nodes[idx], datasetId };
    persist();
  }

  // Wygaszenie node'a preprocessingu (oczko) — dane przechodzą przez niego
  // bez zmian, patrz buildChain() w prenodes.ts.
  function toggleNodeEnabled(node: PreNode) {
    if (readonly) return;
    const idx = graph.nodes.findIndex((n) => n.id === node.id);
    if (idx === -1) return;
    const enabled = graph.nodes[idx].enabled === false; // był false → włącz, inaczej wygaś
    graph.nodes[idx] = { ...graph.nodes[idx], enabled };
    persist();
  }

  const LS_GRAPH = "prenodes_graph";

  function sanitize(g: PreGraph): PreGraph {
    if (!g.nodes) g.nodes = [];
    if (!g.edges) g.edges = [];
    if (!g.viewport) g.viewport = { x: 0, y: 0, zoom: 1 };
    return g;
  }

  let graph = $state<PreGraph>(
    sanitize(datasetId ? defaultDatasetGraph() : wsGet<PreGraph>(LS_GRAPH, defaultGraph())),
  );
  let loadedDatasetId = $state(""); // dataset id whose graph is currently loaded into `graph`
  let wasVisible = $state(visible);

  // Gdy zestaw nie ma jeszcze zapisanego grafu (edycji wizualnej) — bo powstał
  // starszą ścieżką (legacy `params`/`steps`, albo /process) — odtwarzamy graf
  // wprost z jego rzeczywistego, zapisanego łańcucha (`source_dataset_id` +
  // `steps`), zamiast pokazywać mylący pusty/domyślny graf.
  function fallbackGraphFor(id: string): PreGraph {
    if (id === "original") return originalDatasetGraph();
    const meta: DatasetMeta | undefined = datasets().find((d) => d.id === id);
    if (meta?.steps?.length) {
      return graphFromSteps(meta.source_dataset_id ?? RAW_DATASET_ID, meta.steps);
    }
    return defaultDatasetGraph();
  }

  // Sprawdza, czy zapisany graf (`remote`) wciąż odzwierciedla rzeczywisty,
  // aktualny łańcuch zestawu (`meta.source_dataset_id` + `meta.steps`) — np.
  // po tym, jak zestaw został ponownie przetworzony w zakładce "Dane" (inny
  // zakres m/z / bin size), co zmienia `steps` w rejestrze, ale NIE dotyka
  // wcześniej zapisanego wizualnego grafu. Bez tej kontroli edytor pokazywałby
  // w nieskończoność zamrożony, nieaktualny graf z pierwszego otwarcia zestawu
  // (bo samo otwarcie — przez auto-fit widoku — potrafi zapisać graf, patrz
  // `fitAllSilent` niżej).
  function graphMatchesSteps(g: PreGraph, meta: DatasetMeta | undefined): boolean {
    if (!meta) return true; // brak metadanych — nie ma z czym porównać, ufaj grafowi
    const outNode = g.nodes.find((n) => n.type === "output");
    if (!outNode) return false;
    const chain = buildChain(g, outNode.id);
    if (!chain) return false;
    const expectedSource = meta.source_dataset_id ?? RAW_DATASET_ID;
    const actualSource = chain.source === "raw" ? RAW_DATASET_ID : (chain.datasetId ?? "");
    if (expectedSource !== actualSource) return false;
    const expectedSteps = meta.steps ?? [];
    if (chain.steps.length !== expectedSteps.length) return false;
    return chain.steps.every((s, i) =>
      s.method === expectedSteps[i].method &&
      JSON.stringify(s.params) === JSON.stringify(expectedSteps[i].params)
    );
  }

  async function loadGraphFor(id: string) {
    if (!datasetsLoaded()) await loadDatasets();
    const meta = datasets().find((d) => d.id === id);
    const remote = id === "original" ? null : (await fetchDatasetGraph(id) as PreGraph | null);
    const useRemote = remote && graphMatchesSteps(remote, meta);
    graph = sanitize(useRemote ? remote! : fallbackGraphFor(id));
    loadedDatasetId = id;
    // Zawsze wyśrodkuj/dopasuj widok przy wejściu na zestaw — nie przywracamy
    // starego zapisanego viewportu, który mógł być poza ekranem dla innego grafu.
    queueFitAll();
  }

  // Gdy edytor jest związany z konkretnym zestawem (`datasetId`), graf jest
  // ładowany/zapisywany per-dataset w rejestrze sidecara zamiast globalnego
  // per-workspace scratchpada. Reaguje na zmianę `datasetId` (np. wybór innego
  // zestawu w liście w zakładce "Zestaw danych") ORAZ na przejście z
  // niewidocznego na widoczny (np. powrót na zakładkę po tym, jak graf tego
  // zestawu mógł zostać zmieniony gdzie indziej), żeby nigdy nie pokazywać
  // nieaktualnej kopii.
  $effect(() => {
    const id = datasetId;
    const becameVisible = visible && !wasVisible;
    wasVisible = visible;
    if (!id) return;
    if (id === loadedDatasetId && !becameVisible) return;
    if (!visible) return; // nie odświeżaj w tle niewidocznej zakładki
    loadGraphFor(id);
  });

  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  function persist() {
    if (readonly) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (datasetId) saveDatasetGraph(datasetId, graph);
      else wsSet(LS_GRAPH, graph);
    }, 300);
  }

  let container = $state<HTMLDivElement | null>(null);
  let viewport = $derived(graph.viewport);

  function setViewport(v: PreViewport) {
    graph = { ...graph, viewport: v };
    persist();
  }

  // Jak setViewport, ale bez zapisu — używane przez auto-dopasowanie widoku
  // przy wejściu na zestaw (fitAll), żeby samo OTWARCIE zestawu nie zamrażało
  // na stałe aktualnego (zrekonstruowanego z steps) grafu w rejestrze, zanim
  // użytkownik faktycznie coś zmieni.
  function setViewportSilent(v: PreViewport) {
    graph = { ...graph, viewport: v };
  }

  function screenToWorld(p: { x: number; y: number }): { x: number; y: number } {
    const rect = container?.getBoundingClientRect();
    const sx = p.x - (rect?.left ?? 0);
    const sy = p.y - (rect?.top ?? 0);
    return { x: (sx - viewport.x) / viewport.zoom, y: (sy - viewport.y) / viewport.zoom };
  }

  // ── Zoom / pan (ported math from BoardCanvas.svelte) ──────────────
  function onWheel(e: WheelEvent) {
    e.preventDefault();
    const rect = container?.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) {
      const pointer = { x: e.clientX - (rect?.left ?? 0), y: e.clientY - (rect?.top ?? 0) };
      const oldScale = viewport.zoom;
      const pointTo = { x: (pointer.x - viewport.x) / oldScale, y: (pointer.y - viewport.y) / oldScale };
      const dir = e.deltaY > 0 ? -1 : 1;
      const newScale = Math.max(0.2, Math.min(3, oldScale * (1 + dir * 0.08)));
      setViewport({
        zoom: newScale,
        x: pointer.x - pointTo.x * newScale,
        y: pointer.y - pointTo.y * newScale,
      });
    } else {
      setViewport({ ...viewport, x: viewport.x - e.deltaX, y: viewport.y - e.deltaY });
    }
  }

  let dotSpacingWorld = $derived.by(() => {
    let level = 26;
    while (level * viewport.zoom < 16) level *= 2;
    while (level * viewport.zoom > 42) level /= 2;
    return level;
  });
  const dotRadius = 1.3;

  // Rough node card height estimate (header + body), good enough for
  // frame-all bbox math — doesn't need to be pixel-perfect.
  function nodeHeight(node: PreNode): number {
    const def = NODE_TYPES[node.type];
    if (!def) return 60;
    let h = 30 + 20; // header + body padding
    if (def.detail) h += 22; // subtitle row
    h += def.params.length * 40;
    if (node.type === "output") h += 110; // "Realizuj" + zapis jako zestaw + wyniki
    if (node.type === "source_binned") h += 40; // dropdown zestawu danych
    return Math.max(h, 60);
  }

  function fitAll() {
    if (!container || graph.nodes.length === 0) return;
    const rect = container.getBoundingClientRect();
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of graph.nodes) {
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + nodeWidth(n));
      maxY = Math.max(maxY, n.y + nodeHeight(n));
    }
    const pad = 48;
    const contentW = Math.max(1, maxX - minX);
    const contentH = Math.max(1, maxY - minY);
    const availW = Math.max(1, rect.width - pad * 2);
    const availH = Math.max(1, rect.height - pad * 2);
    const zoom = Math.max(0.2, Math.min(2, Math.min(availW / contentW, availH / contentH)));
    // Bias slightly left so the leftmost (source) nodes stay clearly visible
    // rather than perfectly centered, per the desired default framing.
    // Silent: auto-fit-on-open must not persist a graph snapshot on its own —
    // only real user edits (drag/connect/param/manual pan-zoom) should.
    setViewportSilent({
      zoom,
      x: pad - minX * zoom,
      y: (rect.height - contentH * zoom) / 2 - minY * zoom,
    });
  }

  // The panel can be at 0×0 right when we want to fit (e.g. the tab was just
  // switched to / a different dataset just got bound and layout hasn't
  // settled yet, or the tab is currently hidden via CSS). Retry on the next
  // frame until the container actually has a real size, instead of fitting
  // against a zero-size box (which would produce a bogus zoom/pan).
  let fitPending = false;
  function queueFitAll() {
    fitPending = true;
    let attempts = 0;
    const tryFit = () => {
      if (!fitPending) return;
      attempts += 1;
      const rect = container?.getBoundingClientRect();
      if (rect && rect.width > 0 && rect.height > 0) {
        fitPending = false;
        fitAll();
      } else if (attempts < 120) {
        // Stays hidden (e.g. this tab isn't the active one) — give up polling;
        // becoming visible later re-triggers this via the datasetId/visible effect.
        requestAnimationFrame(tryFit);
      } else {
        fitPending = false;
      }
    };
    requestAnimationFrame(tryFit);
  }

  onMount(() => {
    queueFitAll();
  });

  // ── Node dragging ──────────────────────────────────────────────────
  let dragNodeId = $state<string | null>(null);
  let dragStart = { x: 0, y: 0 };
  let dragNodeOrigin = { x: 0, y: 0 };

  function onNodeHeaderPointerDown(e: PointerEvent, node: PreNode) {
    if (readonly) return;
    if ((e.target as HTMLElement).closest(".node-info, .node-menu-trigger")) return;
    e.stopPropagation();
    dragNodeId = node.id;
    dragStart = { x: e.clientX, y: e.clientY };
    dragNodeOrigin = { x: node.x, y: node.y };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }
  function onNodeHeaderPointerMove(e: PointerEvent) {
    if (!dragNodeId) return;
    const dx = (e.clientX - dragStart.x) / viewport.zoom;
    const dy = (e.clientY - dragStart.y) / viewport.zoom;
    const idx = graph.nodes.findIndex((n) => n.id === dragNodeId);
    if (idx === -1) return;
    graph.nodes[idx] = { ...graph.nodes[idx], x: dragNodeOrigin.x + dx, y: dragNodeOrigin.y + dy };
  }
  function onNodeHeaderPointerUp() {
    if (dragNodeId) persist();
    dragNodeId = null;
  }

  // ── Connections ──────────────────────────────────────────────────
  interface DragConn { nodeId: string; port: "in" | "out"; x: number; y: number; }
  let connDrag = $state<DragConn | null>(null);
  let cursorWorld = $state<{ x: number; y: number }>({ x: 0, y: 0 });

  // Node "Wynik" jest dwa razy szerszy — ma osobne sekcje Wyświetl/Zapisz.
  function nodeWidth(node: PreNode): number {
    return node.type === "output" ? 400 : 200;
  }

  function portPos(node: PreNode, port: "in" | "out"): { x: number; y: number } {
    const headerH = 30;
    return { x: node.x + (port === "in" ? 0 : nodeWidth(node)), y: node.y + headerH / 2 };
  }

  function onPortPointerDown(e: PointerEvent, node: PreNode, port: "in" | "out") {
    if (readonly) return;
    e.stopPropagation();
    if (port === "in") {
      // Blender-style: chwytanie za końcówkę JUŻ podłączonego wejścia odłącza
      // istniejące połączenie i zaczyna je ciągnąć od strony źródła (wyjścia)
      // — puszczenie w pustym miejscu po prostu je usuwa, puszczenie na innym
      // wejściu przełącza połączenie tam.
      const existing = graph.edges.find((e2) => e2.to === node.id);
      if (existing) {
        const sourceNode = graph.nodes.find((n) => n.id === existing.from);
        graph.edges = graph.edges.filter((e2) => e2.id !== existing.id);
        persist();
        if (sourceNode) {
          const sp = portPos(sourceNode, "out");
          connDrag = { nodeId: sourceNode.id, port: "out", x: sp.x, y: sp.y };
          return;
        }
      }
    }
    const p = portPos(node, port);
    connDrag = { nodeId: node.id, port, x: p.x, y: p.y };
  }

  function onCanvasPointerMove(e: PointerEvent) {
    cursorWorld = screenToWorld({ x: e.clientX, y: e.clientY });
    if (dragNodeId) onNodeHeaderPointerMove(e);
  }

  // Ports are tiny 12px circles — requiring the pointerup to land exactly on
  // one (the previous approach) made connecting nearly impossible, especially
  // once zoomed. Instead, resolve the nearest compatible port to the cursor
  // in world space within a generous radius, regardless of what DOM element
  // the pointerup actually fired on.
  // Radius is expressed in SCREEN pixels, then converted to world units by
  // dividing by zoom — otherwise, after the graph auto-fits to view (which
  // can zoom out well below 1x for larger chains), a fixed world-unit radius
  // shrinks to a few screen pixels and connecting/re-detecting an edge
  // becomes nearly impossible even though the ports look close together.
  const CONNECT_RADIUS_SCREEN = 26;
  function findNearestPort(pos: { x: number; y: number }, wantPort: "in" | "out", excludeNodeId: string) {
    let best: PreNode | null = null;
    let bestDist = CONNECT_RADIUS_SCREEN / viewport.zoom;
    for (const n of graph.nodes) {
      if (n.id === excludeNodeId) continue;
      const def = NODE_TYPES[n.type];
      if (!def) continue;
      if (wantPort === "in" && !def.hasInput) continue;
      if (wantPort === "out" && !def.hasOutput) continue;
      const p = portPos(n, wantPort);
      const d = Math.hypot(p.x - pos.x, p.y - pos.y);
      if (d < bestDist) {
        bestDist = d;
        best = n;
      }
    }
    return best;
  }

  function onPortPointerUp(e: PointerEvent) {
    e.stopPropagation();
    resolveConnection();
  }

  function onCanvasPointerUp() {
    resolveConnection();
    onNodeHeaderPointerUp();
  }

  function resolveConnection() {
    if (!connDrag) return;
    const wanted: "in" | "out" = connDrag.port === "out" ? "in" : "out";
    const target = findNearestPort(cursorWorld, wanted, connDrag.nodeId);
    if (target) finishConnection(connDrag, { nodeId: target.id, port: wanted });
    connDrag = null;
  }

  function finishConnection(a: DragConn, b: { nodeId: string; port: "in" | "out" }) {
    if (a.nodeId === b.nodeId) return; // no self-connect
    if (a.port === b.port) return; // must be in+out
    const fromId = a.port === "out" ? a.nodeId : b.nodeId;
    const toId = a.port === "in" ? a.nodeId : b.nodeId;
    // Input accepts only one incoming edge — remove existing first.
    graph.edges = graph.edges.filter((e) => e.to !== toId);
    graph.edges.push({ id: makeId("edge"), from: fromId, to: toId });
    persist();
  }

  function edgePath(from: { x: number; y: number }, to: { x: number; y: number }): string {
    const dx = Math.max(40, Math.abs(to.x - from.x) * 0.5);
    return `M ${from.x} ${from.y} C ${from.x + dx} ${from.y}, ${to.x - dx} ${to.y}, ${to.x} ${to.y}`;
  }

  function nodePos(id: string): PreNode | undefined {
    return graph.nodes.find((n) => n.id === id);
  }

  // ── Context menus ──────────────────────────────────────────────────
  let paletteOpen = $state(false);
  let palettePos = $state({ screen: { x: 0, y: 0 }, world: { x: 0, y: 0 } });
  let paletteFilter = $state("");
  // The palette's height is content-dependent (categories/results), so a
  // fixed height either wastes space or — right-clicking near the bottom
  // edge — overflows past the canvas. Clamp it to whatever room is actually
  // left below the click point (with a sensible minimum), instead of a
  // constant max-height.
  let paletteMaxHeight = $state(360);

  let nodeMenuOpen = $state(false);
  let nodeMenuTarget = $state<string | null>(null);
  let nodeMenuPos = $state({ x: 0, y: 0 });

  const MENU_MARGIN = 12;

  function onCanvasContextMenu(e: MouseEvent) {
    e.preventDefault();
    if (readonly) return;
    closeMenus();
    const rect = container?.getBoundingClientRect();
    const screenY = e.clientY - (rect?.top ?? 0);
    palettePos.screen = { x: e.clientX - (rect?.left ?? 0), y: screenY };
    palettePos.world = screenToWorld({ x: e.clientX, y: e.clientY });
    const available = (rect?.height ?? 600) - screenY - MENU_MARGIN;
    paletteMaxHeight = Math.max(140, Math.min(360, available));
    paletteFilter = "";
    paletteOpen = true;
  }

  function onNodeContextMenu(e: MouseEvent, node: PreNode) {
    e.preventDefault();
    e.stopPropagation();
    if (readonly) return;
    closeMenus();
    const rect = container?.getBoundingClientRect();
    nodeMenuPos = { x: e.clientX - (rect?.left ?? 0), y: e.clientY - (rect?.top ?? 0) };
    nodeMenuTarget = node.id;
    nodeMenuOpen = true;
  }

  function closeMenus() {
    paletteOpen = false;
    nodeMenuOpen = false;
  }

  function addNode(typeId: string) {
    const node: PreNode = {
      id: makeId("node"),
      type: typeId,
      x: palettePos.world.x,
      y: palettePos.world.y,
      params: defaultParams(typeId),
    };
    if (typeId === "source_binned") {
      // Bez zestawu wybranego domyślnie dropdown wyglądałby na pusty — wybierz
      // pierwszy dostępny (nie ma tu już niejawnej opcji "aktywny").
      node.datasetId = datasets().find((d) => d.id !== "original")?.id;
    }
    if (typeId === "mz_range" && nativeMzRange) {
      node.params = { ...node.params, mz_min: nativeMzRange.mz_min, mz_max: nativeMzRange.mz_max };
    }
    graph.nodes.push(node);
    persist();
    closeMenus();
  }

  let confirmDeleteOpen = $state(false);
  function requestDeleteNode() {
    nodeMenuOpen = false;
    confirmDeleteOpen = true;
  }
  function confirmDeleteNode() {
    const id = nodeMenuTarget;
    if (id) {
      graph.nodes = graph.nodes.filter((n) => n.id !== id);
      graph.edges = graph.edges.filter((e) => e.from !== id && e.to !== id);
      persist();
    }
    confirmDeleteOpen = false;
    nodeMenuTarget = null;
  }
  function cancelDeleteNode() {
    confirmDeleteOpen = false;
    nodeMenuTarget = null;
  }

  let hoveredNodeId = $state<string | null>(null);

  function onWindowKeydown(e: KeyboardEvent) {
    const target = e.target as HTMLElement | null;
    const typing = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA");
    if (e.key === "Escape") closeMenus();
    if (!typing && (e.key === "f" || e.key === "F")) {
      e.preventDefault();
      fitAll();
    }
    if (!typing && (e.key === "Delete" || e.key === "Backspace") && hoveredNodeId && !readonly) {
      e.preventDefault();
      nodeMenuTarget = hoveredNodeId;
      confirmDeleteOpen = true;
    }
  }

  let filteredTypes = $derived(
    NODE_TYPE_LIST.filter((t) => {
      const q = paletteFilter.trim().toLowerCase();
      if (!q) return true;
      return t.label.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q) ||
        (t.detail?.toLowerCase().includes(q) ?? false);
    })
  );

  function updateParam(node: PreNode, key: string, value: number | string) {
    if (readonly) return;
    const idx = graph.nodes.findIndex((n) => n.id === node.id);
    if (idx === -1) return;
    graph.nodes[idx] = { ...graph.nodes[idx], params: { ...graph.nodes[idx].params, [key]: value } };
    persist();
  }

  // ── Wynik (output node) — "Realizuj" runs the whole chain ─────────
  let runBusy = $state<string | null>(null);
  let runText = $state<Record<string, string>>({});

  function formatStepInfo(step: { info: Record<string, number> }): string {
    if ("n_peaks" in step.info) return `${step.info.n_peaks} pików`;
    if ("factor" in step.info) return `czynnik ×${step.info.factor}`;
    if ("baseline_max" in step.info) return `baseline max ${step.info.baseline_max}`;
    return "";
  }

  async function runOutputNode(node: PreNode) {
    const chain = buildChain(graph, node.id);
    if (!chain) {
      runText = { ...runText, [node.id]: "podłącz węzły aż do źródła danych" };
      return;
    }
    const pixels: { label: string; pixel: Pixel }[] = [];
    if (pixelLeft) pixels.push({ label: "Lewa", pixel: pixelLeft });
    if (pixelRight) pixels.push({ label: "Prawa", pixel: pixelRight });
    if (pixels.length === 0) {
      runText = { ...runText, [node.id]: "brak wybranego piksela" };
      return;
    }
    runBusy = node.id;
    try {
      const lines: string[] = [];
      for (const { label, pixel } of pixels) {
        const res = await fetchPreprocessChain(pixel.tissue, pixel.x, pixel.y, chain.source, chain.steps, chain.datasetId);
        const last = res.steps_applied[res.steps_applied.length - 1];
        const info = last ? formatStepInfo(last) : "";
        lines.push(`${label}: OK${info ? " — " + info : ""}`);
        onResult?.(label === "Lewa" ? "left" : "right", res);
      }
      runText = { ...runText, [node.id]: lines.join(" · ") };
    } catch (e) {
      runText = { ...runText, [node.id]: e instanceof Error ? e.message : String(e) };
    } finally {
      runBusy = null;
    }
  }

  // ── Zapisz jako zestaw danych — buduje pełny zestaw (WSZYSTKIE piksele
  // źródłowego zestawu, nie tylko podglądane 1-2), stosując łańcuch kroków
  // z tego node'a "Wynik". Dwa tryby (patrz `datasetId` prop):
  //  - datasetId ustawione (zakładka "Zestaw danych"): "Przebuduj zestaw"
  //    nadpisuje TEN SAM zestaw, od surowego imzML jeśli łańcuch zaczyna się
  //    od mz_range/bin_size, albo od innego istniejącego zestawu.
  //  - brak datasetId (podgląd w preWidma): stary tryb — zapis do nowego lub
  //    wskazanego zestawu, wymaga źródła "Dane przetworzone" (binned).
  let savingDataset = $state<string | null>(null);
  let saveDatasetName = $state<Record<string, string>>({});
  // "" = nowy zestaw (z saveDatasetName); w przeciwnym razie id istniejącego
  // zestawu do NADPISANIA (wybrany z dropdowna).
  let saveDatasetTarget = $state<Record<string, string>>({});
  let saveProgress = $state<Record<string, string>>({});
  let confirmRebuildNode = $state<PreNode | null>(null);

  function requestRebuildDataset(node: PreNode) {
    if (readonly) return;
    confirmRebuildNode = node;
  }
  function cancelRebuildDataset() {
    confirmRebuildNode = null;
  }
  async function confirmRebuildDataset() {
    const node = confirmRebuildNode;
    confirmRebuildNode = null;
    if (node) await rebuildDataset(node);
  }

  async function rebuildDataset(node: PreNode) {
    if (!datasetId) return;
    const chain = buildChain(graph, node.id);
    if (!chain) {
      saveProgress = { ...saveProgress, [node.id]: "podłącz węzły aż do źródła danych" };
      return;
    }
    const sourceId = chain.source === "raw" ? RAW_DATASET_ID : (chain.datasetId || activeDatasetId());
    const imzmlPath = chain.source === "raw" ? wsGet<string>("dane_imzmlPath", "") : undefined;
    savingDataset = node.id;
    saveProgress = { ...saveProgress, [node.id]: "budowanie…" };
    try {
      await buildPipelineDataset(datasetId, sourceId, chain.steps, (pct, msg) => {
        saveProgress = { ...saveProgress, [node.id]: `${pct}% ${msg}` };
      }, imzmlPath);
      saveProgress = { ...saveProgress, [node.id]: "✓ zestaw przebudowany" };
    } catch (e) {
      saveProgress = { ...saveProgress, [node.id]: e instanceof Error ? e.message : String(e) };
    } finally {
      savingDataset = null;
    }
  }

  async function saveOutputAsDataset(node: PreNode) {
    const chain = buildChain(graph, node.id);
    if (!chain) {
      saveProgress = { ...saveProgress, [node.id]: "podłącz węzły aż do źródła danych" };
      return;
    }
    const sourceId = chain.source === "raw" ? RAW_DATASET_ID : (chain.datasetId || activeDatasetId());
    const imzmlPath = chain.source === "raw" ? wsGet<string>("dane_imzmlPath", "") : undefined;
    const overwriteId = saveDatasetTarget[node.id] || "";
    savingDataset = node.id;
    saveProgress = { ...saveProgress, [node.id]: "budowanie…" };
    try {
      let targetId = overwriteId;
      let targetName = datasets().find((d) => d.id === overwriteId)?.name ?? "";
      if (!targetId) {
        const name = (saveDatasetName[node.id] || "").trim();
        if (!name) { savingDataset = null; return; }
        const ds = await createDataset(name, "pipeline");
        targetId = ds.id;
        targetName = name;
      }
      await buildPipelineDataset(targetId, sourceId, chain.steps, (pct, msg) => {
        saveProgress = { ...saveProgress, [node.id]: `${pct}% ${msg}` };
      }, imzmlPath);
      saveProgress = { ...saveProgress, [node.id]: `✓ zapisano jako "${targetName}"` };
      saveDatasetName = { ...saveDatasetName, [node.id]: "" };
    } catch (e) {
      saveProgress = { ...saveProgress, [node.id]: e instanceof Error ? e.message : String(e) };
    } finally {
      savingDataset = null;
    }
  }

</script>

<svelte:window onkeydown={onWindowKeydown} />

<div
  bind:this={container}
  class="prenodes-canvas"
  style="
    background-position: {viewport.x}px {viewport.y}px;
    background-size: {dotSpacingWorld * viewport.zoom}px {dotSpacingWorld * viewport.zoom}px;
    background-image: radial-gradient(rgba(255,255,255,0.16) {dotRadius}px, transparent {dotRadius}px);
  "
  onwheel={onWheel}
  oncontextmenu={onCanvasContextMenu}
  onpointermove={onCanvasPointerMove}
  onpointerup={onCanvasPointerUp}
  onpointerdown={closeMenus}
  role="application"
  aria-label="Edytor grafu preprocessingu"
>
  <div class="prenodes-content" style="transform: translate({viewport.x}px, {viewport.y}px) scale({viewport.zoom});">

    <!-- Edges -->
    <svg class="edges-layer">
      {#each graph.edges as edge (edge.id)}
        {@const fromNode = nodePos(edge.from)}
        {@const toNode = nodePos(edge.to)}
        {#if fromNode && toNode}
          <path d={edgePath(portPos(fromNode, "out"), portPos(toNode, "in"))}
                stroke="rgba(255,201,81,0.55)" stroke-width="2" fill="none" />
        {/if}
      {/each}
      {#if connDrag}
        <path d={edgePath({ x: connDrag.x, y: connDrag.y }, cursorWorld)}
              stroke="rgba(255,201,81,0.4)" stroke-width="2" fill="none" stroke-dasharray="4 3" />
      {/if}
    </svg>

    <!-- Nodes -->
    {#each graph.nodes as node (node.id)}
      {@const def = NODE_TYPES[node.type]}
      {#if def}
        <div class="pnode" class:pnode-disabled={def.category === "preprocessing" && node.enabled === false}
             style="left:{node.x}px; top:{node.y}px; width:{nodeWidth(node)}px;"
             oncontextmenu={(e) => onNodeContextMenu(e, node)}
             onpointerenter={() => (hoveredNodeId = node.id)}
             onpointerleave={() => (hoveredNodeId = null)}>
          <div class="pnode-header"
               onpointerdown={(e) => onNodeHeaderPointerDown(e, node)}
               onpointerup={onNodeHeaderPointerUp}>
            <span class="pnode-title">{def.label}</span>
            {#if def.category === "preprocessing"}
              <button class="node-eye-btn" class:off={node.enabled === false}
                      title={node.enabled === false ? "Wygaszony — dane przechodzą bez zmian" : "Aktywny — kliknij aby wygasić"}
                      onpointerdown={(e) => e.stopPropagation()}
                      onclick={() => toggleNodeEnabled(node)}></button>
            {/if}
            <span class="node-info" tabindex="0" role="note">
              <span class="node-info-icon">i</span>
              <span class="node-info-tip">{def.description}</span>
            </span>
          </div>

          {#if def.detail}
            <div class="pnode-subtitle">{def.detail}</div>
          {/if}

          <div class="pnode-body">
            {#if node.type === "source_binned"}
              <label class="field">
                <span>Zestaw danych</span>
                <select class="ds-select"
                        value={node.datasetId ?? ""}
                        onpointerdown={(e) => e.stopPropagation()}
                        onchange={(e) => setNodeDataset(node, (e.target as HTMLSelectElement).value)}>
                  {#each datasets().filter((d) => d.id !== "original") as d}
                    <option value={d.id}>{d.name}</option>
                  {/each}
                </select>
              </label>
            {/if}
            {#each def.params as p (p.key)}
              <label class="field">
                {#if p.options}
                  <span>{p.label}</span>
                  <select class="ds-select"
                          value={node.params[p.key] ?? p.default}
                          onpointerdown={(e) => e.stopPropagation()}
                          onchange={(e) => updateParam(node, p.key, (e.target as HTMLSelectElement).value)}>
                    {#each p.options as opt}
                      <option value={opt}>{opt}</option>
                    {/each}
                  </select>
                {:else}
                  {@const pMin = effectiveMin(node.type, p)}
                  {@const pMax = effectiveMax(node.type, p)}
                  <span class="field-head">
                    <input type="text" inputmode="decimal" class="param-value-input"
                           value={node.params[p.key] ?? p.default}
                           readonly={readonly}
                           onpointerdown={(e) => e.stopPropagation()}
                           onchange={(e) => {
                             const raw = Number((e.target as HTMLInputElement).value.replace(',', '.'));
                             if (Number.isNaN(raw)) { (e.target as HTMLInputElement).value = String(node.params[p.key] ?? p.default); return; }
                             const clamped = Math.min(pMax ?? raw, Math.max(pMin ?? raw, raw));
                             updateParam(node, p.key, clamped);
                             (e.target as HTMLInputElement).value = String(clamped);
                           }}
                           onkeydown={(e) => {
                             if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                             if (e.key === "Escape") {
                               (e.target as HTMLInputElement).value = String(node.params[p.key] ?? p.default);
                               (e.target as HTMLInputElement).blur();
                             }
                           }} />
                    <span>{p.label}</span>
                  </span>
                  <input type="range" min={pMin} max={pMax} step={p.step}
                         value={node.params[p.key] ?? p.default}
                         disabled={readonly}
                         onpointerdown={(e) => e.stopPropagation()}
                         oninput={(e) => updateParam(node, p.key, Number((e.target as HTMLInputElement).value))} />
                {/if}
              </label>
            {/each}

            {#if node.type === "output"}
              <div class="output-columns">
                <!-- Wyświetl — wymaga wybranego piksela, tylko podgląd na wykresach -->
                <div class="output-col" onpointerdown={(e) => e.stopPropagation()}>
                  <span class="output-col-title">Wyświetl</span>
                  <button class="run-btn" disabled={runBusy === node.id}
                          onclick={() => runOutputNode(node)}>
                    {runBusy === node.id ? "Wyświetlanie…" : "Wyświetl"}
                  </button>
                  {#if runText[node.id]}
                    <span class="preview-result">{runText[node.id]}</span>
                  {/if}
                </div>

                <!-- Zapisz — cała tkanka, wszystkie piksele, bez wymogu wybranego piksela -->
                <div class="output-col" onpointerdown={(e) => e.stopPropagation()}>
                  {#if readonly}
                    <span class="output-col-title">Przebuduj zestaw</span>
                    <span class="preview-result">Zestaw "Oryginalny" jest chroniony — nie można go nadpisać.</span>
                  {:else if datasetId}
                    <span class="output-col-title">Przebuduj zestaw</span>
                    <span class="save-warning">⚠ nadpisze dane bieżącego zestawu</span>
                    <button class="run-btn save-btn"
                            disabled={savingDataset === node.id}
                            onclick={() => requestRebuildDataset(node)}>
                      {#if savingDataset === node.id}
                        <span class="spin"></span> Przebudowywanie…
                      {:else}
                        Przebuduj (cała tkanka)
                      {/if}
                    </button>
                  {:else}
                    <span class="output-col-title">Zapisz</span>
                    <select class="ds-select"
                            value={saveDatasetTarget[node.id] ?? ""}
                            onchange={(e) => saveDatasetTarget = { ...saveDatasetTarget, [node.id]: (e.target as HTMLSelectElement).value }}>
                      <option value="">+ nowy zestaw…</option>
                      {#each datasets().filter((d) => d.id !== "original") as d}
                        <option value={d.id}>nadpisz: {d.name}</option>
                      {/each}
                    </select>
                    {#if !saveDatasetTarget[node.id]}
                      <input class="save-dataset-input" type="text" placeholder="nazwa nowego zestawu…"
                             value={saveDatasetName[node.id] ?? ""}
                             oninput={(e) => saveDatasetName = { ...saveDatasetName, [node.id]: (e.target as HTMLInputElement).value }} />
                    {:else}
                      <span class="save-warning">⚠ nadpisze zestaw "{datasets().find((d) => d.id === saveDatasetTarget[node.id])?.name}"</span>
                    {/if}
                    <button class="run-btn save-btn"
                            disabled={savingDataset === node.id || (!saveDatasetTarget[node.id] && !(saveDatasetName[node.id] ?? "").trim())}
                            onclick={() => saveOutputAsDataset(node)}>
                      {#if savingDataset === node.id}
                        <span class="spin"></span> Zapisywanie…
                      {:else}
                        Zapisz (cała tkanka)
                      {/if}
                    </button>
                  {/if}
                  {#if saveProgress[node.id]}
                    <span class="preview-result">{saveProgress[node.id]}</span>
                  {/if}
                </div>
              </div>
            {/if}
          </div>

          {#if def.hasInput}
            <div class="port port-in" title="wejście"
                 onpointerdown={(e) => onPortPointerDown(e, node, "in")}
                 onpointerup={onPortPointerUp}></div>
          {/if}
          {#if def.hasOutput}
            <div class="port port-out" title="wyjście"
                 onpointerdown={(e) => onPortPointerDown(e, node, "out")}
                 onpointerup={onPortPointerUp}></div>
          {/if}
        </div>
      {/if}
    {/each}
  </div>

  {#if paletteOpen}
    <div class="ctx-menu palette" style="left:{palettePos.screen.x}px; top:{palettePos.screen.y}px; max-height:{paletteMaxHeight}px;"
         onpointerdown={(e) => e.stopPropagation()}
         onwheel={(e) => e.stopPropagation()}>
      <input class="ctx-filter" type="text" placeholder="Szukaj node'a…" bind:value={paletteFilter} autofocus />
      <div class="ctx-list">
        {#each CATEGORY_ORDER as cat (cat)}
          {@const items = filteredTypes.filter((t) => t.category === cat)}
          {#if items.length > 0}
            <div class="ctx-cat">{CATEGORY_LABELS[cat]}</div>
            {#each items as t (t.id)}
              <button class="ctx-item" onclick={() => addNode(t.id)}>
                <span class="ctx-item-label">{t.label}</span>
                <span class="ctx-item-desc">{t.description}</span>
              </button>
            {/each}
          {/if}
        {/each}
        {#if filteredTypes.length === 0}
          <div class="ctx-empty">brak wyników</div>
        {/if}
      </div>
    </div>
  {/if}

  {#if nodeMenuOpen}
    <div class="ctx-menu node-menu" style="left:{nodeMenuPos.x}px; top:{nodeMenuPos.y}px;"
         onpointerdown={(e) => e.stopPropagation()}>
      <button class="ctx-item danger" onclick={requestDeleteNode}>Usuń</button>
    </div>
  {/if}
</div>

<ConfirmModal
  open={confirmDeleteOpen}
  title="Usuń node"
  message="Czy na pewno chcesz usunąć ten node?"
  confirmLabel="Usuń"
  danger
  onconfirm={confirmDeleteNode}
  oncancel={cancelDeleteNode}
/>

<ConfirmModal
  open={confirmRebuildNode !== null}
  title="Przebuduj zestaw"
  message="Przebudowanie nadpisze dane bieżącego zestawu (wszystkie piksele, wszystkie tkanki) — tej operacji nie da się cofnąć."
  confirmLabel="Przebuduj"
  danger
  onconfirm={confirmRebuildDataset}
  oncancel={cancelRebuildDataset}
/>

<style>
  .prenodes-canvas {
    position: relative;
    width: 100%;
    height: 100%;
    overflow: hidden;
    background-color: #1a1a1a;
    border-radius: 10px;
    border: 1px solid rgba(255,255,255,0.07);
    cursor: default;
    touch-action: none;
  }

  .prenodes-content {
    position: absolute;
    left: 0; top: 0;
    transform-origin: 0 0;
  }

  .edges-layer {
    /* No viewBox is set, so this SVG's internal coordinate system is 1:1
       with its own box. Previously the box was offset -100000px with a
       200000px size, but paths were drawn in raw (unshifted) world
       coordinates — putting every edge 100000 world units away from where
       it was actually meant to render, i.e. completely invisible. Instead,
       keep the box at the content's own origin (0,0) and let `overflow:
       visible` draw paths (including negative coordinates) outside its
       nominal 1×1 box — a standard trick, well supported cross-browser. */
    position: absolute;
    left: 0; top: 0;
    width: 1px; height: 1px;
    overflow: visible;
    pointer-events: none;
  }
  .edges-layer path { pointer-events: none; }

  .pnode {
    position: absolute;
    background: #222;
    border: 1px solid rgba(255,255,255,0.09);
    border-radius: 10px;
    box-shadow: 0 4px 16px rgba(0,0,0,0.35);
    user-select: none;
    transition: opacity 0.15s;
  }

  /* Wygaszony node preprocessingu — dane przechodzą bez zmian (pass-through). */
  .pnode-disabled { opacity: 0.45; }

  /* Ikona oczka (widoczny/wygaszony) — ta sama elipsa co .vis-btn w Widma.svelte. */
  .node-eye-btn {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 16px;
    padding: 0;
    background: none;
    border: none;
    cursor: pointer;
  }
  .node-eye-btn::before {
    content: "";
    display: inline-block;
    width: 12px;
    height: 6px;
    border-radius: 3px;
    background: rgba(255,255,255,0.45);
    transition: background 0.15s;
  }
  .node-eye-btn.off::before {
    background: transparent;
    border: 1px solid rgba(255,255,255,0.18);
  }
  .node-eye-btn:hover::before { background: rgba(255,201,81,0.7); }
  .node-eye-btn.off:hover::before { border-color: rgba(255,255,255,0.5); }

  .pnode-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    padding: 6px 8px;
    height: 30px;
    box-sizing: border-box;
    border-bottom: 1px solid rgba(255,255,255,0.07);
    cursor: grab;
    border-radius: 10px 10px 0 0;
  }
  .pnode-header:active { cursor: grabbing; }

  .pnode-title {
    font-size: 0.68rem;
    font-weight: 700;
    color: #f0f0f0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .node-info {
    position: relative;
    flex-shrink: 0;
    display: inline-flex;
  }
  .node-info-icon {
    width: 14px; height: 14px;
    border-radius: 50%;
    background: rgba(255,255,255,0.12);
    color: rgba(255,255,255,0.6);
    font-size: 0.6rem;
    font-style: italic;
    font-weight: 700;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: help;
  }
  .node-info-tip {
    display: none;
    position: absolute;
    right: 0;
    top: 18px;
    width: 180px;
    background: #1a1a1a;
    border: 1px solid rgba(255,255,255,0.12);
    border-radius: 8px;
    padding: 8px 10px;
    font-size: 0.65rem;
    line-height: 1.4;
    color: rgba(255,255,255,0.7);
    z-index: 50;
    box-shadow: 0 8px 24px rgba(0,0,0,0.5);
  }
  .node-info:hover .node-info-tip,
  .node-info:focus .node-info-tip { display: block; }

  .pnode-subtitle {
    padding: 4px 8px;
    font-size: 0.62rem;
    color: rgba(255,255,255,0.45);
    border-bottom: 1px solid rgba(255,255,255,0.07);
  }

  .pnode-body {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 3px;
    font-size: 0.68rem;
    color: rgba(255,255,255,0.6);
  }

  .field-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
  }

  .param-value-input {
    width: 44px;
    flex-shrink: 0;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 4px;
    color: #e0e0e0;
    font-size: 0.66rem;
    font-family: inherit;
    padding: 2px 5px;
    text-align: left;
    transition: background 0.12s, border-color 0.12s;
    box-sizing: border-box;
  }
  .param-value-input:hover:not([readonly]) { background: rgba(255,255,255,0.05); border-color: rgba(255,255,255,0.12); }
  .param-value-input:focus { background: rgba(255,255,255,0.05); border-color: rgba(255,201,81,0.4); outline: none; }
  .param-value-input[readonly] { opacity: 0.6; cursor: default; }

  .output-columns {
    display: flex;
    gap: 10px;
  }

  .output-col {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .output-col-title {
    font-size: 0.62rem;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: rgba(255,255,255,0.35);
  }

  .spin {
    display: inline-block;
    width: 9px; height: 9px;
    border: 1.5px solid rgba(126,200,227,0.3);
    border-top-color: #7ec8e3;
    border-radius: 50%;
    animation: pn-spin 0.7s linear infinite;
  }
  @keyframes pn-spin { to { transform: rotate(360deg); } }

  .run-btn {
    width: 100%;
    background: rgba(255,201,81,0.12);
    border: 1px solid rgba(255,201,81,0.4);
    border-radius: 6px;
    color: #ffc951;
    font-size: 0.68rem;
    font-weight: 700;
    padding: 6px 8px;
    cursor: pointer;
    font-family: inherit;
  }
  .run-btn:hover:not(:disabled) { background: rgba(255,201,81,0.2); }
  .run-btn:disabled { opacity: 0.5; cursor: not-allowed; }

  .preview-result {
    font-size: 0.62rem;
    color: rgba(255,255,255,0.45);
  }

  /* Jednolity styl dropdownów zestawów danych — jak .tissue-select w PixelMapPanel. */
  .ds-select {
    width: 100%;
    appearance: none; -webkit-appearance: none; -moz-appearance: none;
    background: #1a1a1a
      url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 6'><path d='M1 1l4 4 4-4' stroke='%23ffc951' stroke-width='1.4' fill='none' stroke-linecap='round' stroke-linejoin='round'/></svg>")
      no-repeat right 6px center;
    background-size: 8px 5px;
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 5px;
    color: #e0e0e0;
    font-size: 0.65rem;
    padding: 3px 18px 3px 5px;
    font-family: inherit;
    cursor: pointer;
    outline: none;
    box-sizing: border-box;
    transition: border-color 0.15s, color 0.15s;
  }
  .ds-select:hover  { border-color: rgba(255,201,81,0.3); color: #ffc951; }
  .ds-select option { background: #1a1a1a; color: #e0e0e0; }

  .save-dataset-row {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-top: 6px;
  }

  .save-dataset-input {
    width: 100%;
    background: rgba(255,255,255,0.05);
    border: 1px solid rgba(255,255,255,0.12);
    border-radius: 5px;
    color: #e0e0e0;
    font-size: 0.65rem;
    font-family: inherit;
    padding: 4px 6px;
    box-sizing: border-box;
  }

  .save-btn {
    background: rgba(126,200,227,0.12);
    border-color: rgba(126,200,227,0.4);
    color: #7ec8e3;
  }
  .save-btn:hover:not(:disabled) { background: rgba(126,200,227,0.2); }

  .save-warning {
    font-size: 0.6rem;
    color: #ffc951;
    line-height: 1.3;
  }

  /* Port colors are intentional: #7ec8e3 (secondary accent) marks inputs,
     #ffc951 (primary accent) marks outputs — matching existing app
     semantics for "secondary" vs "primary/active" elements. */
  .port {
    position: absolute;
    width: 12px; height: 12px;
    border-radius: 50%;
    /* Anchor point used for edge math (portPos) is node.y + headerH/2 = 15px.
       That's the circle's CENTER, so the CSS top (circle's top edge) must be
       15px minus half the circle's own height, not 15px itself. */
    top: 9px;
    border: 2px solid #1a1a1a;
    cursor: crosshair;
    z-index: 5;
  }
  .port-in { left: -6px; background: #7ec8e3; }
  .port-out { right: -6px; background: #ffc951; }

  .ctx-menu {
    position: absolute;
    background: #262626;
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 8px;
    box-shadow: 0 12px 32px rgba(0,0,0,0.5);
    z-index: 100;
    min-width: 220px;
    overflow: hidden;
  }

  .ctx-menu.palette {
    display: flex;
    flex-direction: column;
    /* max-height is set inline per open (clamped to available space below
       the click point) so the menu never spills past the canvas edge. */
  }

  .ctx-filter {
    flex-shrink: 0;
    width: 100%;
    box-sizing: border-box;
    background: #1a1a1a;
    border: none;
    border-bottom: 1px solid rgba(255,255,255,0.08);
    color: #e0e0e0;
    font-size: 0.72rem;
    padding: 7px 10px;
    font-family: inherit;
    outline: none;
  }

  .ctx-list {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }

  .ctx-item {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    width: 100%;
    box-sizing: border-box;
    background: transparent;
    border: none;
    text-align: left;
    padding: 7px 10px;
    cursor: pointer;
    font-family: inherit;
  }
  .ctx-cat {
    padding: 7px 10px 5px;
    margin-top: 4px;
    font-size: 0.63rem;
    font-weight: 700;
    letter-spacing: 0.09em;
    text-transform: uppercase;
    color: #ffc951;
    background: rgba(255,201,81,0.07);
    border-top: 1px solid rgba(255,255,255,0.08);
    border-bottom: 1px solid rgba(255,255,255,0.08);
  }
  .ctx-cat:first-child { margin-top: 0; border-top: none; }
  .ctx-item:hover { background: rgba(255,255,255,0.06); }
  .ctx-item-label { font-size: 0.72rem; color: #e0e0e0; }
  .ctx-item-desc { font-size: 0.62rem; color: rgba(255,255,255,0.4); }
  .ctx-item.danger { color: #ff6b6b; font-size: 0.72rem; }

  .ctx-empty {
    padding: 10px;
    font-size: 0.68rem;
    color: rgba(255,255,255,0.35);
  }

  /* ── Sliders — same styling as BoardSidebar.svelte ── */
  input[type="range"] {
    -webkit-appearance: none;
    appearance: none;
    width: 100%;
    height: 16px;
    background: transparent;
    outline: none;
    border: none;
    padding: 0;
    margin: 0;
    cursor: pointer;
  }
  input[type="range"]::-webkit-slider-runnable-track {
    background: rgba(255,255,255,0.1);
    border-radius: 3px;
    height: 6px;
  }
  input[type="range"]::-moz-range-track {
    background: rgba(255,255,255,0.1);
    border-radius: 3px;
    height: 6px;
  }
  input[type="range"]::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 16px; height: 16px;
    border-radius: 50%;
    background: #ffc951;
    border: 2px solid #1a1a1a;
    box-shadow: 0 1px 6px rgba(0,0,0,0.5);
    cursor: pointer;
    margin-top: -5px;
    transition: transform 0.1s, box-shadow 0.1s;
  }
  input[type="range"]::-webkit-slider-thumb:hover {
    transform: scale(1.15);
    box-shadow: 0 0 0 4px rgba(255,201,81,0.2);
  }
  input[type="range"]::-moz-range-thumb {
    width: 16px; height: 16px;
    border-radius: 50%;
    background: #ffc951;
    border: 2px solid #1a1a1a;
    cursor: pointer;
  }
</style>
