const { THREE } = require("./runtime");
function splitGraphemes(text) {
  if (typeof Intl !== "undefined" && Intl.Segmenter)
    return Array.from(
      new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text),
      (part) => part.segment,
    );
  // Keep common emoji modifiers, combining marks and ZWJ sequences together.
  const result = [];
  for (const char of Array.from(text)) {
    if (
      result.length &&
      (/^[\u0300-\u036f\ufe00-\ufe0f\u200d]$/.test(char) ||
        /[\u{1f3fb}-\u{1f3ff}]/u.test(char) ||
        result[result.length - 1].endsWith("\u200d"))
    )
      result[result.length - 1] += char;
    else result.push(char);
  }
  return result;
}
function layoutText(text, measure, maxWidth = 560) {
  const lines = [];
  for (const paragraph of String(text).replace(/\r\n?/g, "\n").split("\n")) {
    let line = "";
    for (const char of splitGraphemes(paragraph)) {
      if (line && measure(line + char) > maxWidth) {
        lines.push(line);
        line = "";
      }
      line += char;
    }
    lines.push(line);
  }
  return { lines, width: Math.max(1, ...lines.map(measure)) };
}
function roundedShape(width, height, radius) {
  const x = -width / 2,
    y = -height / 2,
    r = Math.min(radius, width / 2, height / 2),
    shape = new THREE.Shape();
  shape.moveTo(x + r, y);
  shape.lineTo(x + width - r, y);
  shape.quadraticCurveTo(x + width, y, x + width, y + r);
  shape.lineTo(x + width, y + height - r);
  shape.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  shape.lineTo(x + r, y + height);
  shape.quadraticCurveTo(x, y + height, x, y + height - r);
  shape.lineTo(x, y + r);
  shape.quadraticCurveTo(x, y, x + r, y);
  return shape;
}
function safeColor(value, fallback) {
  return typeof value === "string" &&
    /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(value)
    ? value
    : fallback;
}
function createTextAsset(
  text,
  config = {},
  style = "dialog_decorated",
  createCanvas = (options) => wx.createOffscreenCanvas(options),
) {
  const canvas = createCanvas({ type: "2d", width: 1, height: 1 }),
    ctx = canvas.getContext("2d");
  const fontPx = 48,
    lineHeight = 64,
    padding = 12;
  ctx.font = `${fontPx}px sans-serif`;
  const content = String(text || "无内容").slice(0, 2000);
  const layout = layoutText(
    content,
    (value) => ctx.measureText(value).width,
    560,
  );
  const truncated = layout.lines.length > 32;
  if (truncated) {
    layout.lines = layout.lines.slice(0, 32);
    layout.lines[31] = layout.lines[31].slice(0, -1) + "…";
  }
  canvas.width = Math.min(1024, Math.ceil(layout.width + padding * 2));
  canvas.height = layout.lines.length * lineHeight + padding * 2;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.font = `${fontPx}px sans-serif`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.fillStyle = safeColor(
    config.text_color,
    style === "plain_white" ? "#ffffff" : "#f7efff",
  );
  layout.lines.forEach((line, index) =>
    ctx.fillText(line, padding, padding + lineHeight * (index + 0.5)),
  );
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const texture = new THREE.DataTexture(
    new Uint8Array(
      pixels.data.buffer,
      pixels.data.byteOffset,
      pixels.data.byteLength,
    ),
    canvas.width,
    canvas.height,
    THREE.RGBAFormat,
    THREE.UnsignedByteType,
  );
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.flipY = true;
  texture.magFilter = texture.minFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  const size = Number(config.text_size),
    glyphMeters = Math.min(
      0.4,
      Math.max(0.06, (Number.isFinite(size) && size > 0 ? size : 1.5) * 0.1),
    );
  const ratio = glyphMeters / fontPx,
    width = canvas.width * ratio,
    height = canvas.height * ratio;
  const root = new THREE.Group();
  if (style !== "plain_white") {
    const pad = 0.065,
      bgWidth = width + pad * 2,
      bgHeight = height + pad * 2;
    const border = new THREE.Mesh(
      new THREE.ShapeGeometry(
        roundedShape(bgWidth + 0.008, bgHeight + 0.008, 0.065),
      ),
      new THREE.MeshBasicMaterial({
        color: 0xe6bcff,
        transparent: true,
        opacity: 0.8,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    const bg = new THREE.Mesh(
      new THREE.ShapeGeometry(roundedShape(bgWidth, bgHeight, 0.06)),
      new THREE.MeshBasicMaterial({
        color: safeColor(config.background_color, "#662b7a"),
        transparent: true,
        opacity: 0.78,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    border.position.z = -0.006;
    bg.position.z = -0.003;
    root.add(border, bg);
    const tail = new THREE.Shape();
    tail.moveTo(-bgWidth / 2 + 0.09, -bgHeight / 2 + 0.005);
    tail.lineTo(-bgWidth / 2 + 0.09, -bgHeight / 2 - 0.06);
    tail.lineTo(-bgWidth / 2 + 0.17, -bgHeight / 2 + 0.005);
    tail.closePath();
    root.add(new THREE.Mesh(new THREE.ShapeGeometry(tail), bg.material));
    // Procedural avatar badge replaces the random pre-baked portrait atlas.
    const avatar = new THREE.Group();
    avatar.position.set(-bgWidth / 2 - 0.16, 0, 0);
    const avatarMaterial = new THREE.MeshBasicMaterial({
      color: 0x8b65ab,
      side: THREE.DoubleSide,
    });
    avatar.add(
      new THREE.Mesh(new THREE.CircleGeometry(0.105, 32), avatarMaterial),
    );
    const iconMaterial = new THREE.MeshBasicMaterial({
      color: 0xf7efff,
      side: THREE.DoubleSide,
    });
    const head = new THREE.Mesh(
      new THREE.CircleGeometry(0.025, 24),
      iconMaterial,
    );
    head.position.set(0, 0.024, 0.002);
    const body = new THREE.Mesh(
      new THREE.CircleGeometry(0.047, 24, 0, Math.PI),
      iconMaterial,
    );
    body.position.set(0, -0.047, 0.002);
    avatar.add(head, body);
    root.add(avatar);
  }
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(width, height),
    new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      alphaTest: 0.01,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  mesh.position.z = 0.001;
  root.add(mesh);
  root.userData.textLayout = {
    truncated,
    lines: layout.lines.length,
    width,
    height,
    textureWidth: canvas.width,
    textureHeight: canvas.height,
    content,
  };
  return root;
}
module.exports = { createTextAsset, layoutText, splitGraphemes, roundedShape };
