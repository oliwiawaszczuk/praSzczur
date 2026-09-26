<script lang="ts">
  import { onMount } from "svelte";
  import { wsGet, wsSet } from "$lib/workspace.svelte";
  import ConfirmModal from "$lib/ConfirmModal.svelte";
  import DualRange from "$lib/DualRange.svelte";
  import CurveEditor from "$lib/CurveEditor.svelte";
  import IonCanvas from "$lib/IonCanvas.svelte";
  import PixelMapZoomModal from "$lib/PixelMapZoomModal.svelte";
  import type { TissueImage } from "$lib/api.js";
  import { maxOf } from "$lib/tissueMerge";
  import type { CombineMode } from "$lib/tissueMerge";
  import {
    savedMapsList, loadSavedMaps, savedMapsLoaded, fetchSavedMapData, savePixelMap,
    type SavedPixelMap,
  } from "$lib/savedPixelMaps.svelte";
  import {
    MZ_NODE_TYPE_LIST, MZ_NODE_TYPES, MZ_CATEGORY_ORDER, MZ_CATEGORY_LABELS,
    defaultMzGraph, mzDefaultParams, makeMzId, evaluateMzNode, wouldCreateCycle,
    COMBINE_MODE_LABELS, COMBINE_MODE_LIST, DEFAULT_CURVE_POINTS, computeHistogram,
    type MzGraph, type MzGraphNode, type MzGraphEdge, type MzGraphViewport, type MzEvalResult,
    type MzCurvePoint,
  } from "$lib/mzgraphnodes";

  interface Props {
    /** Czy ta podzakładka jest aktualnie widoczna — pozwala przeliczyć
     * auto-fit widoku dopiero gdy faktycznie stanie się widoczna (patrz
     * ten sam wzorzec w PreNodesEditor.svelte). */
    visible?: boolean;
  }
  let { visible = true }: Props = $props();

  onMount(async () => { if (!savedMapsLoaded()) await loadSavedMaps(); });

  const LS_GRAPH = "mzgraph_graph";

  function sanitize(g: MzGraph): MzGraph {
    if (!g.nodes) g.nodes = [];
    if (!g.edges) g.edges = [];
    if (!g.viewport) g.viewport = { x: 0, y: 0, zoom: 1 };
    return g;
  }

  let graph = $state<MzGraph>(sanitize(wsGet<MzGraph>(LS_GRAPH, defaultMzGraph())));

  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  function persist() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { wsSet(LS_GRAPH, graph); }, 300);
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
      if (n.type === "map_source") ensureMapLoaded(n.savedMapId);
    }
  });

  function savedMapExists(id: string): boolean {
    return savedMapsList().some((m) => m.id === id);
  }

  function evalNode(nodeId: string) {
    return evaluateMzNode(graph, nodeId, mapData, savedMapExists);
  }

  function resultTissue(r: MzEvalResult): TissueImage {
    return { label: r.tissueLabel || r.tissueId, data: r.data, width: r.width, height: r.height, vmax: maxOf(r.data) };
  }

  let zoomTissue = $state<TissueImage | null>(null);

  // ── Pan / zoom (identyczna matematyka co PreNodesEditor.svelte / BoardCanvas.svelte) ──
  let container = $state<HTMLDivElement | null>(null);
  let viewport = $derived(graph.viewport);

  function setViewport(v: MzGraphViewport) {
    graph = { ...graph, viewport: v };
    persist();
  }
  function setViewportSilent(v: MzGraphViewport) {
    graph = { ...graph, viewport: v };
  }

  function screenToWorld(p: { x: number; y: number }): { x: number; y: number } {
    const rect = container?.getBoundingClientRect();
    const sx = p.x - (rect?.left ?? 0);
    const sy = p.y - (rect?.top ?? 0);
    return { x: (sx - viewport.x) / viewport.zoom, y: (sy - viewport.y) / viewport.zoom };
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

  function nodeWidth(node: MzGraphNode): number {
    if (node.type === "map_source") return 240;
    if (node.type === "combine") return 240;
    if (node.type === "save_output") return 230;
    if (node.type === "curve") return 230;
    return 210;
  }

  // Podgląd mapy pikseli w karcie node'a skaluje wysokość do rzeczywistego
  // stosunku szerokości/wysokości tkanki (zamiast sztywnej wysokości) — inaczej
  // przy tkankach o innym kształcie niż "domyślny" część obrazu była
  // przycinana przez overflow:hidden (nie widać całej tkanki).
  const PREVIEW_MIN_H = 90;
  const PREVIEW_MAX_H = 320;
  function previewHeight(node: MzGraphNode): number {
    const outcome = evalNode(node.id);
    const w = nodeWidth(node) - 20; // szerokość treści karty (padding 10px z każdej strony)
    if (outcome.ok && outcome.value.width > 0 && outcome.value.height > 0) {
      const ratio = outcome.value.height / outcome.value.width;
      return Math.max(PREVIEW_MIN_H, Math.min(PREVIEW_MAX_H, Math.round(w * ratio)));
    }
    return 130;
  }

  function nodeHeight(node: MzGraphNode): number {
    let h = 30 + 20; // header + body padding
    if (node.type === "map_source") {
      h += 30 + 22; // dropdown + toggle
      if (node.expanded) h += 90;
    } else if (node.type === "intensity_range") {
      h += 50;
    } else if (node.type === "curve") {
      h += 110 + 20; // edytor krzywej + podpis
    } else if (node.type === "combine") {
      const n = graph.edges.filter((e) => e.to === node.id).length;
      h += 34 + Math.max(1, n) * 24;
    } else if (node.type === "save_output") {
      h += 30 + 34 + 16;
    }
    h += previewHeight(node) + 10;
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

  // ── Node dragging ──────────────────────────────────────────────────
  let dragNodeId = $state<string | null>(null);
  let dragStart = { x: 0, y: 0 };
  let dragNodeOrigin = { x: 0, y: 0 };

  function onNodeHeaderPointerDown(e: PointerEvent, node: MzGraphNode) {
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

  // ── Połączenia ──────────────────────────────────────────────────
  interface DragConn { nodeId: string; port: "in" | "out"; x: number; y: number; }
  let connDrag = $state<DragConn | null>(null);
  let cursorWorld = $state<{ x: number; y: number }>({ x: 0, y: 0 });

  function portPos(node: MzGraphNode, port: "in" | "out"): { x: number; y: number } {
    const headerH = 30;
    return { x: node.x + (port === "in" ? 0 : nodeWidth(node)), y: node.y + headerH / 2 };
  }

  function onPortPointerDown(e: PointerEvent, node: MzGraphNode, port: "in" | "out") {
    e.stopPropagation();
    const def = MZ_NODE_TYPES[node.type];
    if (port === "in" && !def?.multiInput) {
      // Blender-style: chwytanie za końcówkę już podłączonego (single) wejścia
      // odłącza istniejące połączenie i zaczyna ciągnąć je od strony źródła.
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

  const CONNECT_RADIUS_SCREEN = 26;
  function findNearestPort(pos: { x: number; y: number }, wantPort: "in" | "out", excludeNodeId: string) {
    let best: MzGraphNode | null = null;
    let bestDist = CONNECT_RADIUS_SCREEN / viewport.zoom;
    for (const n of graph.nodes) {
      if (n.id === excludeNodeId) continue;
      const def = MZ_NODE_TYPES[n.type];
      if (!def) continue;
      if (wantPort === "in" && !def.hasInput) continue;
      if (wantPort === "out" && !def.hasOutput) continue;
      const p = portPos(n, wantPort);
      const d = Math.hypot(p.x - pos.x, p.y - pos.y);
      if (d < bestDist) { bestDist = d; best = n; }
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
    if (wouldCreateCycle(graph, fromId, toId)) return;
    const targetNode = graph.nodes.find((n) => n.id === toId);
    const targetDef = targetNode ? MZ_NODE_TYPES[targetNode.type] : undefined;
    if (targetDef?.multiInput) {
      if (graph.edges.some((e) => e.from === fromId && e.to === toId)) return; // no duplicate
      graph.edges.push({ id: makeMzId("edge"), from: fromId, to: toId });
    } else {
      graph.edges = graph.edges.filter((e) => e.to !== toId);
      graph.edges.push({ id: makeMzId("edge"), from: fromId, to: toId });
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

  function nodePos(id: string): MzGraphNode | undefined {
    return graph.nodes.find((n) => n.id === id);
  }

  // ── Menu kontekstowe ──────────────────────────────────────────────
  let paletteOpen = $state(false);
  let palettePos = $state({ screen: { x: 0, y: 0 }, world: { x: 0, y: 0 } });
  let paletteFilter = $state("");
  let paletteMaxHeight = $state(360);

  let nodeMenuOpen = $state(false);
  let nodeMenuTarget = $state<string | null>(null);
  let nodeMenuPos = $state({ x: 0, y: 0 });

  const MENU_MARGIN = 12;

  function onCanvasContextMenu(e: MouseEvent) {
    e.preventDefault();
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

  function onNodeContextMenu(e: MouseEvent, node: MzGraphNode) {
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
  }

  function addNode(typeId: string) {
    const node: MzGraphNode = {
      id: makeMzId("node"),
      type: typeId,
      x: palettePos.world.x,
      y: palettePos.world.y,
      params: mzDefaultParams(typeId),
    };
    if (typeId === "map_source") {
      node.savedMapId = savedMapsList()[0]?.id;
      node.expanded = false;
      ensureMapLoaded(node.savedMapId);
    }
    if (typeId === "intensity_range") {
      node.params = { min: 0, max: 100 };
    }
    if (typeId === "curve") {
      node.curvePoints = DEFAULT_CURVE_POINTS.map((p) => ({ ...p }));
    }
    if (typeId === "combine") {
      node.params = { mode: "mean" };
    }
    if (typeId === "save_output") {
      node.saveName = "";
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
    if (!typing && (e.key === "f" || e.key === "F")) { e.preventDefault(); fitAll(); }
    if (!typing && (e.key === "Delete" || e.key === "Backspace") && hoveredNodeId) {
      e.preventDefault();
      nodeMenuTarget = hoveredNodeId;
      confirmDeleteOpen = true;
    }
  }

  let filteredTypes = $derived(
    MZ_NODE_TYPE_LIST.filter((t) => {
      const q = paletteFilter.trim().toLowerCase();
      if (!q) return true;
      return t.label.toLowerCase().includes(q) || t.description.toLowerCase().includes(q);
    })
  );

  // ── Pola specyficzne dla typów węzłów ──────────────────────────────
  function setNodeSavedMap(node: MzGraphNode, id: string) {
    const idx = graph.nodes.findIndex((n) => n.id === node.id);
    if (idx === -1) return;
    graph.nodes[idx] = { ...graph.nodes[idx], savedMapId: id };
    persist();
    ensureMapLoaded(id);
  }

  function toggleExpanded(node: MzGraphNode) {
    const idx = graph.nodes.findIndex((n) => n.id === node.id);
    if (idx === -1) return;
    graph.nodes[idx] = { ...graph.nodes[idx], expanded: !graph.nodes[idx].expanded };
    persist();
  }

  function setIntensityRange(node: MzGraphNode, lo: number, hi: number) {
    const idx = graph.nodes.findIndex((n) => n.id === node.id);
    if (idx === -1) return;
    graph.nodes[idx] = { ...graph.nodes[idx], params: { ...graph.nodes[idx].params, min: Math.round(lo * 100), max: Math.round(hi * 100) } };
    persist();
  }

  function setCurvePoints(node: MzGraphNode, points: MzCurvePoint[]) {
    const idx = graph.nodes.findIndex((n) => n.id === node.id);
    if (idx === -1) return;
    graph.nodes[idx] = { ...graph.nodes[idx], curvePoints: points };
    persist();
  }

  function setCombineMode(node: MzGraphNode, mode: string) {
    const idx = graph.nodes.findIndex((n) => n.id === node.id);
    if (idx === -1) return;
    graph.nodes[idx] = { ...graph.nodes[idx], params: { ...graph.nodes[idx].params, mode } };
    persist();
  }

  function setSaveName(node: MzGraphNode, value: string) {
    const idx = graph.nodes.findIndex((n) => n.id === node.id);
    if (idx === -1) return;
    graph.nodes[idx] = { ...graph.nodes[idx], saveName: value };
  }

  function inputsFor(node: MzGraphNode): MzGraphEdge[] {
    return graph.edges.filter((e) => e.to === node.id);
  }

  function sourceLabel(nodeId: string): string {
    const n = graph.nodes.find((x) => x.id === nodeId);
    if (!n) return "?";
    if (n.type === "map_source") {
      const meta = savedMapsList().find((m) => m.id === n.savedMapId);
      return meta?.name ?? "— wybierz mapę —";
    }
    if (n.type === "intensity_range") return `Zakres intensywności (${n.params.min ?? 0}–${n.params.max ?? 100}%)`;
    if (n.type === "curve") return `Krzywa intensywności (${n.curvePoints?.length ?? 2} pkt)`;
    if (n.type === "combine") return `Łączenie (${COMBINE_MODE_LABELS[(n.params.mode as CombineMode) ?? "mean"]})`;
    return MZ_NODE_TYPES[n.type]?.label ?? n.type;
  }

  let savingNodeId = $state<string | null>(null);
  let saveStatus = $state<Record<string, string>>({});

  async function saveOutputNode(node: MzGraphNode) {
    const outcome = evalNode(node.id);
    if (!outcome.ok) { saveStatus = { ...saveStatus, [node.id]: outcome.error }; return; }
    const name = (node.saveName ?? "").trim();
    if (!name) { saveStatus = { ...saveStatus, [node.id]: "podaj nazwę" }; return; }
    savingNodeId = node.id;
    try {
      const r = outcome.value;
      await savePixelMap({
        name,
        tissueId: r.tissueId,
        tissueLabel: r.tissueLabel,
        width: r.width,
        height: r.height,
        vmax: maxOf(r.data),
        mode: r.mode,
        sources: r.sources,
        data: r.data,
      });
      saveStatus = { ...saveStatus, [node.id]: `✓ zapisano jako "${name}"` };
    } catch (e) {
      saveStatus = { ...saveStatus, [node.id]: e instanceof Error ? e.message : String(e) };
    } finally {
      savingNodeId = null;
    }
  }

  const savedMapModeLabel: Record<string, string> = { ...COMBINE_MODE_LABELS, single: "pojedyncza" };
</script>

<svelte:window onkeydown={onWindowKeydown} />

<div
  bind:this={container}
  class="mznodes-canvas"
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
  aria-label="Edytor grafu map m/z"
>
  <div class="mznodes-content" style="transform: translate({viewport.x}px, {viewport.y}px) scale({viewport.zoom});">

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
      {@const def = MZ_NODE_TYPES[node.type]}
      {#if def}
        <div class="mnode"
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
            {#if node.type === "map_source"}
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
            {:else if node.type === "intensity_range"}
              <div class="field" onpointerdown={(e) => e.stopPropagation()}>
                <DualRange
                  min={Number(node.params.min ?? 0) / 100}
                  max={Number(node.params.max ?? 100) / 100}
                  ondisprange={(lo, hi) => setIntensityRange(node, lo, hi)}
                />
              </div>
            {:else if node.type === "curve"}
              {@const inEdge = graph.edges.find((e) => e.to === node.id)}
              {@const inOutcome = inEdge ? evalNode(inEdge.from) : null}
              {@const histogram = inOutcome?.ok ? computeHistogram(inOutcome.value.data) : []}
              <div class="field" onpointerdown={(e) => e.stopPropagation()}>
                <CurveEditor
                  points={node.curvePoints ?? DEFAULT_CURVE_POINTS}
                  {histogram}
                  onchange={(points) => setCurvePoints(node, points)}
                />
              </div>
            {:else if node.type === "combine"}
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
                {#if inputsFor(node).length === 0}
                  <div class="combine-list-empty">brak podłączonych map</div>
                {:else}
                  {#each inputsFor(node) as edge (edge.id)}
                    <div class="combine-list-item">
                      <span class="combine-list-label">{sourceLabel(edge.from)}</span>
                      <button class="combine-remove" onclick={() => removeEdge(edge.id)} title="Usuń połączenie">×</button>
                    </div>
                  {/each}
                {/if}
              </div>
            {:else if node.type === "save_output"}
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
            {/if}

            <!-- Podgląd na żywo — dla każdego typu węzła (łańcuch od tego node'a wstecz do źródeł).
                 {#if true} to jedyny sposób, by {@const} mógł tu być użyty (musi być
                 bezpośrednim dzieckiem blokowej konstrukcji, nie zwykłego <div>). -->
            {#if true}
              {@const outcome = evalNode(node.id)}
              <div class="mz-preview" style="height:{previewHeight(node)}px">
                {#if outcome.ok}
                  <IonCanvas
                    tissue={resultTissue(outcome.value)}
                    dispMin={0} dispMax={1} invertColors={false}
                    showColorbar={false} showVmax={false} compact
                  />
                  <button class="mz-zoom-btn" onpointerdown={(e) => e.stopPropagation()}
                          onclick={() => (zoomTissue = resultTissue(outcome.value))} title="Powiększ">⤢</button>
                {:else}
                  <div class="mz-preview-empty">{outcome.error}</div>
                {/if}
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
        {#each MZ_CATEGORY_ORDER as cat (cat)}
          {@const items = filteredTypes.filter((t) => t.category === cat)}
          {#if items.length > 0}
            <div class="ctx-cat">{MZ_CATEGORY_LABELS[cat]}</div>
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

{#if zoomTissue}
  <PixelMapZoomModal tissue={zoomTissue} dispMin={0} dispMax={1} invertColors={false} onclose={() => (zoomTissue = null)} />
{/if}

<style>
  .mznodes-canvas {
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

  .mznodes-content {
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

  .mnode {
    position: absolute;
    background: #222;
    border: 1px solid rgba(255,255,255,0.09);
    border-radius: 10px;
    box-shadow: 0 4px 16px rgba(0,0,0,0.35);
    user-select: none;
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
  .mode-tag, .tissue-tag {
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
</style>
