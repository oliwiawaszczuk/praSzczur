<script lang="ts">
  import { onMount } from "svelte";
  import { wsGet, wsSet } from "$lib/workspace.svelte";
  import ConfirmModal from "$lib/ConfirmModal.svelte";
  import DualRange from "$lib/DualRange.svelte";
  import CurveEditor from "$lib/CurveEditor.svelte";
  import IonCanvas from "$lib/IonCanvas.svelte";
  import PixelMapZoomModal from "$lib/PixelMapZoomModal.svelte";
  import SegLabelCanvas from "$lib/SegLabelCanvas.svelte";
  import type { TissueImage } from "$lib/api.js";
  import { maxOf, combineMasks } from "$lib/tissueMerge";
  import {
    savedMapsList, loadSavedMaps, savedMapsLoaded, fetchSavedMapData, savePixelMap,
    type SavedPixelMap, type SavedPixelMapMode,
  } from "$lib/savedPixelMaps.svelte";
  import {
    NODE_TYPES, nodeTypeList, defaultGraph, defaultParamsFor, makeId, evaluateGraphNode, wouldCreateCycle,
    PORT_KIND_COLORS, DOMAIN_ORDER, DOMAIN_LABELS, STAGE_ORDER, STAGE_LABELS, DEFAULT_CURVE_POINTS,
    type Graph, type GraphNode, type GraphEdge, type GraphViewport, type PortKind, type PortSocketDef,
    type MapaValue, type CurvePoint, type EvalOutcome, type NodeTypeDef,
  } from "$lib/nodegraph";
  import { COMBINE_MODE_LABELS, COMBINE_MODE_LIST, computeHistogram, type CombineModeExt } from "$lib/nodegraph.mapa";
  import { SEG_PALETTE, runKmeans } from "$lib/nodegraph.segmentacja";
  // rejestrują swoje typy węzłów przy imporcie (side-effect na moduł) — muszą
  // być zaimportowane choćby raz, żeby NODE_TYPES nie był pusty. Domena Widmo
  // (preprocessing widm) świadomie nie istnieje tu jeszcze — patrz
  // docs/node-graph.md, sekcja "świadomie poza zakresem".
  import "$lib/nodegraph.mapa";
  import "$lib/nodegraph.segmentacja";

  interface Props {
    /** Czy ta zakładka jest aktualnie widoczna — pozwala przeliczyć auto-fit
     * widoku dopiero gdy faktycznie stanie się widoczna. */
    visible?: boolean;
  }
  let { visible = true }: Props = $props();

  onMount(async () => { if (!savedMapsLoaded()) await loadSavedMaps(); });

  const LS_GRAPH = "nodegraph_graph";
  const LS_SIDEBAR = "nodegraph_sidebarOpen";
  const SIDEBAR_WIDTH = 220;

  function sanitize(g: Graph): Graph {
    if (!g.nodes) g.nodes = [];
    if (!g.edges) g.edges = [];
    if (!g.viewport) g.viewport = { x: 0, y: 0, zoom: 1 };
    return g;
  }

  let graph = $state<Graph>(sanitize(wsGet<Graph>(LS_GRAPH, defaultGraph())));

  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  function persist() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { wsSet(LS_GRAPH, graph); }, 300);
  }

  // ── Panel node'ów (prawy sidebar) ───────────────────────────────────
  let sidebarOpen = $state(wsGet(LS_SIDEBAR, true));
  $effect(() => { wsSet(LS_SIDEBAR, sidebarOpen); });

  let groupedNodeTypes = $derived.by(() => {
    const groups: { domain: string; label: string; stages: { label: string; items: NodeTypeDef[] }[] }[] = [];
    for (const dom of DOMAIN_ORDER) {
      const domItems = nodeTypeList().filter((t) => t.domain === dom);
      if (domItems.length === 0) continue;
      const stages = STAGE_ORDER
        .map((st) => ({ label: STAGE_LABELS[st], items: domItems.filter((t) => t.stage === st) }))
        .filter((s) => s.items.length > 0);
      groups.push({ domain: dom, label: DOMAIN_LABELS[dom], stages });
    }
    return groups;
  });

  function nodeTypeDotColor(t: NodeTypeDef): string {
    const kind = t.outputs[0]?.kind ?? t.inputs[0]?.kind;
    return kind ? PORT_KIND_COLORS[kind] : "rgba(255,255,255,0.3)";
  }

  // Przeciąganie z sidebara na płótno — celowo NIE natywne HTML5 drag'n'drop
  // (dataTransfer/draggable), bo jest zawodne w WKWebView pod Tauri (drop
  // czasem po prostu nie odpala). Zamiast tego to ten sam mechanizm co drag
  // node'a/marquee: pointerdown na elemencie startuje "przeciąganie", globalne
  // pointermove/pointerup na window śledzą kursor niezależnie od tego, nad
  // czym aktualnie jest (sidebar → płótno), z widoczną "duszkiem" pod kursorem.
  let paletteDrag = $state<{ typeId: string; label: string; x: number; y: number } | null>(null);

  function onSidebarItemPointerDown(e: PointerEvent, t: NodeTypeDef) {
    e.preventDefault();
    paletteDrag = { typeId: t.id, label: t.label, x: e.clientX, y: e.clientY };
    window.addEventListener("pointermove", onPaletteDragMove);
    window.addEventListener("pointerup", onPaletteDragUp);
  }

  function onPaletteDragMove(e: PointerEvent) {
    if (!paletteDrag) return;
    paletteDrag = { ...paletteDrag, x: e.clientX, y: e.clientY };
  }

  function onPaletteDragUp(e: PointerEvent) {
    window.removeEventListener("pointermove", onPaletteDragMove);
    window.removeEventListener("pointerup", onPaletteDragUp);
    if (!paletteDrag) return;
    const rect = container?.getBoundingClientRect();
    if (rect && e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom) {
      addNode(paletteDrag.typeId, screenToWorld({ x: e.clientX, y: e.clientY }));
    }
    paletteDrag = null;
  }

  // ── Dane zapisanych map — pełne 2D array wczytywane leniwie per node ─────
  let mapData = $state<Record<string, SavedPixelMap>>({});
  let loadingIds = $state<Set<string>>(new Set());

  async function ensureMapLoaded(id: string | undefined) {
    if (!id || mapData[id] || loadingIds.has(id)) return;
    loadingIds = new Set(loadingIds).add(id);
    try {
      const full = await fetchSavedMapData(id);
      mapData = { ...mapData, [id]: full };
    } catch {
      // pomiń — node pokaże błąd "wybrana mapa została usunięta" / "wczytywanie…"
    } finally {
      const next = new Set(loadingIds);
      next.delete(id);
      loadingIds = next;
    }
  }

  $effect(() => {
    for (const n of graph.nodes) {
      if (n.type === "mapa/map_source") ensureMapLoaded(n.savedMapId);
    }
  });

  function savedMapExists(id: string): boolean {
    return savedMapsList().some((m) => m.id === id);
  }

  function evalNode(nodeId: string): EvalOutcome {
    return evaluateGraphNode(graph, nodeId, { mapCache: mapData, savedMapExists });
  }

  function resultTissue(r: MapaValue): TissueImage {
    return { label: r.tissueLabel || r.tissueId, data: r.data, mask: r.mask, width: r.width, height: r.height, vmax: maxOf(r.data) };
  }

  let zoomTissue = $state<TissueImage | null>(null);

  const savedMapModeLabel: Record<string, string> = { ...COMBINE_MODE_LABELS, single: "pojedyncza", segment: "segment" };

  // ── Pan / zoom ───────────────────────────────────────────────────────
  let container = $state<HTMLDivElement | null>(null);
  let viewport = $derived(graph.viewport);

  function setViewport(v: GraphViewport) {
    graph = { ...graph, viewport: v };
    persist();
  }
  function setViewportSilent(v: GraphViewport) {
    graph = { ...graph, viewport: v };
  }

  function screenToWorld(p: { x: number; y: number }): { x: number; y: number } {
    const rect = container?.getBoundingClientRect();
    const sx = p.x - (rect?.left ?? 0);
    const sy = p.y - (rect?.top ?? 0);
    return { x: (sx - viewport.x) / viewport.zoom, y: (sy - viewport.y) / viewport.zoom };
  }

  /** Jak screenToWorld, ale wejście jest już współrzędną względną kontenera
   * (tak jak przechowuje ją zaznaczanie prostokątem — patrz marqueeStartScreen). */
  function containerRelToWorld(p: { x: number; y: number }): { x: number; y: number } {
    return { x: (p.x - viewport.x) / viewport.zoom, y: (p.y - viewport.y) / viewport.zoom };
  }

  function onWheel(e: WheelEvent) {
    e.preventDefault();
    const rect = container?.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) {
      const pointer = { x: e.clientX - (rect?.left ?? 0), y: e.clientY - (rect?.top ?? 0) };
      const oldScale = viewport.zoom;
      const pointTo = { x: (pointer.x - viewport.x) / oldScale, y: (pointer.y - viewport.y) / oldScale };
      const dir = e.deltaY > 0 ? -1 : 1;
      const newScale = Math.max(0.2, Math.min(3, oldScale * (1 + dir * 0.08)));
      setViewport({ zoom: newScale, x: pointer.x - pointTo.x * newScale, y: pointer.y - pointTo.y * newScale });
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

  function outputKind(node: GraphNode): PortKind | undefined {
    return NODE_TYPES[node.type]?.outputs[0]?.kind;
  }

  function nodeWidth(node: GraphNode): number {
    if (node.type === "mapa/map_source") return 240;
    if (node.type === "mapa/combine") return 240;
    if (node.type === "mapa/save_output") return 230;
    if (node.type === "mapa/curve") return 230;
    if (node.type === "segmentacja/kmeans") return 250;
    if (node.type === "segmentacja/select_segments") return 230;
    return 210;
  }

  const PREVIEW_MIN_H = 90;
  const PREVIEW_MAX_H = 320;
  function previewHeight(node: GraphNode): number {
    const outcome = evalNode(node.id);
    const w = nodeWidth(node) - 20;
    if (outcome.ok && "width" in outcome.value && outcome.value.width > 0 && outcome.value.height > 0) {
      const ratio = outcome.value.height / outcome.value.width;
      return Math.max(PREVIEW_MIN_H, Math.min(PREVIEW_MAX_H, Math.round(w * ratio)));
    }
    return 130;
  }

  function inputsFor(node: GraphNode, socketId: string): GraphEdge[] {
    return graph.edges.filter((e) => e.to === node.id && e.toSocket === socketId);
  }

  function nodeHeight(node: GraphNode): number {
    let h = 30 + 20; // header + body padding
    if (node.type === "mapa/map_source") {
      h += 30 + 22;
      if (node.expanded) h += 90;
    } else if (node.type === "mapa/intensity_range") {
      h += 50;
    } else if (node.type === "mapa/curve") {
      h += 110 + 20;
    } else if (node.type === "mapa/combine") {
      h += 34 + Math.max(1, inputsFor(node, "in").length) * 24;
    } else if (node.type === "mapa/save_output") {
      h += 30 + 34 + 16;
    } else if (node.type === "segmentacja/kmeans") {
      h += 40;
      h += Math.max(1, inputsFor(node, "in").length) * 24 + 10;
      h += 34 + 16;
    } else if (node.type === "segmentacja/select_segments") {
      const inEdge = graph.edges.find((e) => e.to === node.id && e.toSocket === "in");
      const inOutcome = inEdge ? evalNode(inEdge.from) : null;
      const kCount = inOutcome?.ok && inOutcome.value.kind === "segmentacja" ? inOutcome.value.legend.length : 1;
      h += Math.max(1, kCount) * 22 + 10;
    }
    const kind = outputKind(node);
    if (kind === "mapa" || kind === "segmentacja") h += previewHeight(node) + 10;
    else h += 22;
    return Math.max(h, 80);
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
    setViewportSilent({ zoom, x: pad - minX * zoom, y: (rect.height - contentH * zoom) / 2 - minY * zoom });
  }

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
        requestAnimationFrame(tryFit);
      } else {
        fitPending = false;
      }
    };
    requestAnimationFrame(tryFit);
  }

  let wasVisible = $state(visible);
  $effect(() => {
    const becameVisible = visible && !wasVisible;
    wasVisible = visible;
    if (becameVisible) queueFitAll();
  });

  onMount(() => { queueFitAll(); });

  // ── Zaznaczanie: pojedyncze/grupowe (shift), przeciąganie grupy,
  // zaznaczanie prostokątem (marquee) na pustym płótnie ─────────────────
  let selectedNodeIds = $state<Set<string>>(new Set());
  let marqueeActive = $state(false);
  let marqueeShift = false;
  let marqueeStartScreen = $state({ x: 0, y: 0 });
  let marqueeCurScreen = $state({ x: 0, y: 0 });

  // ── Node dragging (pojedynczy albo cała zaznaczona grupa naraz) ───────
  let dragNodeId = $state<string | null>(null);
  let dragStart = { x: 0, y: 0 };
  let dragGroupOrigin = new Map<string, { x: number; y: number }>();

  function onNodeHeaderPointerDown(e: PointerEvent, node: GraphNode) {
    if ((e.target as HTMLElement).closest(".node-info, .node-menu-trigger")) return;
    e.stopPropagation();
    if (e.shiftKey) {
      const next = new Set(selectedNodeIds);
      if (next.has(node.id)) next.delete(node.id); else next.add(node.id);
      selectedNodeIds = next;
    } else if (!selectedNodeIds.has(node.id)) {
      selectedNodeIds = new Set([node.id]);
    }
    dragNodeId = node.id;
    dragStart = { x: e.clientX, y: e.clientY };
    dragGroupOrigin = new Map(
      graph.nodes.filter((n) => selectedNodeIds.has(n.id)).map((n) => [n.id, { x: n.x, y: n.y }]),
    );
    if (dragGroupOrigin.size === 0) dragGroupOrigin.set(node.id, { x: node.x, y: node.y });
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }
  function onNodeHeaderPointerMove(e: PointerEvent) {
    if (!dragNodeId) return;
    const dx = (e.clientX - dragStart.x) / viewport.zoom;
    const dy = (e.clientY - dragStart.y) / viewport.zoom;
    for (const [id, origin] of dragGroupOrigin) {
      const idx = graph.nodes.findIndex((n) => n.id === id);
      if (idx === -1) continue;
      graph.nodes[idx] = { ...graph.nodes[idx], x: origin.x + dx, y: origin.y + dy };
    }
  }
  function onNodeHeaderPointerUp() {
    if (dragNodeId) persist();
    dragNodeId = null;
    dragGroupOrigin = new Map();
  }

  function onCanvasPointerDown(e: PointerEvent) {
    closeMenus();
    if (e.button !== 0) return;
    const rect = container?.getBoundingClientRect();
    const p = { x: e.clientX - (rect?.left ?? 0), y: e.clientY - (rect?.top ?? 0) };
    marqueeShift = e.shiftKey;
    marqueeStartScreen = p;
    marqueeCurScreen = p;
    marqueeActive = true;
  }

  function finishMarquee() {
    marqueeActive = false;
    const dx = Math.abs(marqueeCurScreen.x - marqueeStartScreen.x);
    const dy = Math.abs(marqueeCurScreen.y - marqueeStartScreen.y);
    if (dx < 4 && dy < 4) {
      // Zwykłe kliknięcie pustego płótna (bez ruchu) — odznacza grupę, chyba
      // że trzymano shift (wtedy nic nie robimy, żeby nie skasować zaznaczenia
      // przez przypadkowy mikro-ruch podczas shift-klikania).
      if (!marqueeShift) selectedNodeIds = new Set();
      return;
    }
    const a = containerRelToWorld(marqueeStartScreen);
    const b = containerRelToWorld(marqueeCurScreen);
    const minX = Math.min(a.x, b.x), maxX = Math.max(a.x, b.x);
    const minY = Math.min(a.y, b.y), maxY = Math.max(a.y, b.y);
    const found = new Set(
      graph.nodes
        .filter((n) => n.x < maxX && n.x + nodeWidth(n) > minX && n.y < maxY && n.y + nodeHeight(n) > minY)
        .map((n) => n.id),
    );
    selectedNodeIds = marqueeShift ? new Set([...selectedNodeIds, ...found]) : found;
  }

  // ── Połączenia — gniazda typowane, łączy się tylko ten sam `kind` ───────
  interface DragConn { nodeId: string; socketId: string; direction: "in" | "out"; kind: PortKind; x: number; y: number; }
  let connDrag = $state<DragConn | null>(null);
  let cursorWorld = $state<{ x: number; y: number }>({ x: 0, y: 0 });
  let lastMouseClient = { x: 0, y: 0 };

  const HEADER_H = 30;
  const ROW_H = 20;

  function portPos(node: GraphNode, direction: "in" | "out", socketId: string): { x: number; y: number } {
    const def = NODE_TYPES[node.type];
    const sockets = direction === "in" ? def?.inputs ?? [] : def?.outputs ?? [];
    const idx = Math.max(0, sockets.findIndex((s) => s.id === socketId));
    return { x: node.x + (direction === "in" ? 0 : nodeWidth(node)), y: node.y + HEADER_H / 2 + idx * ROW_H };
  }

  function onPortPointerDown(e: PointerEvent, node: GraphNode, direction: "in" | "out", socket: PortSocketDef) {
    e.stopPropagation();
    if (direction === "in" && !socket.multi) {
      // Blender-style: chwytanie za końcówkę już podłączonego (single) wejścia
      // odłącza istniejące połączenie i zaczyna ciągnąć je od strony źródła.
      const existing = graph.edges.find((e2) => e2.to === node.id && e2.toSocket === socket.id);
      if (existing) {
        const sourceNode = graph.nodes.find((n) => n.id === existing.from);
        graph.edges = graph.edges.filter((e2) => e2.id !== existing.id);
        persist();
        if (sourceNode) {
          const outSocket = NODE_TYPES[sourceNode.type]?.outputs.find((s) => s.id === existing.fromSocket);
          if (outSocket) {
            const sp = portPos(sourceNode, "out", outSocket.id);
            connDrag = { nodeId: sourceNode.id, socketId: outSocket.id, direction: "out", kind: outSocket.kind, x: sp.x, y: sp.y };
            return;
          }
        }
      }
    }
    const p = portPos(node, direction, socket.id);
    connDrag = { nodeId: node.id, socketId: socket.id, direction, kind: socket.kind, x: p.x, y: p.y };
  }

  function onCanvasPointerMove(e: PointerEvent) {
    lastMouseClient = { x: e.clientX, y: e.clientY };
    cursorWorld = screenToWorld(lastMouseClient);
    if (dragNodeId) onNodeHeaderPointerMove(e);
    if (marqueeActive) {
      const rect = container?.getBoundingClientRect();
      marqueeCurScreen = { x: e.clientX - (rect?.left ?? 0), y: e.clientY - (rect?.top ?? 0) };
    }
  }

  const CONNECT_RADIUS_SCREEN = 26;
  function findNearestSocket(pos: { x: number; y: number }, wantDir: "in" | "out", excludeNodeId: string, wantKind: PortKind) {
    let best: { node: GraphNode; socket: PortSocketDef } | null = null;
    let bestDist = CONNECT_RADIUS_SCREEN / viewport.zoom;
    for (const n of graph.nodes) {
      if (n.id === excludeNodeId) continue;
      const def = NODE_TYPES[n.type];
      if (!def) continue;
      const sockets = wantDir === "in" ? def.inputs : def.outputs;
      for (const s of sockets) {
        if (s.kind !== wantKind) continue;
        const p = portPos(n, wantDir, s.id);
        const d = Math.hypot(p.x - pos.x, p.y - pos.y);
        if (d < bestDist) { bestDist = d; best = { node: n, socket: s }; }
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
    if (marqueeActive) finishMarquee();
  }
  function resolveConnection() {
    if (!connDrag) return;
    const wantDir: "in" | "out" = connDrag.direction === "out" ? "in" : "out";
    const target = findNearestSocket(cursorWorld, wantDir, connDrag.nodeId, connDrag.kind);
    if (target) finishConnection(connDrag, { nodeId: target.node.id, socketId: target.socket.id, direction: wantDir });
    connDrag = null;
  }

  function finishConnection(a: DragConn, b: { nodeId: string; socketId: string; direction: "in" | "out" }) {
    if (a.nodeId === b.nodeId) return; // no self-connect
    if (a.direction === b.direction) return; // must be in+out
    const fromId = a.direction === "out" ? a.nodeId : b.nodeId;
    const fromSocket = a.direction === "out" ? a.socketId : b.socketId;
    const toId = a.direction === "in" ? a.nodeId : b.nodeId;
    const toSocket = a.direction === "in" ? a.socketId : b.socketId;
    if (wouldCreateCycle(graph, fromId, toId)) return;
    const targetNode = graph.nodes.find((n) => n.id === toId);
    const targetSocket = targetNode ? NODE_TYPES[targetNode.type]?.inputs.find((s) => s.id === toSocket) : undefined;
    if (targetSocket?.multi) {
      if (graph.edges.some((e) => e.from === fromId && e.fromSocket === fromSocket && e.to === toId && e.toSocket === toSocket)) return;
      graph.edges.push({ id: makeId("edge"), from: fromId, fromSocket, to: toId, toSocket });
    } else {
      graph.edges = graph.edges.filter((e) => !(e.to === toId && e.toSocket === toSocket));
      graph.edges.push({ id: makeId("edge"), from: fromId, fromSocket, to: toId, toSocket });
    }
    persist();
  }

  function removeEdge(id: string) {
    graph.edges = graph.edges.filter((e) => e.id !== id);
    persist();
  }

  function edgePath(from: { x: number; y: number }, to: { x: number; y: number }): string {
    const dx = Math.max(40, Math.abs(to.x - from.x) * 0.5);
    return `M ${from.x} ${from.y} C ${from.x + dx} ${from.y}, ${to.x - dx} ${to.y}, ${to.x} ${to.y}`;
  }

  function nodePos(id: string): GraphNode | undefined {
    return graph.nodes.find((n) => n.id === id);
  }

  const EDGE_COLORS: Record<PortKind, string> = {
    widmo: "rgba(91,155,213,0.55)",
    mapa: "rgba(255,201,81,0.55)",
    segmentacja: "rgba(126,200,227,0.55)",
  };
  const EDGE_COLOR_DRAG: Record<PortKind, string> = {
    widmo: "rgba(91,155,213,0.4)",
    mapa: "rgba(255,201,81,0.4)",
    segmentacja: "rgba(126,200,227,0.4)",
  };
  function edgeKind(edge: GraphEdge): PortKind {
    const n = nodePos(edge.from);
    return (n && NODE_TYPES[n.type]?.outputs.find((s) => s.id === edge.fromSocket)?.kind) || "mapa";
  }

  // ── Menu kontekstowe (prawy klik ALBO spacja — ten sam punkt wejścia) ───
  let paletteOpen = $state(false);
  let paletteEl = $state<HTMLDivElement | null>(null);
  let palettePos = $state({ screen: { x: 0, y: 0 }, world: { x: 0, y: 0 } });
  let paletteRenderPos = $state({ x: 0, y: 0 });
  let paletteFilter = $state("");
  let paletteMaxHeight = $state(360);

  let nodeMenuOpen = $state(false);
  let nodeMenuEl = $state<HTMLDivElement | null>(null);
  let nodeMenuTarget = $state<string | null>(null);
  let nodeMenuPos = $state({ x: 0, y: 0 });
  let nodeMenuRenderPos = $state({ x: 0, y: 0 });

  const MENU_MARGIN = 12;

  /** Po wyrenderowaniu menu (rozmiar zależy od treści — kategorii/wyników
   * wyszukiwania) sprawdza, czy nie wychodzi poza krawędź płótna, i jeśli
   * tak — przestawia je na drugą stronę kursora zamiast pozwolić, żeby się
   * ucięło. */
  function clampMenuPos(el: HTMLElement | null, anchor: { x: number; y: number }): { x: number; y: number } {
    if (!el || !container) return anchor;
    const menuRect = el.getBoundingClientRect();
    const rect = container.getBoundingClientRect();
    let x = anchor.x, y = anchor.y;
    if (x + menuRect.width > rect.width) x = Math.max(0, anchor.x - menuRect.width);
    if (y + menuRect.height > rect.height) y = Math.max(0, anchor.y - menuRect.height);
    return { x, y };
  }

  $effect(() => {
    void paletteFilter; // przeliczaj też przy zmianie filtra (inny rozmiar listy)
    if (!paletteOpen) { paletteRenderPos = palettePos.screen; return; }
    requestAnimationFrame(() => {
      if (!paletteOpen) return;
      paletteRenderPos = clampMenuPos(paletteEl, palettePos.screen);
    });
  });

  $effect(() => {
    if (!nodeMenuOpen) { nodeMenuRenderPos = nodeMenuPos; return; }
    requestAnimationFrame(() => {
      if (!nodeMenuOpen) return;
      nodeMenuRenderPos = clampMenuPos(nodeMenuEl, nodeMenuPos);
    });
  });

  function openPaletteAt(clientX: number, clientY: number) {
    closeMenus();
    const rect = container?.getBoundingClientRect();
    const screenY = clientY - (rect?.top ?? 0);
    palettePos.screen = { x: clientX - (rect?.left ?? 0), y: screenY };
    palettePos.world = screenToWorld({ x: clientX, y: clientY });
    paletteMaxHeight = 360;
    paletteFilter = "";
    paletteOpen = true;
  }

  function onCanvasContextMenu(e: MouseEvent) {
    e.preventDefault();
    openPaletteAt(e.clientX, e.clientY);
  }

  function onNodeContextMenu(e: MouseEvent, node: GraphNode) {
    e.preventDefault();
    e.stopPropagation();
    closeMenus();
    const rect = container?.getBoundingClientRect();
    nodeMenuPos = { x: e.clientX - (rect?.left ?? 0), y: e.clientY - (rect?.top ?? 0) };
    nodeMenuTarget = node.id;
    nodeMenuOpen = true;
  }

  function closeMenus() {
    paletteOpen = false;
    nodeMenuOpen = false;
    onCtxItemLeave();
  }

  // ── Opis typu węzła w menu — nie od razu, tylko jako "chmurka" po chwili
  // najechania (ten sam duch co .node-info-tip na karcie node'a), i poza
  // przewijanym/przyciętym menu (position:fixed, żeby nigdy się nie ucinała). ──
  const TIP_DELAY_MS = 500;
  const TIP_WIDTH = 220;
  let hoveredTip = $state<{ text: string; x: number; y: number } | null>(null);
  let tipTimer: ReturnType<typeof setTimeout> | null = null;

  function onCtxItemEnter(e: PointerEvent, t: NodeTypeDef) {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    if (tipTimer) clearTimeout(tipTimer);
    const overflowsRight = rect.right + 8 + TIP_WIDTH > window.innerWidth;
    const x = overflowsRight ? rect.left - 8 - TIP_WIDTH : rect.right + 8;
    tipTimer = setTimeout(() => { hoveredTip = { text: t.description, x, y: rect.top }; }, TIP_DELAY_MS);
  }
  function onCtxItemLeave() {
    if (tipTimer) clearTimeout(tipTimer);
    tipTimer = null;
    hoveredTip = null;
  }

  function addNode(typeId: string, pos?: { x: number; y: number }) {
    const worldPos = pos ?? palettePos.world;
    const node: GraphNode = {
      id: makeId("node"),
      type: typeId,
      x: worldPos.x,
      y: worldPos.y,
      params: defaultParamsFor(typeId),
    };
    if (typeId === "mapa/map_source") {
      node.savedMapId = savedMapsList()[0]?.id;
      node.expanded = false;
      ensureMapLoaded(node.savedMapId);
    }
    if (typeId === "mapa/intensity_range") node.params = { min: 0, max: 100 };
    if (typeId === "mapa/curve") node.curvePoints = DEFAULT_CURVE_POINTS.map((p) => ({ ...p }));
    if (typeId === "mapa/combine") node.params = { mode: "mean" };
    if (typeId === "mapa/save_output") node.saveName = "";
    if (typeId === "segmentacja/select_segments") node.selectedLabels = [];
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
    if (!typing && (e.key === "f" || e.key === "F")) { e.preventDefault(); fitAll(); }
    if (!typing && visible && e.key === " " && !paletteOpen) {
      e.preventDefault();
      openPaletteAt(lastMouseClient.x, lastMouseClient.y);
    }
    if (!typing && (e.key === "Delete" || e.key === "Backspace") && hoveredNodeId) {
      e.preventDefault();
      nodeMenuTarget = hoveredNodeId;
      confirmDeleteOpen = true;
    }
  }

  let filteredTypes = $derived(
    nodeTypeList().filter((t) => {
      const q = paletteFilter.trim().toLowerCase();
      if (!q) return true;
      return t.label.toLowerCase().includes(q) || t.description.toLowerCase().includes(q) || (t.detail?.toLowerCase().includes(q) ?? false);
    })
  );
  let paletteHasFilter = $derived(paletteFilter.trim().length > 0);

  // ── Pola specyficzne dla typów węzłów ──────────────────────────────
  function setNodeSavedMap(node: GraphNode, id: string) {
    const idx = graph.nodes.findIndex((n) => n.id === node.id);
    if (idx === -1) return;
    graph.nodes[idx] = { ...graph.nodes[idx], savedMapId: id };
    persist();
    ensureMapLoaded(id);
  }

  function toggleExpanded(node: GraphNode) {
    const idx = graph.nodes.findIndex((n) => n.id === node.id);
    if (idx === -1) return;
    graph.nodes[idx] = { ...graph.nodes[idx], expanded: !graph.nodes[idx].expanded };
    persist();
  }

  function setIntensityRange(node: GraphNode, lo: number, hi: number) {
    const idx = graph.nodes.findIndex((n) => n.id === node.id);
    if (idx === -1) return;
    graph.nodes[idx] = { ...graph.nodes[idx], params: { ...graph.nodes[idx].params, min: Math.round(lo * 100), max: Math.round(hi * 100) } };
    persist();
  }

  function setCurvePoints(node: GraphNode, points: CurvePoint[]) {
    const idx = graph.nodes.findIndex((n) => n.id === node.id);
    if (idx === -1) return;
    graph.nodes[idx] = { ...graph.nodes[idx], curvePoints: points };
    persist();
  }

  function setCombineMode(node: GraphNode, mode: string) {
    const idx = graph.nodes.findIndex((n) => n.id === node.id);
    if (idx === -1) return;
    graph.nodes[idx] = { ...graph.nodes[idx], params: { ...graph.nodes[idx].params, mode } };
    persist();
  }

  function setSaveName(node: GraphNode, value: string) {
    const idx = graph.nodes.findIndex((n) => n.id === node.id);
    if (idx === -1) return;
    graph.nodes[idx] = { ...graph.nodes[idx], saveName: value };
  }

  function setKmeansK(node: GraphNode, k: number) {
    if (!Number.isFinite(k)) return;
    const clamped = Math.min(10, Math.max(2, Math.round(k)));
    const idx = graph.nodes.findIndex((n) => n.id === node.id);
    if (idx === -1) return;
    graph.nodes[idx] = { ...graph.nodes[idx], params: { ...graph.nodes[idx].params, k: clamped } };
    persist();
  }

  function toggleSegmentLabel(node: GraphNode, label: number) {
    const idx = graph.nodes.findIndex((n) => n.id === node.id);
    if (idx === -1) return;
    const cur = graph.nodes[idx].selectedLabels ?? [];
    const next = cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label];
    graph.nodes[idx] = { ...graph.nodes[idx], selectedLabels: next };
    persist();
  }

  function sourceLabel(nodeId: string): string {
    const n = graph.nodes.find((x) => x.id === nodeId);
    if (!n) return "?";
    if (n.type === "mapa/map_source") {
      const meta = savedMapsList().find((m) => m.id === n.savedMapId);
      return meta?.name ?? "— wybierz mapę —";
    }
    if (n.type === "mapa/intensity_range") return `Zakres intensywności (${n.params.min ?? 0}–${n.params.max ?? 100}%)`;
    if (n.type === "mapa/curve") return `Krzywa intensywności (${n.curvePoints?.length ?? 2} pkt)`;
    if (n.type === "mapa/combine") return `Łączenie (${COMBINE_MODE_LABELS[(n.params.mode as CombineModeExt) ?? "mean"]})`;
    if (n.type === "segmentacja/kmeans") return `K-means (k=${n.params.k ?? 3})`;
    return NODE_TYPES[n.type]?.label ?? n.type;
  }

  // ── K-means: przeliczane ręcznie (przycisk) ─────────────────────────
  let runningNodeId = $state<string | null>(null);
  let kmeansStatus = $state<Record<string, string>>({});

  function runKmeansNode(node: GraphNode) {
    const inEdges = inputsFor(node, "in");
    if (inEdges.length === 0) { kmeansStatus = { ...kmeansStatus, [node.id]: "podłącz przynajmniej jedną mapę" }; return; }
    const inputs: MapaValue[] = [];
    for (const e of inEdges) {
      const r = evalNode(e.from);
      if (!r.ok) { kmeansStatus = { ...kmeansStatus, [node.id]: r.error }; return; }
      if (r.value.kind !== "mapa") { kmeansStatus = { ...kmeansStatus, [node.id]: "wejście musi być mapą" }; return; }
      inputs.push(r.value);
    }
    const { width, height, tissueId, tissueLabel } = inputs[0];
    if (inputs.some((r) => r.width !== width || r.height !== height)) {
      kmeansStatus = { ...kmeansStatus, [node.id]: "podłączone mapy mają różne wymiary" };
      return;
    }
    if (inputs.some((r) => r.tissueId !== tissueId)) {
      kmeansStatus = { ...kmeansStatus, [node.id]: "podłączone mapy pochodzą z różnych tkanek" };
      return;
    }
    const k = Math.round(Number(node.params.k ?? 3));
    const validMask = combineMasks(inputs.map((r) => r.mask), height, width);
    runningNodeId = node.id;
    kmeansStatus = { ...kmeansStatus, [node.id]: "" };
    setTimeout(() => {
      try {
        const { labels, legend } = runKmeans(inputs.map((r) => r.data), k, validMask);
        const idx = graph.nodes.findIndex((n) => n.id === node.id);
        if (idx !== -1) {
          graph.nodes[idx] = {
            ...graph.nodes[idx],
            kmeansResult: { k, width, height, tissueId, tissueLabel, labels, legend, mask: validMask, sources: dedupeMapSources(inputs.flatMap((r) => r.sources)) },
          };
          persist();
        }
        kmeansStatus = { ...kmeansStatus, [node.id]: `gotowe — k=${k}` };
      } catch (e) {
        kmeansStatus = { ...kmeansStatus, [node.id]: e instanceof Error ? e.message : String(e) };
      } finally {
        runningNodeId = null;
      }
    }, 20);
  }

  function dedupeMapSources(all: MapaValue["sources"]): MapaValue["sources"] {
    const seen = new Set<string>();
    const out: MapaValue["sources"] = [];
    for (const s of all) {
      const key = `${s.mz}|${s.tol}|${s.datasetId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(s);
    }
    return out;
  }

  // ── Zapis mapy wynikowej ────────────────────────────────────────────
  let savingNodeId = $state<string | null>(null);
  let saveStatus = $state<Record<string, string>>({});

  async function saveOutputNode(node: GraphNode) {
    const outcome = evalNode(node.id);
    if (!outcome.ok) { saveStatus = { ...saveStatus, [node.id]: outcome.error }; return; }
    if (outcome.value.kind !== "mapa") { saveStatus = { ...saveStatus, [node.id]: "nieprawidłowe wejście" }; return; }
    const name = (node.saveName ?? "").trim();
    if (!name) { saveStatus = { ...saveStatus, [node.id]: "podaj nazwę" }; return; }
    savingNodeId = node.id;
    try {
      const r = outcome.value;
      await savePixelMap({
        name, tissueId: r.tissueId, tissueLabel: r.tissueLabel, width: r.width, height: r.height,
        vmax: maxOf(r.data), mode: r.mode as SavedPixelMapMode, sources: r.sources, data: r.data, mask: r.mask,
      });
      saveStatus = { ...saveStatus, [node.id]: `✓ zapisano jako "${name}"` };
    } catch (e) {
      saveStatus = { ...saveStatus, [node.id]: e instanceof Error ? e.message : String(e) };
    } finally {
      savingNodeId = null;
    }
  }
</script>

<svelte:window onkeydown={onWindowKeydown} />

<div class="ng-layout">
<div
  bind:this={container}
  class="nodegraph-canvas"
  style="
    background-position: {viewport.x}px {viewport.y}px;
    background-size: {dotSpacingWorld * viewport.zoom}px {dotSpacingWorld * viewport.zoom}px;
    background-image: radial-gradient(rgba(255,255,255,0.16) {dotRadius}px, transparent {dotRadius}px);
  "
  onwheel={onWheel}
  oncontextmenu={onCanvasContextMenu}
  onpointermove={onCanvasPointerMove}
  onpointerup={onCanvasPointerUp}
  onpointerdown={onCanvasPointerDown}
  role="application"
  aria-label="Edytor grafu node'ów"
>
  <div class="nodegraph-content" style="transform: translate({viewport.x}px, {viewport.y}px) scale({viewport.zoom});">

    <!-- Edges -->
    <svg class="edges-layer">
      {#each graph.edges as edge (edge.id)}
        {@const fromNode = nodePos(edge.from)}
        {@const toNode = nodePos(edge.to)}
        {#if fromNode && toNode}
          <path d={edgePath(portPos(fromNode, "out", edge.fromSocket), portPos(toNode, "in", edge.toSocket))}
                stroke={EDGE_COLORS[edgeKind(edge)]} stroke-width="2" fill="none" />
        {/if}
      {/each}
      {#if connDrag}
        <path d={edgePath({ x: connDrag.x, y: connDrag.y }, cursorWorld)}
              stroke={EDGE_COLOR_DRAG[connDrag.kind]} stroke-width="2" fill="none" stroke-dasharray="4 3" />
      {/if}
    </svg>

    <!-- Nodes -->
    {#each graph.nodes as node (node.id)}
      {@const def = NODE_TYPES[node.type]}
      {#if def}
        <div class="mnode" class:selected={selectedNodeIds.has(node.id)}
             style="left:{node.x}px; top:{node.y}px; width:{nodeWidth(node)}px;"
             oncontextmenu={(e) => onNodeContextMenu(e, node)}
             onpointerenter={() => (hoveredNodeId = node.id)}
             onpointerleave={() => (hoveredNodeId = null)}>
          <div class="mnode-header"
               onpointerdown={(e) => onNodeHeaderPointerDown(e, node)}
               onpointerup={onNodeHeaderPointerUp}>
            <span class="mnode-title">{def.label}</span>
            <span class="node-info" tabindex="0" role="note">
              <span class="node-info-icon">i</span>
              <span class="node-info-tip">{def.description}</span>
            </span>
          </div>

          <div class="mnode-body">
            {#if node.type === "mapa/map_source"}
              {@const meta = savedMapsList().find((m) => m.id === node.savedMapId)}
              <label class="field">
                <span>Zapisana mapa</span>
                <select class="ds-select" value={node.savedMapId ?? ""}
                        onpointerdown={(e) => e.stopPropagation()}
                        onchange={(e) => setNodeSavedMap(node, (e.target as HTMLSelectElement).value)}>
                  <option value="">— wybierz —</option>
                  {#each savedMapsList() as m (m.id)}
                    <option value={m.id}>{m.name}</option>
                  {/each}
                </select>
              </label>
              <button class="mz-expand-toggle" onpointerdown={(e) => e.stopPropagation()} onclick={() => toggleExpanded(node)}>
                {node.expanded ? "▾ szczegóły" : "▸ szczegóły"}
              </button>
              {#if node.expanded && meta}
                <div class="mz-details" onpointerdown={(e) => e.stopPropagation()}>
                  <div class="mz-details-name">{meta.name}</div>
                  <div class="saved-meta-row">
                    <span class="mode-tag">{savedMapModeLabel[meta.mode] ?? meta.mode}</span>
                  </div>
                  <div class="saved-sources">
                    {#each meta.sources as s, i (i)}
                      <span class="source-tag">m/z {s.mz.toFixed(2)} ±{s.tol} · {s.datasetLabel}</span>
                    {/each}
                  </div>
                </div>
              {/if}
            {:else if node.type === "mapa/intensity_range"}
              <div class="field" onpointerdown={(e) => e.stopPropagation()}>
                <DualRange
                  min={Number(node.params.min ?? 0) / 100}
                  max={Number(node.params.max ?? 100) / 100}
                  ondisprange={(lo, hi) => setIntensityRange(node, lo, hi)}
                />
              </div>
            {:else if node.type === "mapa/curve"}
              {@const inEdge = graph.edges.find((e) => e.to === node.id && e.toSocket === "in")}
              {@const inOutcome = inEdge ? evalNode(inEdge.from) : null}
              {@const histogram = inOutcome?.ok && inOutcome.value.kind === "mapa" ? computeHistogram(inOutcome.value.data, 40, inOutcome.value.mask) : []}
              <div class="field" onpointerdown={(e) => e.stopPropagation()}>
                <CurveEditor
                  points={node.curvePoints ?? DEFAULT_CURVE_POINTS}
                  {histogram}
                  onchange={(points) => setCurvePoints(node, points)}
                />
              </div>
            {:else if node.type === "mapa/combine"}
              <label class="field">
                <span>Sposób łączenia</span>
                <select class="ds-select" value={(node.params.mode as string) ?? "mean"}
                        onpointerdown={(e) => e.stopPropagation()}
                        onchange={(e) => setCombineMode(node, (e.target as HTMLSelectElement).value)}>
                  {#each COMBINE_MODE_LIST as m}
                    <option value={m}>{COMBINE_MODE_LABELS[m]}</option>
                  {/each}
                </select>
              </label>
              <div class="combine-list" onpointerdown={(e) => e.stopPropagation()}>
                {#if inputsFor(node, "in").length === 0}
                  <div class="combine-list-empty">brak podłączonych map</div>
                {:else}
                  {#each inputsFor(node, "in") as edge (edge.id)}
                    <div class="combine-list-item">
                      <span class="combine-list-label">{sourceLabel(edge.from)}</span>
                      <button class="combine-remove" onclick={() => removeEdge(edge.id)} title="Usuń połączenie">×</button>
                    </div>
                  {/each}
                {/if}
              </div>
            {:else if node.type === "mapa/save_output"}
              <label class="field" onpointerdown={(e) => e.stopPropagation()}>
                <span>Nazwa nowej mapy</span>
                <input class="mz-name-input" type="text" placeholder="nazwa…"
                       value={node.saveName ?? ""}
                       oninput={(e) => setSaveName(node, (e.target as HTMLInputElement).value)} />
              </label>
              <button class="run-btn save-btn" onpointerdown={(e) => e.stopPropagation()}
                      disabled={savingNodeId === node.id}
                      onclick={() => saveOutputNode(node)}>
                {savingNodeId === node.id ? "Zapisywanie…" : "Zapisz jako nową mapę"}
              </button>
              {#if saveStatus[node.id]}
                <span class="preview-result">{saveStatus[node.id]}</span>
              {/if}
            {:else if node.type === "segmentacja/kmeans"}
              <label class="field">
                <span class="field-head">
                  <input type="text" inputmode="numeric" class="param-value-input"
                         value={node.params.k ?? 3}
                         onpointerdown={(e) => e.stopPropagation()}
                         onchange={(e) => {
                           const raw = Number((e.target as HTMLInputElement).value.replace(',', '.'));
                           if (Number.isNaN(raw)) { (e.target as HTMLInputElement).value = String(node.params.k ?? 3); return; }
                           setKmeansK(node, raw);
                           (e.target as HTMLInputElement).value = String(Math.min(10, Math.max(2, Math.round(raw))));
                         }}
                         onkeydown={(e) => {
                           if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                           if (e.key === "Escape") {
                             (e.target as HTMLInputElement).value = String(node.params.k ?? 3);
                             (e.target as HTMLInputElement).blur();
                           }
                         }} />
                  <span>k (liczba grup)</span>
                </span>
                <input type="range" min="2" max="10" step="1"
                       value={Number(node.params.k ?? 3)}
                       onpointerdown={(e) => e.stopPropagation()}
                       oninput={(e) => setKmeansK(node, Number((e.target as HTMLInputElement).value))} />
              </label>
              <div class="combine-list" onpointerdown={(e) => e.stopPropagation()}>
                {#if inputsFor(node, "in").length === 0}
                  <div class="combine-list-empty">brak podłączonych map</div>
                {:else}
                  {#each inputsFor(node, "in") as edge (edge.id)}
                    <div class="combine-list-item">
                      <span class="combine-list-label">{sourceLabel(edge.from)}</span>
                      <button class="combine-remove" onclick={() => removeEdge(edge.id)} title="Usuń połączenie">×</button>
                    </div>
                  {/each}
                {/if}
              </div>
              <button class="run-btn" onpointerdown={(e) => e.stopPropagation()}
                      disabled={runningNodeId === node.id}
                      onclick={() => runKmeansNode(node)}>
                {runningNodeId === node.id ? "Przetwarzanie…" : "Przetwórz"}
              </button>
              {#if kmeansStatus[node.id]}
                <span class="preview-result">{kmeansStatus[node.id]}</span>
              {/if}
            {:else if node.type === "segmentacja/select_segments"}
              {@const inEdge = graph.edges.find((e) => e.to === node.id && e.toSocket === "in")}
              {@const inOutcome = inEdge ? evalNode(inEdge.from) : null}
              <div class="seg-checklist" onpointerdown={(e) => e.stopPropagation()}>
                {#if inOutcome?.ok && inOutcome.value.kind === "segmentacja"}
                  {@const bgCount = inOutcome.value.width * inOutcome.value.height - inOutcome.value.legend.reduce((a, l) => a + l.count, 0)}
                  {#each inOutcome.value.legend as l (l.label)}
                    <label class="seg-check-item">
                      <input type="checkbox" class="cb-input cb-input-sm"
                             checked={(node.selectedLabels ?? []).includes(l.label)}
                             onchange={() => toggleSegmentLabel(node, l.label)} />
                      <span class="seg-swatch" style="background:{SEG_PALETTE[l.label % SEG_PALETTE.length]}"></span>
                      <span class="cb-label">klasa {l.label} ({l.count}px)</span>
                    </label>
                  {/each}
                  {#if bgCount > 0}
                    <div class="seg-check-bg" title="Piksele poza faktycznym skanem tkanki — wykluczone z k-means, nigdy niewybieralne">
                      <span class="seg-swatch seg-swatch-bg"></span>
                      <span>tło ({bgCount}px, wykluczone)</span>
                    </div>
                  {/if}
                {:else}
                  <div class="combine-list-empty">podłącz wynik k-means</div>
                {/if}
              </div>
            {/if}

            <!-- Podgląd na żywo — {#if true} to jedyny sposób, by {@const} mógł tu
                 być użyty (musi być bezpośrednim dzieckiem konstrukcji blokowej). -->
            {#if true}
              {@const outcome = evalNode(node.id)}
              {@const kind = outputKind(node)}
              {#if kind === "mapa" || kind === "segmentacja"}
                <div class="mz-preview" style="height:{previewHeight(node)}px">
                  {#if outcome.ok && outcome.value.kind === "mapa"}
                    {@const mapVal = outcome.value}
                    <IonCanvas tissue={resultTissue(mapVal)} dispMin={0} dispMax={1} invertColors={false} showColorbar={false} showVmax={false} compact />
                    <button class="mz-zoom-btn" onpointerdown={(e) => e.stopPropagation()}
                            onclick={() => (zoomTissue = resultTissue(mapVal))} title="Powiększ">⤢</button>
                  {:else if outcome.ok && outcome.value.kind === "segmentacja"}
                    <SegLabelCanvas labels={outcome.value.labels} legend={outcome.value.legend} />
                  {:else if !outcome.ok}
                    <div class="mz-preview-empty">{outcome.error}</div>
                  {/if}
                </div>
              {:else if !outcome.ok}
                <div class="node-status">{outcome.error}</div>
              {/if}
            {/if}
          </div>

          {#each def.inputs as socket, i (socket.id)}
            <div class="port" title={socket.label}
                 style="left:-6px; top:{9 + i * ROW_H}px; background:{PORT_KIND_COLORS[socket.kind]};"
                 onpointerdown={(e) => onPortPointerDown(e, node, "in", socket)}
                 onpointerup={onPortPointerUp}></div>
          {/each}
          {#each def.outputs as socket, i (socket.id)}
            <div class="port" title={socket.label}
                 style="right:-6px; top:{9 + i * ROW_H}px; background:{PORT_KIND_COLORS[socket.kind]};"
                 onpointerdown={(e) => onPortPointerDown(e, node, "out", socket)}
                 onpointerup={onPortPointerUp}></div>
          {/each}
        </div>
      {/if}
    {/each}
  </div>

  {#if marqueeActive}
    {@const mx = Math.min(marqueeStartScreen.x, marqueeCurScreen.x)}
    {@const my = Math.min(marqueeStartScreen.y, marqueeCurScreen.y)}
    {@const mw = Math.abs(marqueeCurScreen.x - marqueeStartScreen.x)}
    {@const mh = Math.abs(marqueeCurScreen.y - marqueeStartScreen.y)}
    <div class="marquee" style="left:{mx}px; top:{my}px; width:{mw}px; height:{mh}px;"></div>
  {/if}

  {#if paletteOpen}
    <div bind:this={paletteEl} class="ctx-menu palette" style="left:{paletteRenderPos.x}px; top:{paletteRenderPos.y}px; max-height:{paletteMaxHeight}px;"
         onpointerdown={(e) => e.stopPropagation()}
         onwheel={(e) => e.stopPropagation()}>
      <input class="ctx-filter" type="text" placeholder="Szukaj node'a…" bind:value={paletteFilter} autofocus />
      <div class="ctx-list">
        {#if paletteHasFilter}
          {#each filteredTypes as t (t.id)}
            <button class="ctx-item" onclick={() => addNode(t.id)}
                    onpointerenter={(e) => onCtxItemEnter(e, t)} onpointerleave={onCtxItemLeave}>
              <span class="ctx-item-label">{t.label} <span class="ctx-item-domain">· {DOMAIN_LABELS[t.domain]}</span></span>
            </button>
          {/each}
          {#if filteredTypes.length === 0}
            <div class="ctx-empty">brak wyników</div>
          {/if}
        {:else}
          {#each DOMAIN_ORDER as dom (dom)}
            {@const domItems = filteredTypes.filter((t) => t.domain === dom)}
            {#if domItems.length > 0}
              <div class="ctx-domain">{DOMAIN_LABELS[dom]}</div>
              {#each STAGE_ORDER as st (st)}
                {@const items = domItems.filter((t) => t.stage === st)}
                {#if items.length > 0}
                  <div class="ctx-cat">{STAGE_LABELS[st]}</div>
                  {#each items as t (t.id)}
                    <button class="ctx-item" onclick={() => addNode(t.id)}
                            onpointerenter={(e) => onCtxItemEnter(e, t)} onpointerleave={onCtxItemLeave}>
                      <span class="ctx-item-label">{t.label}</span>
                    </button>
                  {/each}
                {/if}
              {/each}
            {/if}
          {/each}
        {/if}
      </div>
    </div>
  {/if}

  {#if nodeMenuOpen}
    <div bind:this={nodeMenuEl} class="ctx-menu node-menu" style="left:{nodeMenuRenderPos.x}px; top:{nodeMenuRenderPos.y}px;"
         onpointerdown={(e) => e.stopPropagation()}>
      <button class="ctx-item danger" onclick={requestDeleteNode}>Usuń</button>
    </div>
  {/if}
</div>

<aside class="ng-sidebar" class:collapsed={!sidebarOpen}>
  <div class="ng-sidebar-inner">
    <div class="ng-sidebar-title">Node'y</div>
    <div class="ng-sidebar-list">
      {#each groupedNodeTypes as g (g.domain)}
        <div class="ctx-domain">{g.label}</div>
        {#each g.stages as s (s.label)}
          <div class="ctx-cat">{s.label}</div>
          {#each s.items as t (t.id)}
            <div class="ng-sidebar-item" class:dragging={paletteDrag?.typeId === t.id}
                 onpointerdown={(e) => onSidebarItemPointerDown(e, t)}
                 title={t.description}>
              <span class="ng-item-dot" style="background:{nodeTypeDotColor(t)}"></span>
              <span class="ng-item-label">{t.label}</span>
            </div>
          {/each}
        {/each}
      {/each}
    </div>
  </div>
</aside>

<button class="ng-sidebar-toggle" style="right:{sidebarOpen ? SIDEBAR_WIDTH + 8 : 0}px"
        onclick={() => (sidebarOpen = !sidebarOpen)}
        title={sidebarOpen ? "Zwiń panel node'ów" : "Rozwiń panel node'ów"}>
  <span class="ng-toggle-arrow">{sidebarOpen ? "›" : "‹"}</span>
</button>

{#if paletteDrag}
  <div class="palette-drag-ghost" style="left:{paletteDrag.x}px; top:{paletteDrag.y}px;">{paletteDrag.label}</div>
{/if}

{#if hoveredTip}
  <div class="ctx-item-tip" style="left:{hoveredTip.x}px; top:{hoveredTip.y}px; width:{TIP_WIDTH}px;">{hoveredTip.text}</div>
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

{#if zoomTissue}
  <PixelMapZoomModal tissue={zoomTissue} dispMin={0} dispMax={1} invertColors={false} onclose={() => (zoomTissue = null)} />
{/if}

<style>
  .ng-layout {
    display: flex;
    flex-direction: row;
    width: 100%;
    height: 100%;
    min-height: 0;
    position: relative;
  }

  .nodegraph-canvas {
    position: relative;
    flex: 1;
    min-width: 0;
    height: 100%;
    overflow: hidden;
    background-color: #1a1a1a;
    border-radius: 10px;
    border: 1px solid rgba(255,255,255,0.07);
    cursor: default;
    touch-action: none;
  }

  .nodegraph-content {
    position: absolute;
    left: 0; top: 0;
    transform-origin: 0 0;
  }

  .edges-layer {
    position: absolute;
    left: 0; top: 0;
    width: 1px; height: 1px;
    overflow: visible;
    pointer-events: none;
  }
  .edges-layer path { pointer-events: none; }

  .marquee {
    position: absolute;
    background: rgba(255,201,81,0.1);
    border: 1px solid rgba(255,201,81,0.5);
    border-radius: 2px;
    pointer-events: none;
    z-index: 6;
  }

  .mnode {
    position: absolute;
    background: #222;
    border: 1px solid rgba(255,255,255,0.09);
    border-radius: 10px;
    box-shadow: 0 4px 16px rgba(0,0,0,0.35);
    user-select: none;
  }
  .mnode.selected {
    border-color: rgba(255,201,81,0.6);
    box-shadow: 0 0 0 2px rgba(255,201,81,0.3), 0 4px 16px rgba(0,0,0,0.35);
  }

  .mnode-header {
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
  .mnode-header:active { cursor: grabbing; }

  .mnode-title {
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

  .mnode-body {
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

  /* Jednolity styl pola liczbowego przy suwaku — 1:1 z .param-value-input
     w PreNodesEditor.svelte (ten sam wzorzec co node "Wykrywanie pików"). */
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
  .param-value-input:hover { background: rgba(255,255,255,0.05); border-color: rgba(255,255,255,0.12); }
  .param-value-input:focus { background: rgba(255,255,255,0.05); border-color: rgba(255,201,81,0.4); outline: none; }

  /* Jednolity styl suwaka — 1:1 z input[type="range"] w PreNodesEditor.svelte
     / BoardSidebar.svelte (tam ten sam komentarz: "same styling"). */
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

  /* Jednolity styl dropdownów — 1:1 ze .ds-select w Sidebar.svelte (m/z). */
  .ds-select {
    width: 100%;
    appearance: none; -webkit-appearance: none; -moz-appearance: none;
    background: #1a1a1a
      url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 6'><path d='M1 1l4 4 4-4' stroke='%23ffc951' stroke-width='1.4' fill='none' stroke-linecap='round' stroke-linejoin='round'/></svg>")
      no-repeat right 8px center;
    background-size: 9px 6px;
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 6px;
    color: #e0e0e0;
    font-size: 0.72rem;
    padding: 4px 22px 4px 8px;
    font-family: inherit;
    cursor: pointer;
    outline: none;
    box-sizing: border-box;
    transition: border-color 0.15s, color 0.15s;
  }
  .ds-select:hover  { border-color: rgba(255,201,81,0.3); color: #ffc951; }
  .ds-select option { background: #1a1a1a; color: #e0e0e0; }

  .mz-expand-toggle {
    align-self: flex-start;
    background: none;
    border: none;
    color: rgba(255,255,255,0.4);
    font-size: 0.62rem;
    font-weight: 600;
    letter-spacing: 0.04em;
    padding: 0;
    cursor: pointer;
    font-family: inherit;
    transition: color 0.15s;
  }
  .mz-expand-toggle:hover { color: #ffc951; }

  .mz-details {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px;
    background: rgba(255,255,255,0.03);
    border: 1px solid rgba(255,255,255,0.07);
    border-radius: 8px;
  }
  .mz-details-name {
    font-size: 0.7rem;
    font-weight: 700;
    letter-spacing: 0.03em;
    color: #ffc951;
    text-transform: uppercase;
  }

  .saved-meta-row { display: flex; gap: 6px; }
  .mode-tag {
    font-size: 0.58rem;
    font-weight: 600;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    padding: 2px 7px;
    border-radius: 5px;
    color: #ffc951;
    background: rgba(255,201,81,0.12);
  }
  .saved-sources { display: flex; flex-wrap: wrap; gap: 5px; }
  .source-tag {
    font-size: 0.58rem;
    color: rgba(255,255,255,0.45);
    background: rgba(255,255,255,0.04);
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 5px;
    padding: 3px 6px;
  }

  .combine-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-height: 120px;
    overflow-y: auto;
  }
  .combine-list-empty {
    font-size: 0.62rem;
    color: rgba(255,255,255,0.3);
    padding: 4px 2px;
  }
  .combine-list-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    background: rgba(255,255,255,0.04);
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 6px;
    padding: 4px 6px;
  }
  .combine-list-label {
    font-size: 0.62rem;
    color: rgba(255,255,255,0.7);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .combine-remove {
    flex-shrink: 0;
    background: none; border: none; color: rgba(255,255,255,0.3);
    cursor: pointer; font-size: 0.85rem; padding: 0 2px; line-height: 1;
    font-family: inherit; transition: color 0.15s;
  }
  .combine-remove:hover { color: #ff6b6b; }

  .seg-checklist {
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-height: 160px;
    overflow-y: auto;
  }
  .seg-check-item {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 0.65rem;
    color: rgba(255,255,255,0.75);
    cursor: pointer;
  }
  .seg-swatch {
    width: 9px; height: 9px;
    border-radius: 2px;
    display: inline-block;
    flex-shrink: 0;
  }
  .seg-check-bg {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 0.62rem;
    color: rgba(255,255,255,0.35);
    padding-left: 20px;
  }
  .seg-swatch-bg {
    background: repeating-linear-gradient(45deg, rgba(255,255,255,0.15) 0 2px, transparent 2px 4px);
    border: 1px solid rgba(255,255,255,0.2);
  }

  /* Jednolity styl checkboxów — 1:1 ze .cb-input w Sidebar.svelte (m/z),
     tylko mniejszy (13px), żeby zmieścił się w wąskiej karcie node'a. */
  .cb-input {
    appearance: none; width: 13px; height: 13px; flex-shrink: 0;
    border: 1.5px solid rgba(255,255,255,0.2); border-radius: 3px;
    background: #1a1a1a; cursor: pointer; position: relative;
    transition: border-color 0.15s, background 0.15s;
  }
  .cb-input:checked { background: #ffc951; border-color: #ffc951; }
  .cb-input:checked::after {
    content: ""; position: absolute;
    left: 50%; top: 50%;
    width: 3px; height: 6px;
    border-right: 1.5px solid #1a1a1a; border-bottom: 1.5px solid #1a1a1a;
    transform: translate(-50%, -62%) rotate(45deg);
  }
  .cb-input:hover { border-color: rgba(255,201,81,0.5); }
  .cb-label { font-size: 0.65rem; color: rgba(255,255,255,0.75); }

  .mz-name-input {
    width: 100%;
    background: rgba(255,255,255,0.05);
    border: 1px solid rgba(255,255,255,0.12);
    border-radius: 5px;
    color: #e0e0e0;
    font-size: 0.65rem;
    font-family: inherit;
    padding: 4px 6px;
    box-sizing: border-box;
    outline: none;
  }
  .mz-name-input:focus { border-color: rgba(255,201,81,0.4); }

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
  .save-btn {
    background: rgba(126,200,227,0.12);
    border-color: rgba(126,200,227,0.4);
    color: #7ec8e3;
  }
  .save-btn:hover:not(:disabled) { background: rgba(126,200,227,0.2); }

  .preview-result {
    font-size: 0.6rem;
    color: rgba(255,255,255,0.45);
    line-height: 1.3;
  }

  .node-status {
    font-size: 0.62rem;
    color: rgba(255,107,107,0.85);
    line-height: 1.4;
    padding: 2px 0;
  }

  .mz-preview {
    position: relative;
    height: 130px;
    border-radius: 8px;
    overflow: hidden;
    background: #1a1a1a;
  }
  .mz-preview :global(.card) { height: 100%; }
  .mz-preview-empty {
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    text-align: center;
    padding: 8px;
    font-size: 0.62rem;
    line-height: 1.4;
    color: rgba(255,255,255,0.3);
  }
  .mz-zoom-btn {
    position: absolute;
    top: 4px; right: 4px;
    background: rgba(0,0,0,0.5);
    border: 1px solid rgba(255,255,255,0.15);
    border-radius: 6px;
    color: #f0f0f0;
    font-size: 0.7rem;
    line-height: 1;
    padding: 3px 5px;
    cursor: pointer;
    font-family: inherit;
    transition: border-color 0.15s, background 0.15s;
  }
  .mz-zoom-btn:hover { border-color: rgba(255,201,81,0.5); background: rgba(255,201,81,0.15); }

  .port {
    position: absolute;
    width: 12px; height: 12px;
    border-radius: 50%;
    border: 2px solid #1a1a1a;
    cursor: crosshair;
    z-index: 5;
  }

  .ctx-menu {
    position: absolute;
    background: #262626;
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 8px;
    box-shadow: 0 12px 32px rgba(0,0,0,0.5);
    z-index: 100;
    overflow: hidden;
  }

  /* Stała, wąska szerokość — nie "na full width": bez opisów w treści (patrz
     .ctx-item-tip niżej) menu nie musi być szerokie, żeby zmieścić tekst. */
  .ctx-menu.palette {
    display: flex;
    flex-direction: column;
    width: 200px;
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
  .ctx-domain {
    padding: 8px 10px 4px;
    margin-top: 6px;
    font-size: 0.68rem;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: #f0f0f0;
    background: rgba(255,255,255,0.05);
    border-top: 1px solid rgba(255,255,255,0.1);
  }
  .ctx-domain:first-child { margin-top: 0; border-top: none; }
  .ctx-cat {
    padding: 5px 10px 4px;
    font-size: 0.6rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: #ffc951;
    background: rgba(255,201,81,0.05);
  }
  .ctx-item:hover { background: rgba(255,255,255,0.06); }
  .ctx-item-label { font-size: 0.72rem; color: #e0e0e0; }
  .ctx-item-domain { font-size: 0.6rem; color: rgba(255,255,255,0.35); font-weight: 400; }
  .ctx-item.danger { color: #ff6b6b; font-size: 0.72rem; }

  .ctx-empty {
    padding: 10px;
    font-size: 0.68rem;
    color: rgba(255,255,255,0.35);
  }

  /* Opis typu węzła jako chmurka obok, dopiero po chwili najechania — patrz
     onCtxItemEnter/TIP_DELAY_MS. position:fixed, żeby nie ucinało jej
     przewijane/przycięte menu. */
  .ctx-item-tip {
    position: fixed;
    background: #1a1a1a;
    border: 1px solid rgba(255,255,255,0.12);
    border-radius: 8px;
    padding: 8px 10px;
    font-size: 0.65rem;
    line-height: 1.4;
    color: rgba(255,255,255,0.75);
    z-index: 200;
    box-shadow: 0 8px 24px rgba(0,0,0,0.5);
    pointer-events: none;
  }

  /* ── Prawy panel node'ów ──────────────────────────────────────────── */
  .ng-sidebar {
    width: 220px;
    flex-shrink: 0;
    overflow: hidden;
    margin-left: 8px;
    transition: width 0.25s cubic-bezier(0.4,0,0.2,1), margin-left 0.25s cubic-bezier(0.4,0,0.2,1);
  }
  .ng-sidebar.collapsed { width: 0; margin-left: 0; }

  .ng-sidebar-inner {
    width: 220px;
    height: 100%;
    box-sizing: border-box;
    background: #222;
    border: 1px solid rgba(255,255,255,0.09);
    border-radius: 10px;
    display: flex;
    flex-direction: column;
    padding: 12px 10px;
    overflow-y: auto;
  }

  .ng-sidebar-title {
    font-size: 0.66rem;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: rgba(255,255,255,0.38);
    margin-bottom: 8px;
    padding: 0 2px;
  }

  .ng-sidebar-list { display: flex; flex-direction: column; }

  .ng-sidebar-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px;
    border-radius: 6px;
    cursor: grab;
    font-size: 0.68rem;
    color: rgba(255,255,255,0.75);
    border: 1px solid transparent;
    transition: background 0.15s, border-color 0.15s;
  }
  .ng-sidebar-item:hover { background: rgba(255,255,255,0.06); border-color: rgba(255,255,255,0.1); }
  .ng-sidebar-item:active,
  .ng-sidebar-item.dragging { cursor: grabbing; background: rgba(255,201,81,0.1); border-color: rgba(255,201,81,0.3); }

  .ng-item-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .ng-item-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .palette-drag-ghost {
    position: fixed;
    transform: translate(-50%, -50%);
    pointer-events: none;
    z-index: 1000;
    background: #262626;
    border: 1px solid rgba(255,201,81,0.4);
    border-radius: 8px;
    padding: 6px 12px;
    font-size: 0.7rem;
    font-weight: 600;
    color: #ffc951;
    box-shadow: 0 8px 24px rgba(0,0,0,0.5);
    white-space: nowrap;
  }

  .ng-sidebar-toggle {
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    transition: right 0.25s cubic-bezier(0.4,0,0.2,1);
    width: 18px;
    height: 44px;
    background: #262626;
    border: 1px solid rgba(255,255,255,0.1);
    border-right: none;
    border-radius: 8px 0 0 8px;
    color: rgba(255,255,255,0.4);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 10;
    font-family: inherit;
  }
  .ng-sidebar-toggle:hover { color: #ffc951; border-color: rgba(255,201,81,0.3); }
  .ng-toggle-arrow { font-size: 0.85rem; line-height: 1; }
</style>
