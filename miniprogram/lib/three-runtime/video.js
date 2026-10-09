const { THREE } = require("./runtime");
function createVideo(source, metadata = {}, onError = console.warn) {
  if (!wx.createVideoDecoder) throw new Error("当前微信版本不支持视频解码");
  const decoder = wx.createVideoDecoder();
  let disposed = false,
    playing = false,
    busy = false,
    texture = null,
    firstFrame = true,
    audio = null;
  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    uniforms: {
      videoMap: { value: null },
      ready: { value: false },
      tbb: {
        value: metadata.transparent !== false && metadata.format !== "normal",
      },
    },
    vertexShader:
      "varying vec2 vUv; void main(){vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}",
    // RGBA frames are top-left row first. Flip explicitly in shader; no CPU row copy.
    fragmentShader: `varying vec2 vUv; uniform sampler2D videoMap; uniform bool ready; uniform bool tbb;
      void main(){
        if(!ready){gl_FragColor=vec4(0.15,0.12,0.24,0.65); return;}
        vec2 uv=vec2(vUv.x,1.0-vUv.y);
        vec4 c=texture2D(videoMap,vec2(uv.x,tbb?uv.y*0.5:uv.y));
        float a=tbb?dot(texture2D(videoMap,vec2(uv.x,uv.y*0.5+0.5)).rgb,vec3(0.299,0.587,0.114)):c.a;
        gl_FragColor=vec4(c.rgb,a);
      }`,
  });
  const error = (value) => {
    if (!disposed)
      onError(
        value instanceof Error
          ? value
          : new Error(value?.errMsg || String(value)),
      );
  };
  const settle = (promise) => Promise.resolve(promise).catch(error);
  async function play() {
    if (disposed || busy || playing) return;
    busy = true;
    try {
      await decoder.start({
        source,
        mode: 0,
        abortAudio: metadata.muted === true,
      });
      if (disposed) {
        await decoder.remove();
        return;
      }
      playing = true;
      if (metadata.muted !== true && wx.createMediaAudioPlayer) {
        if (!audio) {
          audio = wx.createMediaAudioPlayer();
          audio.volume = Math.min(
            1,
            Math.max(0, Number.isFinite(metadata.volume) ? metadata.volume : 1),
          );
          await audio.addAudioSource(decoder);
        }
        if (disposed) return;
        await audio.start();
      }
    } catch (e) {
      error(e);
    } finally {
      busy = false;
    }
  }
  async function pause() {
    playing = false;
    if (audio) settle(audio.stop());
    settle(decoder.stop());
  }
  const ended = () => {
    if (disposed) return;
    if (metadata.loop !== false) settle(decoder.seek(0));
    else {
      playing = false;
      if (audio) settle(audio.stop());
    }
  };
  decoder.on("ended", ended);
  function tick() {
    if (!playing || disposed) return;
    try {
      const frame = decoder.getFrameData();
      if (!frame?.data) return;
      const bytes = ArrayBuffer.isView(frame.data)
        ? new Uint8Array(
            frame.data.buffer,
            frame.data.byteOffset,
            frame.data.byteLength,
          )
        : new Uint8Array(frame.data);
      if (
        !frame.width ||
        !frame.height ||
        bytes.byteLength !== frame.width * frame.height * 4
      )
        throw new Error("视频帧不是紧密排列 RGBA，当前设备格式需适配");
      if (
        !texture ||
        texture.image.width !== frame.width ||
        texture.image.height !== frame.height
      ) {
        texture?.dispose();
        texture = new THREE.DataTexture(
          bytes.slice(),
          frame.width,
          frame.height,
          THREE.RGBAFormat,
        );
        texture.magFilter = texture.minFilter = THREE.LinearFilter;
        material.uniforms.videoMap.value = texture;
      } else texture.image.data.set(bytes);
      texture.needsUpdate = true;
      material.uniforms.ready.value = true;
      if (firstFrame) {
        firstFrame = false;
        console.log("[ThreeAR][video]", {
          width: frame.width,
          height: frame.height,
          converter: "native-rgba",
        });
      }
    } catch (e) {
      pause();
      error(e);
    }
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    playing = false;
    decoder.off("ended", ended);
    if (audio) {
      settle(audio.stop());
      settle(audio.removeAudioSource(decoder));
      settle(audio.destroy());
    }
    settle(decoder.stop());
    settle(decoder.remove());
    // Texture/material are released by the owning scene tree.
  }
  return {
    material,
    tick,
    dispose,
    play,
    toggle() {
      if (playing) pause();
      else play();
    },
  };
}
module.exports = { createVideo };
