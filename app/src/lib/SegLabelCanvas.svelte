<script lang="ts">
  // Renderuje mapę etykiet k-means (0..k-1 per piksel) kategoryczną paletą
  // (SEG_PALETTE) zamiast ciągłego LUT-u z colormap.ts — to nie jest
  // intensywność, tylko przynależność do klasy.
  import { SEG_PALETTE } from "./nodegraph.segmentacja";

  interface Props {
    labels: number[][];
    legend?: { label: number; count: number }[];
  }
  let { labels, legend = [] }: Props = $props();

  const RGB = SEG_PALETTE.map((hex) => {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255] as [number, number, number];
  });

  let canvas: HTMLCanvasElement | undefined = $state();

  $effect(() => {
    if (!canvas || labels.length === 0) return;
    const h = labels.length;
    const w = labels[0].length;
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const img = ctx.createImageData(w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const lbl = labels[y][x];
        const idx = (y * w + x) * 4;
        // Sentinel -1 = tło (piksel wykluczony z k-means, patrz runKmeans w
        // nodegraph.segmentacja.ts) — w pełni przezroczyste, nie jest to prawdziwa klasa.
        if (lbl < 0) {
          img.data[idx + 3] = 0;
          continue;
        }
        const [r, g, b] = RGB[lbl % RGB.length];
        img.data[idx] = r; img.data[idx + 1] = g; img.data[idx + 2] = b; img.data[idx + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  });
</script>

<div class="seg-label-wrap">
  <canvas bind:this={canvas} class="seg-label-canvas"></canvas>
  {#if legend.length > 0}
    <div class="seg-legend">
      {#each legend as l (l.label)}
        <span class="seg-legend-item">
          <span class="seg-swatch" style="background:{SEG_PALETTE[l.label % SEG_PALETTE.length]}"></span>
          {l.label}: {l.count}px
        </span>
      {/each}
    </div>
  {/if}
</div>

<style>
  .seg-label-wrap {
    display: flex;
    flex-direction: column;
    gap: 4px;
    height: 100%;
    min-height: 0;
  }
  .seg-label-canvas {
    width: 100%;
    flex: 1;
    min-height: 0;
    image-rendering: pixelated;
    border-radius: 8px;
    background: #1a1a1a;
    object-fit: contain;
    display: block;
  }
  .seg-legend {
    flex-shrink: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
  }
  .seg-legend-item {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 0.58rem;
    color: rgba(255,255,255,0.5);
  }
  .seg-swatch {
    width: 8px;
    height: 8px;
    border-radius: 2px;
    display: inline-block;
    flex-shrink: 0;
  }
</style>
