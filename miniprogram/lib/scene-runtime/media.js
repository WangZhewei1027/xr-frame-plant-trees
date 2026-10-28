const { THREE } = require("../three-runtime/runtime");
const { loadTexture, disposeTree } = require("../three-runtime/resources");
const { samplePresentation, mediaTime } = require("./vendor/scene-core");
const { createSceneMediaContext, createAudioPlayback } = require("./media-audio");
const { createVideoPlayback, inspectSoundtrack } = require("./media-video");

const DEFAULT_MEDIA = { trimStartSeconds: 0, trimEndSeconds: null, playbackRate: 1, volume: 1, muted: false, loop: false };

function textTexture(text) {
  if (typeof wx.createOffscreenCanvas !== "function") throw new Error("此微信版本不支持空间文字，请升级微信后重试");
  const canvas = wx.createOffscreenCanvas({ type: "2d", width: 1, height: 1 });
  const context = canvas.getContext("2d");
  const fontPixels = 96, padding = 24;
  const rawWidth = Math.max(fontPixels, text.width / text.fontSize * fontPixels);
  const font = `500 ${fontPixels}px system-ui, sans-serif`;
  context.font = font;
  const lines = [];
  for (const paragraph of text.content.split("\n")) {
    let line = "";
    for (const char of paragraph) {
      if (line && context.measureText(line + char).width > rawWidth - padding * 2) { lines.push(line); line = char; }
      else line += char;
    }
    lines.push(line);
  }
  const lineHeight = fontPixels * 1.35, rawHeight = lines.length * lineHeight + padding * 2;
  const density = Math.min(1, 4096 / rawWidth, 4096 / rawHeight);
  canvas.width = Math.max(1, Math.ceil(rawWidth * density)); canvas.height = Math.max(1, Math.ceil(rawHeight * density));
  context.scale(density, density); context.font = font; context.textBaseline = "middle"; context.textAlign = text.align;
  if (text.backgroundColor) { context.fillStyle = text.backgroundColor; context.fillRect(0, 0, rawWidth, rawHeight); }
  context.fillStyle = text.color;
  const x = text.align === "left" ? padding : text.align === "right" ? rawWidth - padding : rawWidth / 2;
  lines.forEach((line, index) => context.fillText(line, x, padding + lineHeight * (index + .5)));
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
  const texture = new THREE.DataTexture(new Uint8Array(pixels.data), canvas.width, canvas.height, THREE.RGBAFormat);
  texture.colorSpace = THREE.SRGBColorSpace; texture.flipY = true;
  texture.minFilter = texture.magFilter = THREE.LinearFilter; texture.needsUpdate = true;
  canvas.width = canvas.height = 1;
  return { texture, height: rawHeight / rawWidth * text.width };
}

async function createSceneSurface(instance, resource, options = {}) {
  const { canvas, onError = () => {}, isCancelled = () => false } = options;
  const object = new THREE.Group(), materials = [];
  const kind = instance.text ? "text" : resource?.kind;
  const settings = { ...DEFAULT_MEDIA, ...instance.media };
  let audio = null, video = null, disposed = false;
  const ownsContext = !options.mediaContext;
  const mediaContext = options.mediaContext || createSceneMediaContext();
  const unregister = mediaContext.onDispose(dispose);
  const context = {
    onError(error) { dispose(); onError(error); },
    isCancelled: () => disposed || mediaContext.disposed || isCancelled(), mediaContext,
  };
  function plane(material, width, height) {
    materials.push(material);
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
    mesh.scale.set(width, height, 1); mesh.position.y = height / 2; object.add(mesh);
    return (imageWidth, imageHeight) => {
      if (!(imageWidth > 0 && imageHeight > 0)) return;
      const h = 2 * imageHeight / imageWidth; mesh.scale.set(2, h, 1); mesh.position.y = h / 2;
    };
  }
  function dispose() {
    if (disposed) return;
    disposed = true; audio?.dispose(); video?.dispose();
    unregister();
    disposeTree(object); object.clear();
    if (ownsContext) mediaContext.dispose();
  }
  try {
    if (kind === "text") {
      const { texture, height } = textTexture(instance.text);
      plane(new THREE.MeshBasicMaterial({ map: texture, transparent: true, side: THREE.DoubleSide, depthWrite: false, toneMapped: false }), instance.text.width, height);
    } else if (kind === "image") {
      if (!canvas?.createImage) throw new Error("图片素材缺少 Canvas 图片解码器");
      const texture = await loadTexture(canvas, resource.url);
      if (context.isCancelled()) { texture.dispose(); texture.image = null; throw new Error("演出图片加载已取消"); }
      const resize = plane(new THREE.MeshBasicMaterial({ map: texture, transparent: true, side: THREE.DoubleSide, toneMapped: false }), 2, 1.5);
      resize(texture.image.width, texture.image.height);
    } else if (kind === "audio") {
      audio = await createAudioPlayback(resource.url, settings, context);
    } else if (kind === "video") {
      const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, toneMapped: false });
      const resize = plane(material, 2, 1.125);
      video = await createVideoPlayback(resource.url, material, resize, context);
      if (!settings.muted && await inspectSoundtrack(video.path)) audio = await createAudioPlayback(video.path, settings, context);
    } else throw new Error(`不支持的演出素材类型: ${kind}`);
    if (context.isCancelled()) throw new Error("演出素材加载已取消");
    return {
      object, materials,
      get audio() { return audio; }, get video() { return video; },
      sync(time, playing, sceneDuration) {
        if (disposed) return;
        const presentation = samplePresentation(instance, time, sceneDuration);
        const duration = video?.duration ?? audio?.duration;
        const sourceTime = mediaTime(time, settings, instance.timing, duration);
        const end = Math.min(duration ?? Infinity, settings.trimEndSeconds === null ? Infinity : settings.trimEndSeconds);
        const shouldPlay = playing && presentation.visible && (settings.loop || sourceTime < end);
        audio?.sync(sourceTime, shouldPlay, settings.volume * presentation.opacity);
        video?.sync(sourceTime, shouldPlay, duration);
      },
      dispose,
    };
  } catch (error) { dispose(); throw error; }
}

module.exports = { createSceneSurface, createSceneMediaContext };
