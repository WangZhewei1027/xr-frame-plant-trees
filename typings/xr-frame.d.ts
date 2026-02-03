// XR-Frame type declarations
declare namespace WechatMiniprogram {
  interface Wx {
    getXrFrameSystem(): XrFrameSystem;
  }

  interface XrFrameSystem {
    Matrix4: new () => any;
    Vector3: new () => any;
    Quaternion: new () => any;
    [key: string]: any;
  }
}
