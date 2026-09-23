<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import Konva from "konva";
  import type {
    BoardObject, BoardTextObject, BoardImageObject, BoardDrawObject, BoardShapeObject,
    BoardViewport, BoardTool, ShapeKind,
  } from "$lib/board.svelte";
  import { assetFullUrl, uploadBoardAsset } from "$lib/board.svelte";

  interface Props {
    objects: BoardObject[];
    viewport: BoardViewport;
    tool?: BoardTool;
    drawColor?: string;
    drawStrokeWidth?: number;
    shapeKind?: ShapeKind;
    shapeFillColor?: string;
    shapeFillTransparent?: boolean;
    shapeStrokeColor?: string;
    shapeStrokeWidth?: number;
    shapeStrokeTransparent?: boolean;
    shapeCornerRadius?: number;
    zoomSensitivity?: number;
    panSensitivity?: number;
    onchange?: (objects: BoardObject[], viewport: BoardViewport) => void;
    oncommit?: () => void;
    onselect?: (ids: string[]) => void;
    ondropfiles?: (files: File[], x: number, y: number) => void;
    ontextplaced?: () => void;
  }

  let {
    objects, viewport, tool = "select", drawColor = "#ffc951", drawStrokeWidth = 4,
    shapeKind = "rect", shapeFillColor = "#ffc951", shapeFillTransparent = false,
    shapeStrokeColor = "#ffc951", shapeStrokeWidth = 2, shapeStrokeTransparent = true,
    shapeCornerRadius = 4,
    zoomSensitivity = 1, panSensitivity = 1,
    onchange, oncommit, onselect, ondropfiles, ontextplaced,
  }: Props = $props();

  let container: HTMLDivElement | undefined = $state();
  let stage: Konva.Stage;
  let objLayer: Konva.Layer;
  let trLayer: Konva.Layer;
  let transformer: Konva.Transformer;
  let selectionRect: Konva.Rect;

  const nodesById = new Map<string, Konva.Node>();
  let selectedIds = new Set<string>();
  let spaceDown = false;
  let selecting = false;
  let selectStart = { x: 0, y: 0 };

  let editingTextarea: HTMLTextAreaElement | null = null;

  let drawing = false;
  let drawPoints: number[] = [];
  let tempLine: Konva.Line | null = null;

  let shapeDrawing = false;
  let shapeStart = { x: 0, y: 0 };
  let tempShape: Konva.Rect | Konva.Ellipse | null = null;

  export function getSelectedIds(): string[] {
    return [...selectedIds];
  }

  export function updateObject(id: string, patch: Partial<BoardObject>): void {
    const node = nodesById.get(id);
    const obj = objects.find((o) => o.id === id);
    if (!node || !obj) return;
    // Obrót zmieniany z panelu (nie przez Transformer) musi pivotować wokół
    // środka obiektu, tak jak robi to uchwyt obrotu na mapie — inaczej box
    // "odjeżdża" bo Konva domyślnie rotuje wokół lewego górnego rogu.
    if (patch.rotation !== undefined && patch.rotation !== obj.rotation) {
      const rad0 = (obj.rotation * Math.PI) / 180;
      const rad1 = (patch.rotation * Math.PI) / 180;
      const hw = obj.width / 2, hh = obj.height / 2;
      const cx = obj.x + hw * Math.cos(rad0) - hh * Math.sin(rad0);
      const cy = obj.y + hw * Math.sin(rad0) + hh * Math.cos(rad0);
      patch = {
        ...patch,
        x: cx - (hw * Math.cos(rad1) - hh * Math.sin(rad1)),
        y: cy - (hw * Math.sin(rad1) + hh * Math.cos(rad1)),
      };
    }
    Object.assign(obj, patch);
    applyObjectToNode(obj, node);
    objLayer.batchDraw();
    emitChange(true);
  }

  export function deleteSelected(): void {
    if (selectedIds.size === 0) return;
    objects = objects.filter((o) => !selectedIds.has(o.id));
    for (const id of selectedIds) {
      nodesById.get(id)?.destroy();
      nodesById.delete(id);
    }
    clearSelection();
    objLayer.batchDraw();
    emitChange(true);
  }

  export function addText(atWorld?: { x: number; y: number }, autoEdit = false): void {
    const id = crypto.randomUUID();
    const center = atWorld ?? stageCenterInWorld();
    const obj: BoardTextObject = {
      id, type: "text", x: center.x - 80, y: center.y - 20,
      width: 160, height: 40, rotation: 0, opacity: 1,
      zIndex: nextZ(), content: "Nowy tekst", color: "#f0f0f0", fontSize: 20, bold: false,
      align: "left", borderEnabled: false, borderColor: "#000000", borderWidth: 1.5,
    };
    objects = [...objects, obj];
    const node = createNode(obj);
    objLayer.batchDraw();
    selectOnly(id);
    emitChange(true);
    if (autoEdit) startTextEdit(node as Konva.Text, obj);
  }

  // Dodaje tekst pod kursorem myszy (jeśli jest nad tablicą), inaczej na środku
  // widocznego obszaru — pod skrót klawiszowy "T".
  export function addTextAtCursorOrCenter(): void {
    const pointer = stage?.getPointerPosition();
    addText(pointer ? screenToWorld(pointer) : undefined, true);
  }

  export async function addImageFromFile(file: File, boardId: string): Promise<void> {
    const res = await uploadBoardAsset(boardId, file);
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const maxDim = 320;
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const center = stageCenterInWorld();
      const w = img.width * scale, h = img.height * scale;
      const obj: BoardImageObject = {
        id: crypto.randomUUID(), type: "image",
        x: center.x - w / 2, y: center.y - h / 2,
        width: w, height: h, rotation: 0, opacity: 1,
        zIndex: nextZ(), assetUrl: res.url,
      };
      objects = [...objects, obj];
      createNode(obj);
      objLayer.batchDraw();
      selectOnly(obj.id);
      emitChange(true);
      URL.revokeObjectURL(url);
    };
    img.src = url;
  }

  export function pasteClipboard(clip: BoardObject[]): void {
    if (!clip.length) return;
    const ids: string[] = [];
    for (const src of clip) {
      const id = crypto.randomUUID();
      const copy = { ...src, id, x: src.x + 24, y: src.y + 24, zIndex: nextZ() };
      objects = [...objects, copy];
      createNode(copy);
      ids.push(id);
    }
    objLayer.batchDraw();
    selectMany(ids);
    emitChange(true);
  }

  export function copySelected(): BoardObject[] {
    return objects.filter((o) => selectedIds.has(o.id)).map((o) => ({ ...o }));
  }

  // ── Z-order (warstwy) — sterowane strzałkami ↑/↓ ──────────────────────
  // "Inteligentne" przeskakiwanie: zamiast przesuwać się o jeden poziom z-index
  // na ślepo, szukamy najbliższego obiektu, który faktycznie nachodzi (bbox)
  // na zaznaczony, i przeskakujemy od razu nad/pod niego — obiekty, które się
  // nie stykają, są pomijane.
  export function raiseSelected(): void {
    if (selectedIds.size === 0) return;
    const sel = [...selectedIds].map((id) => nodesById.get(id)).filter(Boolean) as Konva.Node[];
    sel.sort((a, b) => b.zIndex() - a.zIndex());
    for (const n of sel) {
      const rect = n.getClientRect();
      const siblings = objLayer.children ?? [];
      const idx = siblings.indexOf(n as any);
      let targetIdx = -1;
      for (let i = idx + 1; i < siblings.length; i++) {
        if (siblings[i] === transformer || siblings[i] === selectionRect) continue;
        if (Konva.Util.haveIntersection(rect, siblings[i].getClientRect())) { targetIdx = i; break; }
      }
      if (targetIdx !== -1) n.zIndex(targetIdx);
    }
    syncZIndexFromLayer();
    objLayer.batchDraw();
    emitChange(true);
  }

  export function lowerSelected(): void {
    if (selectedIds.size === 0) return;
    const sel = [...selectedIds].map((id) => nodesById.get(id)).filter(Boolean) as Konva.Node[];
    sel.sort((a, b) => a.zIndex() - b.zIndex());
    for (const n of sel) {
      const rect = n.getClientRect();
      const siblings = objLayer.children ?? [];
      const idx = siblings.indexOf(n as any);
      let targetIdx = -1;
      for (let i = idx - 1; i >= 0; i--) {
        if (Konva.Util.haveIntersection(rect, siblings[i].getClientRect())) { targetIdx = i; break; }
      }
      if (targetIdx !== -1) n.zIndex(targetIdx);
    }
    syncZIndexFromLayer();
    objLayer.batchDraw();
    emitChange(true);
  }

  function syncZIndexFromLayer(): void {
    objLayer.children?.forEach((n, i) => {
      const obj = objects.find((o) => o.id === n.id());
      if (obj) obj.zIndex = i;
    });
  }

  // ── Eksport PNG (cała zawartość tablicy, nie tylko widoczny fragment) ──
  export function exportPNG(): void {
    const rect = objLayer.getClientRect({ skipTransform: true });
    if (!rect.width || !rect.height) return;
    const pad = 40;
    const prevScale = { x: stage.scaleX(), y: stage.scaleY() };
    const prevPos = { x: stage.x(), y: stage.y() };
    const prevSize = { w: stage.width(), h: stage.height() };
    const hadSelection = selectedIds.size > 0;
    transformer.hide(); selectionRect.hide(); trLayer.batchDraw();
    stage.scale({ x: 1, y: 1 });
    stage.position({ x: -rect.x + pad, y: -rect.y + pad });
    stage.width(rect.width + pad * 2);
    stage.height(rect.height + pad * 2);
    stage.batchDraw();
    const uri = stage.toDataURL({ pixelRatio: 2, mimeType: "image/png" });
    stage.scale(prevScale);
    stage.position(prevPos);
    stage.width(prevSize.w);
    stage.height(prevSize.h);
    if (hadSelection) transformer.show();
    stage.batchDraw();
    const a = document.createElement("a");
    a.href = uri;
    a.download = "tablica.png";
    a.click();
  }

  export function zoomBy(dir: 1 | -1): void {
    const w = container?.clientWidth ?? 800;
    const h = container?.clientHeight ?? 600;
    const center = { x: w / 2, y: h / 2 };
    const oldScale = viewport.zoom;
    const pointTo = { x: (center.x - viewport.x) / oldScale, y: (center.y - viewport.y) / oldScale };
    const newScale = Math.max(0.1, Math.min(4, oldScale * (1 + dir * 0.15)));
    viewport = {
      zoom: newScale,
      x: center.x - pointTo.x * newScale,
      y: center.y - pointTo.y * newScale,
    };
    applyStageTransform();
    emitChange();
  }

  // Dopasowuje widok tak, by wszystkie obiekty były widoczne na środku —
  // niezależnie od aktualnej pozycji/zoomu. Skrót "F".
  export function fitToContent(): void {
    if (objects.length === 0) return;
    const rect = objLayer.getClientRect({ skipTransform: true });
    if (!rect.width || !rect.height) return;
    const w = container?.clientWidth ?? 800;
    const h = container?.clientHeight ?? 600;
    const pad = 60;
    const newScale = Math.max(0.1, Math.min(2, Math.min(
      (w - pad * 2) / rect.width,
      (h - pad * 2) / rect.height,
    )));
    const cx = rect.x + rect.width / 2;
    const cy = rect.y + rect.height / 2;
    viewport = {
      zoom: newScale,
      x: w / 2 - cx * newScale,
      y: h / 2 - cy * newScale,
    };
    applyStageTransform();
    emitChange();
  }

  function nextZ(): number {
    return objects.reduce((m, o) => Math.max(m, o.zIndex), -1) + 1;
  }

  function screenToWorld(p: { x: number; y: number }): { x: number; y: number } {
    return { x: (p.x - viewport.x) / viewport.zoom, y: (p.y - viewport.y) / viewport.zoom };
  }

  function stageCenterInWorld(): { x: number; y: number } {
    const w = container?.clientWidth ?? 800;
    const h = container?.clientHeight ?? 600;
    return screenToWorld({ x: w / 2, y: h / 2 });
  }

  function emitChange(committed = false): void {
    onchange?.(objects, viewport);
    if (committed) oncommit?.();
  }

  function applyObjectToNode(obj: BoardObject, node: Konva.Node): void {
    node.position({ x: obj.x, y: obj.y });
    node.rotation(obj.rotation);
    node.opacity(obj.opacity);
    node.size({ width: obj.width, height: obj.height });
    if (obj.type === "text") {
      const t = node as Konva.Text;
      t.text(obj.content);
      t.fill(obj.color);
      t.fontSize(obj.fontSize);
      t.fontStyle(obj.bold ? "bold" : "normal");
      t.align(obj.align ?? "left");
      // Obrys (text-stroke) wokół liter — fallbacky na wypadek starszych,
      // zapisanych wcześniej obiektów bez tych pól (undefined = Konva po
      // cichu ignorował ustawienie, co wyglądało jakby "nie działało").
      t.stroke(obj.borderEnabled ? (obj.borderColor ?? "#000000") : "");
      t.strokeWidth(obj.borderEnabled ? (obj.borderWidth ?? 1.5) : 0);
      t.fillAfterStrokeEnabled(true);
    } else if (obj.type === "draw") {
      const l = node as Konva.Line;
      l.stroke(obj.color);
      l.strokeWidth(obj.strokeWidth);
      l.hitStrokeWidth(Math.max(14, obj.strokeWidth));
      l.points(obj.points);
    } else if (obj.type === "shape") {
      const s = obj as BoardShapeObject;
      const shapeNode = node as Konva.Shape;
      shapeNode.fill(s.fillTransparent ? "" : s.fillColor);
      shapeNode.stroke(s.strokeTransparent ? "" : s.strokeColor);
      shapeNode.strokeWidth(s.strokeTransparent ? 0 : s.strokeWidth);
      if (s.shape === "ellipse") {
        const e = node as Konva.Ellipse;
        // Ellipse rysuje się zawsze wyśrodkowana na (0,0) lokalnie — offset
        // przesuwa ten środek tak, by node.x/y dalej znaczyło "lewy górny róg"
        // bboxa (spójnie z resztą typów), więc generyczny obrót-wokół-środka
        // z updateObject() działa bez specjalnych wyjątków.
        e.radiusX(obj.width / 2);
        e.radiusY(obj.height / 2);
        e.offsetX(-obj.width / 2);
        e.offsetY(-obj.height / 2);
      } else {
        (node as Konva.Rect).cornerRadius(s.cornerRadius ?? 0);
      }
    }
  }

  function createNode(obj: BoardObject): Konva.Node {
    let node: Konva.Node;
    if (obj.type === "image") {
      const imgEl = new Image();
      const konvaImg = new Konva.Image({
        id: obj.id, x: obj.x, y: obj.y, width: obj.width, height: obj.height,
        rotation: obj.rotation, opacity: obj.opacity, draggable: true,
        image: imgEl,
      });
      imgEl.crossOrigin = "anonymous";
      imgEl.onload = () => { konvaImg.image(imgEl); objLayer.batchDraw(); };
      imgEl.src = assetFullUrl(obj.assetUrl);
      node = konvaImg;
    } else if (obj.type === "draw") {
      const d = obj as BoardDrawObject;
      node = new Konva.Line({
        id: obj.id, x: obj.x, y: obj.y, points: d.points,
        stroke: d.color, strokeWidth: d.strokeWidth,
        hitStrokeWidth: Math.max(14, d.strokeWidth),
        lineCap: "round", lineJoin: "round", tension: 0.3,
        rotation: obj.rotation, opacity: obj.opacity, draggable: true,
        width: obj.width, height: obj.height,
      });
    } else if (obj.type === "shape") {
      const s = obj as BoardShapeObject;
      const common = {
        id: obj.id, rotation: obj.rotation, opacity: obj.opacity, draggable: true,
        width: obj.width, height: obj.height,
        fill: s.fillTransparent ? "" : s.fillColor,
        stroke: s.strokeTransparent ? "" : s.strokeColor,
        strokeWidth: s.strokeTransparent ? 0 : s.strokeWidth,
      };
      if (s.shape === "ellipse") {
        node = new Konva.Ellipse({
          ...common, x: obj.x, y: obj.y,
          offsetX: -obj.width / 2, offsetY: -obj.height / 2,
          radiusX: obj.width / 2, radiusY: obj.height / 2,
        });
      } else {
        node = new Konva.Rect({ ...common, x: obj.x, y: obj.y, cornerRadius: s.cornerRadius ?? 0 });
      }
    } else {
      const t = obj as BoardTextObject;
      node = new Konva.Text({
        id: obj.id, x: obj.x, y: obj.y, width: obj.width, height: obj.height,
        rotation: obj.rotation, opacity: obj.opacity, draggable: true,
        text: t.content, fill: t.color, fontSize: t.fontSize, align: t.align ?? "left",
        fontStyle: t.bold ? "bold" : "normal", fontFamily: "JetBrains Mono, monospace",
        wrap: "word",
        stroke: t.borderEnabled ? (t.borderColor ?? "#000000") : "",
        strokeWidth: t.borderEnabled ? (t.borderWidth ?? 1.5) : 0,
        fillAfterStrokeEnabled: true,
      });
      node.on("dblclick dbltap", () => startTextEdit(node as Konva.Text, t));
    }
    node.on("click tap", (e) => {
      e.cancelBubble = true;
      const shift = (e.evt as MouseEvent).shiftKey;
      if (shift) toggleSelect(obj.id); else selectOnly(obj.id);
    });
    node.on("dragstart", () => { if (!selectedIds.has(obj.id)) selectOnly(obj.id); });
    node.on("dragmove", () => syncFromNode(obj.id, node));
    node.on("transform", () => syncFromNode(obj.id, node, true));
    node.on("dragend transformend", () => emitChange(true));
    objLayer.add(node as any);
    nodesById.set(obj.id, node);
    return node;
  }

  function syncFromNode(id: string, node: Konva.Node, isTransform = false): void {
    const obj = objects.find((o) => o.id === id);
    if (!obj) return;
    obj.x = node.x();
    obj.y = node.y();
    obj.rotation = node.rotation();
    if (isTransform) {
      const scaleX = node.scaleX(), scaleY = node.scaleY();
      if (obj.type === "draw") {
        // Konva.Line nie ma własnego "width/height" używanego do renderu —
        // trzeba samemu wpiec skalę w punkty ścieżki, inaczej po zresetowaniu
        // node.scale() do 1 rysunek wróciłby do starego rozmiaru.
        obj.points = obj.points.map((v, i) => (i % 2 === 0 ? v * scaleX : v * scaleY));
        obj.width = Math.max(1, obj.width * scaleX);
        obj.height = Math.max(1, obj.height * scaleY);
      } else {
        // Resize zmienia tylko rozmiar boxu (dla tekstu: box zawijania) —
        // fontSize/rozmiar czcionki pozostaje bez zmian, tak jak w Miro.
        obj.width = Math.max(20, node.width() * scaleX);
        obj.height = Math.max(obj.type === "text" ? 10 : 20, node.height() * scaleY);
      }
      node.scale({ x: 1, y: 1 });
      applyObjectToNode(obj, node);
    }
  }

  function startTextEdit(node: Konva.Text, obj: BoardTextObject): void {
    if (!container) return;
    node.hide();
    transformer.hide();
    objLayer.batchDraw();
    // getAbsolutePosition() zwraca pozycję węzła już we współrzędnych ekranu
    // (uwzględnia pan/zoom stage'a) — potrzebne, by nakładka <textarea>
    // pojawiła się dokładnie nad tekstem na mapie, a nie w losowym miejscu.
    const abs = node.getAbsolutePosition();
    const scale = viewport.zoom;
    const ta = document.createElement("textarea");
    ta.value = obj.content;
    Object.assign(ta.style, {
      position: "absolute",
      top: `${abs.y}px`, left: `${abs.x}px`,
      width: `${obj.width * scale}px`, height: `${obj.height * scale}px`,
      minWidth: "40px", minHeight: "24px",
      fontSize: `${obj.fontSize * scale}px`, color: obj.color,
      fontWeight: obj.bold ? "700" : "400",
      textAlign: obj.align ?? "left",
      transformOrigin: "top left",
      transform: obj.rotation ? `rotate(${obj.rotation}deg)` : "none",
      fontFamily: "JetBrains Mono, monospace", background: "rgba(20,20,20,0.55)",
      border: "1px dashed #ffc951", outline: "none", resize: "both",
      padding: "2px", margin: "0", overflow: "auto", zIndex: "50",
      lineHeight: "1.2",
    } as CSSStyleDeclaration);
    container.appendChild(ta);
    ta.focus();
    ta.select();
    editingTextarea = ta;
    let committed = false;
    let liveTimer: ReturnType<typeof setTimeout> | null = null;
    // Zapisujemy treść do obiektu NA BIEŻĄCO (na każde naciśnięcie klawisza),
    // a nie dopiero przy "blur" — blur bywa zawodny (np. gdy edycja zostanie
    // przerwana przełączeniem tablicy/zamknięciem apki) i typowany tekst
    // potrafił się wtedy zgubić, wracając do domyślnego "Nowy tekst".
    ta.addEventListener("input", () => {
      obj.content = ta.value;
      if (liveTimer) clearTimeout(liveTimer);
      liveTimer = setTimeout(() => emitChange(true), 400);
    });
    function commit() {
      if (committed) return;
      committed = true;
      if (liveTimer) clearTimeout(liveTimer);
      obj.content = ta.value;
      // Jeśli użytkownik ręcznie powiększył textarea (uchwyt resize), przenieś
      // nowy rozmiar z powrotem na obiekt (w jednostkach świata, nie ekranu).
      obj.width = Math.max(20, ta.offsetWidth / scale);
      obj.height = Math.max(10, ta.offsetHeight / scale);
      // Węzeł został tylko ukryty (node.hide()) — jego x/y/rotation cały czas
      // odzwierciedlają rzeczywistą (np. wcześniej przeciągniętą) pozycję.
      // Synchronizujemy się z nim, żeby applyObjectToNode niczego nie cofnęło.
      obj.x = node.x();
      obj.y = node.y();
      obj.rotation = node.rotation();
      applyObjectToNode(obj, node);
      node.show();
      transformer.show();
      ta.remove();
      if (editingTextarea === ta) editingTextarea = null;
      objLayer.batchDraw();
      emitChange(true);
    }
    ta.addEventListener("blur", commit);
    ta.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") { ta.value = obj.content; commit(); }
    });
  }

  // Wymusza zapis aktywnie edytowanego tekstu — wywoływane przed ryzykownymi
  // operacjami (przełączenie tablicy, cofnięcie, odmontowanie), żeby edycja
  // w toku nigdy nie została po cichu porzucona.
  export function flushTextEdit(): void {
    editingTextarea?.blur();
  }

  function selectOnly(id: string): void {
    selectedIds = new Set([id]);
    applySelection();
  }
  function selectMany(ids: string[]): void {
    selectedIds = new Set(ids);
    applySelection();
  }
  function toggleSelect(id: string): void {
    if (selectedIds.has(id)) selectedIds.delete(id); else selectedIds.add(id);
    applySelection();
  }
  export function clearSelection(): void {
    selectedIds = new Set();
    applySelection();
  }
  function applySelection(): void {
    const nodes = [...selectedIds].map((id) => nodesById.get(id)).filter(Boolean) as Konva.Node[];
    transformer.nodes(nodes);
    transformer.enabledAnchors([
      "top-left", "top-center", "top-right", "middle-right",
      "middle-left", "bottom-left", "bottom-center", "bottom-right",
    ]);
    trLayer.batchDraw();
    onselect?.([...selectedIds]);
  }

  function applyStageTransform(): void {
    stage.position({ x: viewport.x, y: viewport.y });
    stage.scale({ x: viewport.zoom, y: viewport.zoom });
    stage.batchDraw();
  }

  function updateCursor(): void {
    if (!container) return;
    container.style.cursor = tool === "draw" || tool === "shape" || tool === "text" ? "crosshair" : spaceDown ? "grab" : "default";
  }
  $effect(() => { tool; updateCursor(); });

  onMount(() => {
    if (!container) return;
    stage = new Konva.Stage({
      container, width: container.clientWidth, height: container.clientHeight,
    });
    objLayer = new Konva.Layer();
    trLayer = new Konva.Layer();
    stage.add(objLayer);
    stage.add(trLayer);

    transformer = new Konva.Transformer({
      rotateEnabled: true, borderStroke: "#ffc951", anchorStroke: "#ffc951",
      anchorFill: "#1a1a1a", anchorSize: 9, borderDash: [4, 4],
    });
    trLayer.add(transformer);

    selectionRect = new Konva.Rect({
      fill: "rgba(255,201,81,0.12)", stroke: "#ffc951", strokeWidth: 1, visible: false,
    });
    trLayer.add(selectionRect);

    for (const obj of [...objects].sort((a, b) => a.zIndex - b.zIndex)) createNode(obj);
    objLayer.batchDraw();
    applyStageTransform();
    updateCursor();

    stage.on("mousedown touchstart", (e) => {
      if (e.target !== stage) return;
      // Kliknięcie w puste miejsce mapy zawsze odznacza — niezależnie od
      // aktywnego narzędzia (nie tylko w trybie zaznaczania).
      if (selectedIds.size > 0) clearSelection();
      if (tool === "text") {
        const pos = stage.getRelativePointerPosition();
        if (pos) { addText(pos, true); ontextplaced?.(); }
        return;
      }
      if (tool === "draw") {
        drawing = true;
        const pos = stage.getRelativePointerPosition();
        if (!pos) return;
        drawPoints = [pos.x, pos.y];
        tempLine = new Konva.Line({
          points: drawPoints, stroke: drawColor, strokeWidth: drawStrokeWidth,
          lineCap: "round", lineJoin: "round", tension: 0.3,
        });
        objLayer.add(tempLine);
        return;
      }
      if (tool === "shape") {
        shapeDrawing = true;
        const pos = stage.getRelativePointerPosition();
        if (!pos) return;
        shapeStart = pos;
        const fillAttrs = {
          fill: shapeFillTransparent ? "" : shapeFillColor,
          stroke: shapeStrokeTransparent ? "" : shapeStrokeColor,
          strokeWidth: shapeStrokeTransparent ? 0 : shapeStrokeWidth,
        };
        tempShape = shapeKind === "ellipse"
          ? new Konva.Ellipse({ x: pos.x, y: pos.y, radiusX: 0, radiusY: 0, ...fillAttrs })
          : new Konva.Rect({ x: pos.x, y: pos.y, width: 0, height: 0, cornerRadius: shapeCornerRadius, ...fillAttrs });
        objLayer.add(tempShape);
        return;
      }
      selecting = true;
      const pos = stage.getRelativePointerPosition();
      if (!pos) return;
      selectStart = pos;
      selectionRect.setAttrs({ x: pos.x, y: pos.y, width: 0, height: 0, visible: true });
    });
    stage.on("mousemove touchmove", (e) => {
      if (drawing && tempLine) {
        const pos = stage.getRelativePointerPosition();
        if (!pos) return;
        drawPoints = [...drawPoints, pos.x, pos.y];
        tempLine.points(drawPoints);
        objLayer.batchDraw();
        return;
      }
      if (shapeDrawing && tempShape) {
        const pos = stage.getRelativePointerPosition();
        if (!pos) return;
        let w = pos.x - shapeStart.x;
        let h = pos.y - shapeStart.y;
        if ((e.evt as MouseEvent).shiftKey) {
          const m = Math.max(Math.abs(w), Math.abs(h));
          w = Math.sign(w || 1) * m;
          h = Math.sign(h || 1) * m;
        }
        const x = Math.min(shapeStart.x, shapeStart.x + w);
        const y = Math.min(shapeStart.y, shapeStart.y + h);
        const aw = Math.abs(w), ah = Math.abs(h);
        if (shapeKind === "ellipse") {
          (tempShape as Konva.Ellipse).setAttrs({ x: x + aw / 2, y: y + ah / 2, radiusX: aw / 2, radiusY: ah / 2 });
        } else {
          tempShape.setAttrs({ x, y, width: aw, height: ah });
        }
        objLayer.batchDraw();
        return;
      }
      if (!selecting) return;
      const pos = stage.getRelativePointerPosition();
      if (!pos) return;
      selectionRect.setAttrs({
        x: Math.min(selectStart.x, pos.x), y: Math.min(selectStart.y, pos.y),
        width: Math.abs(pos.x - selectStart.x), height: Math.abs(pos.y - selectStart.y),
      });
      trLayer.batchDraw();
    });
    stage.on("mouseup touchend", () => {
      if (drawing) {
        drawing = false;
        tempLine?.destroy();
        tempLine = null;
        if (drawPoints.length >= 4) finalizeDrawing(drawPoints);
        drawPoints = [];
        objLayer.batchDraw();
        return;
      }
      if (shapeDrawing) {
        shapeDrawing = false;
        let box: { x: number; y: number; width: number; height: number } | null = null;
        if (tempShape) {
          box = shapeKind === "ellipse"
            ? {
                x: tempShape.x() - (tempShape as Konva.Ellipse).radiusX(),
                y: tempShape.y() - (tempShape as Konva.Ellipse).radiusY(),
                width: (tempShape as Konva.Ellipse).radiusX() * 2,
                height: (tempShape as Konva.Ellipse).radiusY() * 2,
              }
            : { x: tempShape.x(), y: tempShape.y(), width: tempShape.width(), height: tempShape.height() };
        }
        tempShape?.destroy();
        tempShape = null;
        if (box && box.width > 3 && box.height > 3) finalizeShape(box.x, box.y, box.width, box.height);
        objLayer.batchDraw();
        return;
      }
      if (!selecting) return;
      selecting = false;
      const box = selectionRect.getClientRect();
      selectionRect.visible(false);
      if (box.width > 2 && box.height > 2) {
        const hits: string[] = [];
        for (const [id, node] of nodesById) {
          if (Konva.Util.haveIntersection(box, node.getClientRect())) hits.push(id);
        }
        selectMany(hits);
      }
      trLayer.batchDraw();
    });

    stage.on("wheel", (e) => {
      e.evt.preventDefault();
      if (e.evt.ctrlKey || e.evt.metaKey) {
        const pointer = stage.getPointerPosition();
        if (!pointer) return;
        const oldScale = viewport.zoom;
        const mousePointTo = {
          x: (pointer.x - viewport.x) / oldScale,
          y: (pointer.y - viewport.y) / oldScale,
        };
        const dir = e.evt.deltaY > 0 ? -1 : 1;
        const newScale = Math.max(0.1, Math.min(4, oldScale * (1 + dir * 0.08 * zoomSensitivity)));
        viewport = {
          zoom: newScale,
          x: pointer.x - mousePointTo.x * newScale,
          y: pointer.y - mousePointTo.y * newScale,
        };
      } else {
        viewport = {
          ...viewport,
          x: viewport.x - e.evt.deltaX * panSensitivity,
          y: viewport.y - e.evt.deltaY * panSensitivity,
        };
      }
      applyStageTransform();
      emitChange();
    });

    function onKeydown(e: KeyboardEvent) {
      if (e.code === "Space") { spaceDown = true; stage.draggable(true); updateCursor(); }
    }
    function onKeyup(e: KeyboardEvent) {
      if (e.code === "Space") { spaceDown = false; stage.draggable(false); updateCursor(); }
    }
    window.addEventListener("keydown", onKeydown);
    window.addEventListener("keyup", onKeyup);

    stage.on("dragend", () => {
      if (spaceDown) {
        viewport = { ...viewport, x: stage.x(), y: stage.y() };
        emitChange();
      }
    });

    function onResize() {
      if (!container) return;
      stage.width(container.clientWidth);
      stage.height(container.clientHeight);
    }
    const ro = new ResizeObserver(onResize);
    ro.observe(container);

    function onDrop(e: DragEvent) {
      e.preventDefault();
      const files = [...(e.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith("image/"));
      if (files.length && container) {
        const rect = container.getBoundingClientRect();
        ondropfiles?.(files, e.clientX - rect.left, e.clientY - rect.top);
      }
    }
    function onDragOver(e: DragEvent) { e.preventDefault(); }
    container.addEventListener("drop", onDrop);
    container.addEventListener("dragover", onDragOver);

    onDestroy(() => {
      window.removeEventListener("keydown", onKeydown);
      window.removeEventListener("keyup", onKeyup);
      container?.removeEventListener("drop", onDrop);
      container?.removeEventListener("dragover", onDragOver);
      ro.disconnect();
      stage.destroy();
    });
  });

  function finalizeDrawing(pts: number[]): void {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < pts.length; i += 2) {
      minX = Math.min(minX, pts[i]); maxX = Math.max(maxX, pts[i]);
      minY = Math.min(minY, pts[i + 1]); maxY = Math.max(maxY, pts[i + 1]);
    }
    // Samo kliknięcie (bez przeciągnięcia myszą) nie powinno nic rysować —
    // inaczej powstawała niewidoczna "kropka" (zdegenerowana, prawie zerowej
    // wielkości linia) za każdym pojedynczym kliknięciem pędzlem.
    if (maxX - minX < 3 && maxY - minY < 3) return;
    const pad = Math.max(4, drawStrokeWidth);
    const x = minX - pad, y = minY - pad;
    const local: number[] = [];
    for (let i = 0; i < pts.length; i += 2) { local.push(pts[i] - x, pts[i + 1] - y); }
    const obj: BoardDrawObject = {
      id: crypto.randomUUID(), type: "draw",
      x, y, width: Math.max(1, maxX - minX + pad * 2), height: Math.max(1, maxY - minY + pad * 2),
      rotation: 0, opacity: 1, zIndex: nextZ(),
      points: local, color: drawColor, strokeWidth: drawStrokeWidth,
    };
    objects = [...objects, obj];
    createNode(obj);
    objLayer.batchDraw();
    selectOnly(obj.id);
    emitChange(true);
  }

  function finalizeShape(x: number, y: number, width: number, height: number): void {
    const obj: BoardShapeObject = {
      id: crypto.randomUUID(), type: "shape", shape: shapeKind,
      x, y, width, height, rotation: 0, opacity: 1, zIndex: nextZ(),
      fillColor: shapeFillColor, fillTransparent: shapeFillTransparent,
      strokeColor: shapeStrokeColor, strokeWidth: shapeStrokeWidth, strokeTransparent: shapeStrokeTransparent,
      cornerRadius: shapeKind === "rect" ? shapeCornerRadius : 0,
    };
    objects = [...objects, obj];
    createNode(obj);
    objLayer.batchDraw();
    selectOnly(obj.id);
    emitChange(true);
  }

  // ── Tło w kropki — "poziomy szczegółowości" jak siatka w Miro: zamiast
  // kropek kurczących się do zera przy zoom-out (lub puchnących w nieskoń-
  // czoność przy zoom-in), odstęp w jednostkach świata skacze o potęgi 2,
  // tak by odstęp na ekranie zawsze mieścił się w rozsądnym przedziale —
  // promień kropki zostaje stały, dzięki czemu "mniej się ich pokazuje" im
  // dalej odjeżdżamy, zamiast robić się mikroskopijne.
  let dotSpacingWorld = $derived.by(() => {
    let level = 26;
    while (level * viewport.zoom < 16) level *= 2;
    while (level * viewport.zoom > 42) level /= 2;
    return level;
  });
  const dotRadius = 1.3;
</script>

<div
  bind:this={container}
  class="board-canvas"
  style="
    background-position: {viewport.x}px {viewport.y}px;
    background-size: {dotSpacingWorld * viewport.zoom}px {dotSpacingWorld * viewport.zoom}px;
    background-image: radial-gradient(rgba(255,255,255,0.16) {dotRadius}px, transparent {dotRadius}px);
  "
></div>

<style>
  .board-canvas {
    position: relative;
    width: 100%;
    height: 100%;
    background-color: #1c1c1c;
    overflow: hidden;
    cursor: default;
  }
</style>
