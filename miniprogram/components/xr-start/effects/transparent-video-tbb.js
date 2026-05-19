/**
 * TBB（Top-by-Bottom）透明视频合成 Effect。
 *
 * 视频帧布局：
 *   - 上半部分（v_UV.y ∈ [0, 0.5]）：RGB 颜色帧
 *   - 下半部分（v_UV.y ∈ [0.5, 1.0]）：灰度 Alpha 遮罩
 *
 * 若渲染结果颜色与 Alpha 上下颠倒，说明当前设备视频纹理 UV 原点在右下角，
 * 此时将 colorUV / alphaUV 中的 y 计算对调即可：
 *   colorUV.y = v_UV.y * 0.5 + 0.5   （改为取下半部分）
 *   alphaUV.y = v_UV.y * 0.5          （改为取上半部分）
 *
 * 注意：registerEffect 在模块加载时全局注册一次，工厂函数在每个 Scene 首次使用时惰性调用。
 */
const xrFrameSystem = wx.getXrFrameSystem();

xrFrameSystem.registerEffect("transparent-video-tbb", (scene) =>
  scene.createEffect({
    name: "transparent-video-tbb",
    images: [
      {
        key: "u_videoMap",
        default: "white",
        macro: "WX_USE_VIDEOMAP",
      },
    ],
    // 2500+ 为透明队列，确保 Alpha 混合正确叠加在 AR 背景上
    defaultRenderQueue: 2500,
    passes: [
      {
        renderStates: {
          cullOn: false,
          blendOn: true,
          blendSrc: xrFrameSystem.EBlendFactor.SRC_ALPHA,
          blendDst: xrFrameSystem.EBlendFactor.ONE_MINUS_SRC_ALPHA,
          cullFace: xrFrameSystem.ECullMode.BACK,
        },
        lightMode: "ForwardBase",
        useMaterialRenderStates: true,
        shaders: [0, 1],
      },
    ],
    shaders: [
      /* ── 顶点着色器 ── */
      `#version 100
uniform highp mat4 u_view;
uniform highp mat4 u_viewInverse;
uniform highp mat4 u_vp;
uniform highp mat4 u_projection;
uniform highp mat4 u_world;

attribute vec3 a_position;
attribute highp vec2 a_texCoord;

varying highp vec2 v_UV;

void main()
{
  v_UV = a_texCoord;
  vec4 worldPosition = u_world * vec4(a_position, 1.0);
  gl_Position = u_projection * u_view * worldPosition;
}`,

      /* ── 片段着色器 ── */
      `#version 100
precision mediump float;
precision highp int;

varying highp vec2 v_UV;

#ifdef WX_USE_VIDEOMAP
  uniform sampler2D u_videoMap;
#endif

float toGray(vec4 c) {
  return 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
}

void main()
{
#ifdef WX_USE_VIDEOMAP
  // TBB 布局：上半（y ∈ [0, 0.5]）= 颜色，下半（y ∈ [0.5, 1]）= Alpha 遮罩
  // 将 [0,1] 的平面 UV 分别映射到颜色区和 Alpha 区
  vec2 colorUV = vec2(v_UV.x, v_UV.y * 0.5);
  vec2 alphaUV = vec2(v_UV.x, v_UV.y * 0.5 + 0.5);

  vec4 color      = texture2D(u_videoMap, colorUV);
  vec4 alphaSample = texture2D(u_videoMap, alphaUV);
  float alpha = toGray(alphaSample);

  gl_FragData[0] = vec4(color.rgb, alpha);
#else
  gl_FragData[0] = vec4(0.0, 0.0, 0.0, 0.0);
#endif
}`,
    ],
  }),
);
