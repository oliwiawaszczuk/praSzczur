<script lang="ts">
  // Podgląd segmentu (SegmentValue — maska 0/1). Świadomie NIE przez
  // colormap.ts (ten sam LUT co ciągła intensywność m/z) — segment to nie
  // intensywność, tylko przynależność tak/nie, więc dostaje własną, stałą
  // konwencję kolorów (patrz komentarz przy SegmentValue w nodegraph.ts):
  // CZARNY = segment (1), BIAŁY = poza segmentem ale w obrębie tkanki (0),
  // w pełni przezroczyste = poza faktycznym skanem tkanki (mask[y][x] === 0,
  // ten sam sentinel-wzorzec co w SegLabelCanvas).
  interface Props {
    data: number[][];
    mask?: number[][];
  }
  let { data, mask }: Props = $props();

  let canvas: HTMLCanvasElement | undefined = $state();

  $effect(() => {
    if (!canvas || data.length === 0) return;
    const h = data.length;
    const w = data[0].length;
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const img = ctx.createImageData(w, h);
    for (let y = 0; y < h; y++) {
      const maskRow = mask?.[y];
      for (let x = 0; x < w; x++) {
        const idx = (y * w + x) * 4;
        if (maskRow && maskRow[x] === 0) {
          img.data[idx + 3] = 0;
          continue;
        }
        const v = data[y][x] >= 0.5 ? 0 : 255; // czarny = segment, biały = tło tkanki
        img.data[idx] = v; img.data[idx + 1] = v; img.data[idx + 2] = v; img.data[idx + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  });
</script>

<canvas bind:this={canvas} class="segment-mask-canvas"></canvas>

<style>
  .segment-mask-canvas {
    width: 100%;
    height: 100%;
    image-rendering: pixelated;
    border-radius: 8px;
    background: #1a1a1a;
    object-fit: contain;
    display: block;
  }
</style>
