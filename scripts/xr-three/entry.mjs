// Deliberately limited surface: no WebGPU, DOM controls or browser audio runtime.
export {
  REVISION, Object3D, Group, AnimationMixer, AnimationClip, VectorKeyframeTrack,
  QuaternionKeyframeTrack, Quaternion, Vector3, Scene, PerspectiveCamera,
  WebGLRenderer, BoxGeometry, Mesh, MeshStandardMaterial, MeshBasicMaterial,
  AmbientLight, DirectionalLight, Texture, SRGBColorSpace, Matrix4, RingGeometry, DoubleSide, PlaneGeometry, Shape, ShapeGeometry, CircleGeometry,
  DataTexture, RGBAFormat, UnsignedByteType, LinearFilter, ClampToEdgeWrapping, RepeatWrapping, MirroredRepeatWrapping,
  NearestFilter, NearestMipmapNearestFilter, NearestMipmapLinearFilter, LinearMipmapNearestFilter, LinearMipmapLinearFilter,
  ShaderMaterial, Box3, Raycaster, Vector2, Color, InstancedMesh, DynamicDrawUsage,
} from 'three';
export { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
export function decodeUTF8(bytes) { return new TextDecoder().decode(bytes); }
