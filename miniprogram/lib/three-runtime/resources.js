const { THREE } = require("./runtime");
let serial = 0;
function removeFile(path) {
  if (path)
    try {
      wx.getFileSystemManager().unlink({ filePath: path, fail() {} });
    } catch (_) {}
}
function writeTemp(buffer, extension) {
  const path = `${wx.env.USER_DATA_PATH}/three-${Date.now()}-${serial++}.${extension}`;
  return new Promise((resolve, reject) =>
    wx.getFileSystemManager().writeFile({
      filePath: path,
      data: buffer,
      success: () => resolve(path),
      fail: reject,
    }),
  );
}
function readFile(path) {
  return new Promise((resolve, reject) =>
    wx.getFileSystemManager().readFile({
      filePath: path,
      success: (res) => resolve(res.data),
      fail: reject,
    }),
  );
}
function download(url) {
  if (!/^https?:\/\//.test(url)) return Promise.resolve(url);
  return new Promise((resolve, reject) =>
    wx.downloadFile({
      url,
      timeout: 30000,
      success: (res) => {
        if (res.statusCode === 200) resolve(res.tempFilePath);
        else {
          removeFile(res.tempFilePath);
          reject(new Error(`资源下载失败 (${res.statusCode})`));
        }
      },
      fail: reject,
    }),
  );
}
async function readBytes(uri) {
  if (uri.startsWith("data:")) {
    const comma = uri.indexOf(",");
    if (!/;base64$/i.test(uri.slice(0, comma)))
      throw new Error("资源 Data URI 必须使用 base64");
    return wx.base64ToArrayBuffer(uri.slice(comma + 1));
  }
  const path = await download(uri);
  try {
    return await readFile(path);
  } finally {
    if (path !== uri) removeFile(path);
  }
}
function resolveURI(uri, base) {
  if (/^(https?:|wxfile:|data:|file:)/.test(uri)) return uri;
  const remote = base.match(/^(https?:\/\/[^/]+)(\/.*)?$/);
  if (remote && uri.startsWith("/")) return remote[1] + uri;
  if (uri.startsWith("/")) return uri;
  const combined = base.slice(0, base.lastIndexOf("/") + 1) + uri;
  // Resolve ../ segments without relying on a browser URL global.
  const parts = combined.split("/"),
    output = [];
  for (const part of parts) {
    if (part === "..") output.pop();
    else if (part !== ".") output.push(part);
  }
  return output.join("/");
}
function imageFromPath(canvas, path) {
  return new Promise((resolve, reject) => {
    const image = canvas.createImage();
    const timer = setTimeout(() => {
      image.onload = image.onerror = null;
      reject(new Error("图片解码超时"));
    }, 15000);
    image.onload = () => {
      clearTimeout(timer);
      image.onload = image.onerror = null;
      resolve(image);
    };
    image.onerror = (error) => {
      clearTimeout(timer);
      image.onload = image.onerror = null;
      reject(new Error(error?.errMsg || "图片解码失败"));
    };
    image.src = path;
  });
}
async function loadTexture(canvas, uri, buffer, mimeType) {
  let path;
  if (buffer)
    path = await writeTemp(
      buffer,
      mimeType === "image/webp"
        ? "webp"
        : mimeType === "image/jpeg"
          ? "jpg"
          : "png",
    );
  else if (uri.startsWith("data:"))
    return loadTexture(
      canvas,
      "",
      await readBytes(uri),
      uri.slice(5, uri.indexOf(";")),
    );
  else path = await download(uri);
  try {
    const image = await imageFromPath(canvas, path);
    const texture = new THREE.Texture(image);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
    return texture;
  } finally {
    if (buffer || path !== uri) removeFile(path);
  }
}
function disposeTree(root, { shared = false } = {}) {
  const geometries = new Set(),
    materials = new Set(),
    textures = new Set();
  function visit(node) {
    if (!shared && node.userData?.sharedModel) {
      node.traverse((child) => child.skeleton?.dispose());
      return;
    }
    if (node.geometry) geometries.add(node.geometry);
    for (const mat of [].concat(node.material || [])) {
      materials.add(mat);
      for (const value of Object.values(mat))
        if (value?.isTexture) textures.add(value);
      for (const uniform of Object.values(mat.uniforms || {}))
        if (uniform.value?.isTexture) textures.add(uniform.value);
    }
    for (const child of node.children || []) visit(child);
  }
  if (root) visit(root);
  textures.forEach((t) => t.dispose());
  materials.forEach((m) => m.dispose());
  geometries.forEach((g) => g.dispose());
}
function unpackGLTF(bytes) {
  const view = new DataView(bytes);
  if (bytes.byteLength >= 12 && view.getUint32(0, true) === 0x46546c67) {
    if (
      view.getUint32(4, true) !== 2 ||
      view.getUint32(8, true) > bytes.byteLength
    )
      throw new Error("无效 GLB");
    let json, binary;
    for (let offset = 12; offset + 8 <= bytes.byteLength; ) {
      const length = view.getUint32(offset, true),
        type = view.getUint32(offset + 4, true);
      if (offset + 8 + length > bytes.byteLength)
        throw new Error("GLB chunk 越界");
      const chunk = bytes.slice(offset + 8, offset + 8 + length);
      if (type === 0x4e4f534a)
        json = JSON.parse(
          THREE.decodeUTF8(new Uint8Array(chunk)).replace(/\0+$/, ""),
        );
      if (type === 0x004e4942) binary = chunk;
      offset += 8 + length;
    }
    if (!json) throw new Error("GLB 缺少 JSON");
    return { json, binary };
  }
  return { json: JSON.parse(THREE.decodeUTF8(new Uint8Array(bytes))) };
}
// GLTFLoader plugin handles platform resources; no global fetch/Blob/document.
async function loadGLTF(canvas, url) {
  const { json, binary } = unpackGLTF(await readBytes(url));
  const unsupported = ["KHR_draco_mesh_compression", "EXT_meshopt_compression"];
  for (const name of unsupported)
    if ((json.extensionsRequired || []).includes(name))
      throw new Error(`模型使用 ${name}，请导出未压缩 GLB 后重试`);
  // Resolve all buffers once, including external .bin. Plugin serves bufferViews.
  const buffers = await Promise.all(
    (json.buffers || []).map((buffer, index) =>
      buffer.uri
        ? readBytes(resolveURI(buffer.uri, url))
        : index === 0 && binary
          ? Promise.resolve(binary)
          : Promise.reject(new Error("模型缺少 buffer")),
    ),
  );
  for (const texture of json.textures || []) {
    const extensions = texture.extensions || {};
    if (extensions.EXT_texture_webp)
      texture.source = extensions.EXT_texture_webp.source;
    if (extensions.KHR_texture_basisu && texture.source == null)
      throw new Error("模型仅包含 KTX2 纹理，请导出 PNG/JPEG/WebP 纹理");
    delete extensions.EXT_texture_webp;
    delete extensions.KHR_texture_basisu;
  }
  json.extensionsRequired = (json.extensionsRequired || []).filter(
    (name) => !["EXT_texture_webp", "KHR_texture_basisu"].includes(name),
  );
  const filter = {
    9728: THREE.NearestFilter,
    9729: THREE.LinearFilter,
    9984: THREE.NearestMipmapNearestFilter,
    9985: THREE.LinearMipmapNearestFilter,
    9986: THREE.NearestMipmapLinearFilter,
    9987: THREE.LinearMipmapLinearFilter,
  };
  const wrap = {
    33071: THREE.ClampToEdgeWrapping,
    33648: THREE.MirroredRepeatWrapping,
    10497: THREE.RepeatWrapping,
  };
  const ownedTextures = new Set();
  let failed = false;
  const getView = (index) => {
    const def = json.bufferViews[index],
      buffer = buffers[def.buffer],
      offset = def.byteOffset || 0;
    if (!buffer || offset + def.byteLength > buffer.byteLength)
      throw new Error("模型 bufferView 越界");
    return buffer.slice(offset, offset + def.byteLength);
  };
  const loader = new THREE.GLTFLoader();
  loader.register(() => ({
    name: "MINIPROGRAM_RESOURCES",
    loadBufferView(index) {
      return Promise.resolve(getView(index));
    },
    async loadTexture(index) {
      const def = json.textures[index],
        source = json.images[def.source];
      if (!source) throw new Error("模型纹理缺少图片来源");
      const texture =
        source.bufferView != null
          ? await loadTexture(
              canvas,
              "",
              getView(source.bufferView),
              source.mimeType,
            )
          : await loadTexture(canvas, resolveURI(source.uri, url));
      if (failed) {
        texture.dispose();
        throw new Error("模型加载已取消");
      }
      ownedTextures.add(texture);
      texture.flipY = false;
      // GLTFLoader sets SRGB only for color/emissive maps; normal/metallic stay linear.
      texture.colorSpace = "";
      const sampler = json.samplers?.[def.sampler] || {};
      texture.magFilter = filter[sampler.magFilter] || THREE.LinearFilter;
      texture.minFilter =
        filter[sampler.minFilter] || THREE.LinearMipmapLinearFilter;
      texture.wrapS = wrap[sampler.wrapS] || THREE.RepeatWrapping;
      texture.wrapT = wrap[sampler.wrapT] || THREE.RepeatWrapping;
      return texture;
    },
  }));
  try {
    return await new Promise((resolve, reject) =>
      loader.parse(JSON.stringify(json), "", resolve, reject),
    );
  } catch (error) {
    failed = true;
    ownedTextures.forEach((t) => t.dispose());
    throw error;
  }
}
class ModelCache {
  constructor(canvas, max = 8, loader = loadGLTF) {
    this.canvas = canvas;
    this.max = max;
    this.loader = loader;
    this.items = new Map();
    this.closed = false;
  }
  async acquire(url) {
    if (this.closed) throw new Error("模型缓存已关闭");
    let entry = this.items.get(url);
    if (!entry) {
      entry = { refs: 0, usedAt: Date.now(), gltf: null };
      entry.promise = this.loader(this.canvas, url)
        .then((gltf) => {
          entry.gltf = gltf;
          if (this.closed) {
            disposeTree(gltf.scene, { shared: true });
            throw new Error("模型加载已取消");
          }
          return gltf;
        })
        .catch((error) => {
          if (this.items.get(url) === entry) this.items.delete(url);
          throw error;
        });
      this.items.set(url, entry);
    }
    entry.refs++;
    entry.usedAt = Date.now();
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      entry.refs--;
      this.trim();
    };
    try {
      const gltf = await entry.promise;
      if (this.closed) throw new Error("模型缓存已关闭");
      const object = THREE.cloneSkinned(gltf.scene);
      object.userData.sharedModel = true;
      return { object, animations: gltf.animations, release };
    } catch (error) {
      release();
      throw error;
    }
  }
  trim() {
    const idle = [...this.items]
      .filter(([, item]) => item.refs === 0 && item.gltf)
      .sort((a, b) => a[1].usedAt - b[1].usedAt);
    for (const [url, item] of idle) {
      if (this.items.size <= this.max) break;
      this.items.delete(url);
      disposeTree(item.gltf.scene, { shared: true });
    }
  }
  dispose() {
    this.closed = true;
    for (const item of this.items.values())
      if (item.gltf) disposeTree(item.gltf.scene, { shared: true });
    this.items.clear();
  }
}
module.exports = {
  removeFile,
  writeTemp,
  readBytes,
  download,
  loadTexture,
  loadGLTF,
  unpackGLTF,
  resolveURI,
  disposeTree,
  ModelCache,
};
