const THREE = require("./vendor/three");
function probeWebGL2(gl) {
  if (!gl)
    throw new Error(
      'Canvas.getContext("webgl2") 返回空值；本设备不能运行本实验的新版渲染器',
    );
  const required = [
    "createVertexArray",
    "bindVertexArray",
    "texStorage2D",
    "drawBuffers",
    "bindBufferBase",
    "fenceSync",
  ];
  const missing = required.filter((name) => typeof gl[name] !== "function");
  const version = String(gl.getParameter(gl.VERSION));
  if (!/WebGL\s*2/i.test(version) || missing.length) {
    throw new Error(
      `不是完整 WebGL 2：${version}；缺少 ${missing.join(", ") || "版本标识"}`,
    );
  }
  return {
    version,
    shadingLanguage: String(gl.getParameter(gl.SHADING_LANGUAGE_VERSION)),
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
  };
}

// A facade keeps DOM compatibility local to this canvas. WXML forwards context
// events here; simply installing empty addEventListener stubs would hide loss.
function createCanvasFacade(canvas, gl, width, height) {
  const listeners = new Map();
  return {
    get width() {
      return canvas.width;
    },
    set width(v) {
      canvas.width = v;
    },
    get height() {
      return canvas.height;
    },
    set height(v) {
      canvas.height = v;
    },
    clientWidth: width,
    clientHeight: height,
    style: {},
    getContext: (type) => (type === "webgl2" ? gl : null),
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(handler);
    },
    removeEventListener(type, handler) {
      listeners.get(type)?.delete(handler);
    },
    dispatch(type, detail) {
      const event = { type, detail, preventDefault() {} };
      for (const handler of listeners.get(type) || []) handler(event);
    },
  };
}

module.exports = { THREE, probeWebGL2, createCanvasFacade };
