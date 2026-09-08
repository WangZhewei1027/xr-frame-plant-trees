const config = require("./config");

/** 将紧密排列的 YUV420 半平面帧缩小并转成 RGBA，不包含虚拟 AR 素材。 */
function convertFrame(raw, options = config) {
  const { width, height } = raw || {};
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 2 ||
    height < 2 ||
    width % 2 ||
    height % 2 ||
    raw.yBuffer?.byteLength !== width * height ||
    raw.uvBuffer?.byteLength !== (width * height) / 2
  ) {
    throw new Error("相机帧格式不支持，请检查真机 YUV 排列");
  }
  const rotation = options.rotation || 0;
  if (![0, 90, 180, 270].includes(rotation))
    throw new Error("相机旋转配置无效");
  const scale = Math.min(
    1,
    (options.maxImageEdge || 640) / Math.max(width, height),
  );
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const outWidth = rotation % 180 ? h : w;
  const outHeight = rotation % 180 ? w : h;
  const data = new Uint8ClampedArray(outWidth * outHeight * 4);
  const y = new Uint8Array(raw.yBuffer),
    uv = new Uint8Array(raw.uvBuffer);
  const uOffset = options.uvOrder === "vu" ? 1 : 0;
  for (let row = 0; row < h; row++) {
    const sy = Math.min(height - 1, Math.floor(row / scale));
    for (let col = 0; col < w; col++) {
      const sx = Math.min(width - 1, Math.floor(col / scale));
      const yi = y[sy * width + sx];
      const ui = Math.floor(sy / 2) * width + Math.floor(sx / 2) * 2;
      const u = uv[ui + uOffset] - 128,
        v = uv[ui + 1 - uOffset] - 128;
      let ox = col,
        oy = row;
      if (rotation === 90) {
        ox = h - 1 - row;
        oy = col;
      }
      if (rotation === 180) {
        ox = w - 1 - col;
        oy = h - 1 - row;
      }
      if (rotation === 270) {
        ox = row;
        oy = w - 1 - col;
      }
      const i = (oy * outWidth + ox) * 4;
      data[i] = yi + 1.402 * v;
      data[i + 1] = yi - 0.344136 * u - 0.714136 * v;
      data[i + 2] = yi + 1.772 * u;
      data[i + 3] = 255;
    }
  }
  return { width: outWidth, height: outHeight, data };
}

function removeTempFile(filePath) {
  if (!filePath) return;
  try {
    wx.getFileSystemManager().unlink({ filePath, fail() {} });
  } catch (_) {}
}

async function captureCamera(scene, onFrameInfo) {
  if (!scene?.ar?.getARRawData || !wx.createOffscreenCanvas) {
    throw new Error("当前微信不支持 AR 原始取图，请升级并使用真机");
  }
  const raw = scene.ar.getARRawData();
  const frame = convertFrame(raw);
  if (typeof onFrameInfo === "function") {
    onFrameInfo({
      rawWidth: raw.width, rawHeight: raw.height,
      width: frame.width, height: frame.height,
      rotation: config.rotation || 0, uvOrder: config.uvOrder || "uv",
    });
  }
  const canvas = wx.createOffscreenCanvas({
    type: "2d",
    width: frame.width,
    height: frame.height,
  });
  const ctx = canvas.getContext("2d");
  const pixels = ctx.createImageData(frame.width, frame.height);
  pixels.data.set(frame.data);
  ctx.putImageData(pixels, 0, 0);
  return new Promise((resolve, reject) => {
    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      reject(new Error("相机取图超时"));
    }, 5000);
    wx.canvasToTempFilePath({
      canvas,
      fileType: "jpg",
      quality: 0.8,
      success: (res) => {
        clearTimeout(timer);
        if (expired) removeTempFile(res.tempFilePath);
        else resolve(res.tempFilePath);
      },
      fail: () => {
        clearTimeout(timer);
        reject(new Error("相机图片导出失败，请检查真机兼容性"));
      },
    });
  });
}
module.exports = { convertFrame, captureCamera, removeTempFile };
