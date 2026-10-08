// Deliberately limited surface: no WebGPU, DOM controls or browser audio runtime.
export {
  REVISION, Object3D, Group, AnimationMixer, AnimationClip, VectorKeyframeTrack,
  QuaternionKeyframeTrack, Quaternion, Vector3, Scene, PerspectiveCamera,
  WebGLRenderer, BoxGeometry, Mesh, MeshStandardMaterial, MeshBasicMaterial,
  AmbientLight, DirectionalLight, Texture, SRGBColorSpace, Matrix4, RingGeometry, DoubleSide,
} from 'three';
export { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
