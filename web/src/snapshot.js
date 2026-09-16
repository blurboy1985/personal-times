// Rasterise a live DOM page into a canvas — word by word at its real layout
// position, in its real font — so the WebGL sheet that turns or unfolds is a
// faithful print of what's on screen, not a screenshot approximation.

const svgImages = new WeakMap();

/** Pre-decode inline charts so they can be painted synchronously later. */
export function warmSvgs(root) {
  root.querySelectorAll('svg[data-snap-svg]').forEach((svg) => {
    if (svgImages.has(svg)) return;
    const img = new Image();
    img.decoding = 'async';
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(svg));
    svgImages.set(svg, img);
  });
}

export function snapshot(page, frame) {
  try {
    return draw(page, frame, true);
  } catch {
    return draw(page, frame, false); // an SVG tainted the canvas (older Safari): print without charts
  }
}

const transparent = (c) => !c || c === 'transparent' || /rgba\([^)]*,\s*0\)$/.test(c);

function draw(page, frame, withSvg) {
  const clip = frame.getBoundingClientRect();
  const scale = Math.min(devicePixelRatio || 1, 2, 4096 / clip.width, 4096 / clip.height);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(clip.width * scale);
  canvas.height = Math.round(clip.height * scale);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(scale, 0, 0, scale, -clip.left * scale, -clip.top * scale);
  ctx.fillStyle = getComputedStyle(frame).backgroundColor;
  ctx.fillRect(clip.left, clip.top, clip.width, clip.height);
  ctx.save();
  ctx.beginPath();
  ctx.rect(clip.left, clip.top, clip.width, clip.height);
  ctx.clip();
  walk(page, { ctx, clip, range: document.createRange(), withSvg }, 1, true);
  ctx.restore();
  if (withSvg) ctx.getImageData(0, 0, 1, 1); // throws SecurityError if tainted
  return canvas;
}

function walk(el, env, alpha, isRoot) {
  if (el.dataset && el.dataset.snap === 'skip') return;
  const cs = getComputedStyle(el);
  if (cs.display === 'none' || cs.visibility === 'hidden') return;
  if (!isRoot) alpha *= parseFloat(cs.opacity);
  if (alpha < .01) return;
  const r = el.getBoundingClientRect();
  const { ctx, clip } = env;
  if (r.bottom < clip.top || r.top > clip.bottom || r.right < clip.left || r.left > clip.right) return;

  ctx.globalAlpha = alpha;
  if (!isRoot) paintBox(ctx, cs, r);

  if (el instanceof SVGSVGElement) {
    const img = env.withSvg && svgImages.get(el);
    if (img && img.complete && img.naturalWidth) ctx.drawImage(img, r.left, r.top, r.width, r.height);
    return;
  }

  const clipped = !isRoot && (cs.overflowX !== 'visible' || cs.overflowY !== 'visible');
  if (clipped) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(r.left, r.top, r.width, r.height);
    ctx.clip();
  }
  for (const child of el.childNodes) {
    if (child.nodeType === 1) walk(child, env, alpha, false);
    else if (child.nodeType === 3) paintText(child, cs, env, alpha);
  }
  if (clipped) ctx.restore();
}

function paintBox(ctx, cs, r) {
  if (!transparent(cs.backgroundColor)) {
    ctx.fillStyle = cs.backgroundColor;
    const radius = parseFloat(cs.borderTopLeftRadius) || 0;
    if (radius && ctx.roundRect) {
      ctx.beginPath();
      ctx.roundRect(r.left, r.top, r.width, r.height, radius);
      ctx.fill();
    } else {
      ctx.fillRect(r.left, r.top, r.width, r.height);
    }
  }
  for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
    const w = parseFloat(cs[`border${side}Width`]);
    const style = cs[`border${side}Style`];
    const color = cs[`border${side}Color`];
    if (!w || style === 'none' || style === 'hidden' || transparent(color)) continue;
    ctx.fillStyle = color;
    const strip = (offset, thickness) => {
      if (side === 'Top') ctx.fillRect(r.left, r.top + offset, r.width, thickness);
      if (side === 'Bottom') ctx.fillRect(r.left, r.bottom - offset - thickness, r.width, thickness);
      if (side === 'Left') ctx.fillRect(r.left + offset, r.top, thickness, r.height);
      if (side === 'Right') ctx.fillRect(r.right - offset - thickness, r.top, thickness, r.height);
    };
    if (style === 'double' && w >= 3) {
      const t = Math.max(1, Math.round(w / 3));
      strip(0, t);
      strip(w - t, t);
    } else {
      strip(0, w);
    }
  }
}

function paintText(node, cs, env, alpha) {
  const text = node.data;
  if (!/\S/.test(text) || transparent(cs.color)) return;
  const { ctx, clip, range } = env;
  ctx.globalAlpha = alpha;
  const caps = cs.fontVariantCaps === 'small-caps' ? 'small-caps ' : '';
  ctx.font = `${cs.fontStyle} ${caps}${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  ctx.fillStyle = cs.color;
  if ('letterSpacing' in ctx) ctx.letterSpacing = cs.letterSpacing === 'normal' ? '0px' : cs.letterSpacing;
  ctx.textBaseline = 'alphabetic';
  const m = ctx.measureText('Hg');
  const size = parseFloat(cs.fontSize);
  const ascent = m.fontBoundingBoxAscent ?? size * .8;
  const descent = m.fontBoundingBoxDescent ?? size * .2;
  const transform = cs.textTransform === 'uppercase' ? (s) => s.toUpperCase()
    : cs.textTransform === 'lowercase' ? (s) => s.toLowerCase() : (s) => s;

  const put = (str, rect) => {
    if (rect.bottom < clip.top || rect.top > clip.bottom) return;
    ctx.fillText(str, rect.left, rect.top + (rect.height - (ascent + descent)) / 2 + ascent);
  };

  const words = /\S+/g;
  let match;
  while ((match = words.exec(text))) {
    range.setStart(node, match.index);
    range.setEnd(node, match.index + match[0].length);
    const rects = range.getClientRects();
    if (!rects.length) continue;
    if (rects.length === 1) {
      put(transform(match[0]), rects[0]);
      continue;
    }
    // The word wraps (hyphenation): place it character by character.
    for (let i = 0; i < match[0].length; i++) {
      range.setStart(node, match.index + i);
      range.setEnd(node, match.index + i + 1);
      const rect = range.getClientRects()[0];
      if (rect) put(transform(match[0][i]), rect);
    }
  }
}
