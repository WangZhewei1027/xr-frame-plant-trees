const { THREE } = require('./runtime');
function validMatrix(values, size = 16) {
  if (!values || values.length !== size) return false;
  for (let i = 0; i < size; i++) if (!Number.isFinite(values[i])) return false;
  return true;
}
// Disable Three's automatic world update: otherwise render() can replace the
// native pose with an identity/local matrix. Projection includes VK's viewport.
function syncVKCamera(target, source, near = 0.01, far = 100) {
  if (!source || !validMatrix(source.viewMatrix)) return false;
  const projection = source.getProjectionMatrix(near, far);
  if (!validMatrix(projection)) return false;
  target.matrixWorldInverse.fromArray(source.viewMatrix);
  target.projectionMatrix.fromArray(projection);
  if (Math.abs(target.matrixWorldInverse.determinant()) < 1e-12 || Math.abs(target.projectionMatrix.determinant()) < 1e-12) return false;
  target.matrixAutoUpdate = false;
  target.matrixWorldAutoUpdate = false;
  target.matrixWorld.copy(target.matrixWorldInverse).invert();
  target.matrix.copy(target.matrixWorld);
  target.matrixWorld.decompose(target.position, target.quaternion, target.scale);
  target.projectionMatrixInverse.copy(target.projectionMatrix).invert();
  return true;
}
function applyHitMatrix(object, matrix) {
  if (!validMatrix(matrix)) return false;
  const candidate = new THREE.Matrix4().fromArray(matrix);
  if (Math.abs(candidate.determinant()) < 1e-12) return false;
  object.matrixAutoUpdate = false;
  object.matrix.copy(candidate);
  object.matrix.decompose(object.position, object.quaternion, object.scale);
  object.matrixWorldNeedsUpdate = true;
  return true;
}

// A GPU-only camera-background pass in the same context as WebGLRenderer.
// Native VK textures are borrowed, never uploaded, owned or deleted by Three.
// The displayTransform and UV layout follow WeChat's plane-ar-v2/yuvBehavior.
// GLSL 300 and core VAOs replace the old WebGL 1 extension calls.
function createCameraBackground(gl) {
  const vertex = `#version 300 es
    layout(location=0) in vec2 position;
    layout(location=1) in vec2 uv;
    uniform mat3 displayTransform;
    out vec2 vUV;
    void main() {
      vec3 p = displayTransform * vec3(position, 0.0);
      gl_Position = vec4(p, 1.0);
      vUV = uv;
    }`;
  const fragment = `#version 300 es
    precision highp float;
    uniform sampler2D yTexture;
    uniform sampler2D uvTexture;
    uniform bool uvUsesRG;
    in vec2 vUV;
    out vec4 color;
    void main() {
      float y = texture(yTexture, vUV).r;
      vec4 chroma = texture(uvTexture, vUV);
      float u = chroma.r - 0.5;
      float v = (uvUsesRG ? chroma.g : chroma.a) - 0.5;
      color = vec4(y + 1.402*v, y - 0.344*u - 0.714*v, y + 1.772*u, 1.0);
    }`;
  let program, vao, buffer;
  const shaders = [];
  const dispose = () => {
    if (buffer) gl.deleteBuffer(buffer);
    if (vao) gl.deleteVertexArray(vao);
    if (program) gl.deleteProgram(program);
    shaders.forEach(s => gl.deleteShader(s));
    program = vao = buffer = null;
    shaders.length = 0;
  };
  try {
    program = gl.createProgram();
    for (const [type, text] of [[gl.VERTEX_SHADER, vertex], [gl.FRAGMENT_SHADER, fragment]]) {
      const shader = gl.createShader(type); shaders.push(shader);
      gl.shaderSource(shader, text); gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(`相机背景 shader 编译失败: ${gl.getShaderInfoLog(shader)}`);
      gl.attachShader(program, shader);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`相机背景 shader 链接失败: ${gl.getProgramInfoLog(program)}`);
    vao = gl.createVertexArray(); buffer = gl.createBuffer();
    gl.bindVertexArray(vao); gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([1,1,1,1, -1,1,0,1, 1,-1,1,0, -1,-1,0,0]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);
    gl.bindVertexArray(null); gl.bindBuffer(gl.ARRAY_BUFFER, null);
    const locations = Object.fromEntries(['displayTransform', 'yTexture', 'uvTexture', 'uvUsesRG'].map(name => [name, gl.getUniformLocation(program, name)]));
    return {
      draw(frame, renderer, width, height, packing = 'ra') {
        // Frame acquisition/native texture access may alter GL state.
        const textures = frame.getCameraTexture(gl, 'yuv');
        const display = frame.getDisplayTransform();
        if (!textures?.yTexture || !textures?.uvTexture || !validMatrix(display, 9)) return false;
        renderer.resetState();
        try {
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          gl.viewport(0, 0, width, height);
          gl.disable(gl.SCISSOR_TEST); gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE);
          gl.disable(gl.BLEND); gl.disable(gl.STENCIL_TEST);
          gl.colorMask(true, true, true, true); gl.depthMask(true);
          gl.clearColor(0, 0, 0, 1); gl.clearDepth(1);
          gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
          gl.depthMask(false);
          gl.useProgram(program); gl.bindVertexArray(vao);
          gl.uniformMatrix3fv(locations.displayTransform, false, display);
          gl.uniform1i(locations.yTexture, 0); gl.uniform1i(locations.uvTexture, 1);
          gl.uniform1i(locations.uvUsesRG, packing === 'rg' ? 1 : 0);
          gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, textures.yTexture);
          gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, textures.uvTexture);
          gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        } finally {
          gl.bindVertexArray(null);
          gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, null);
          gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, null);
          // Critical: native pass bypasses Three's state cache.
          renderer.resetState();
        }
        return true;
      }, dispose,
    };
  } catch (error) { dispose(); throw error; }
}
module.exports = { syncVKCamera, applyHitMatrix, createCameraBackground, validMatrix };
