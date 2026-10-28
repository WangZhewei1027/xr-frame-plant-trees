const { THREE } = require("./runtime");

/**
 * Imported models often carry an offset pivot (e.g. Sketchfab/FBX exports).
 * Writes the offset that puts the bounding box's bottom-center on the origin.
 * The Web scene editor (three-editor/models.ts) applies the same rule.
 */
function groundOffset(object, target) {
  const bounds = new THREE.Box3().setFromObject(object);
  if (bounds.isEmpty()) return target.set(0, 0, 0);
  return target.set(
    -(bounds.min.x + bounds.max.x) / 2,
    -bounds.min.y,
    -(bounds.min.z + bounds.max.z) / 2,
  );
}

module.exports = { groundOffset };
