// Capacity and repeat policy. GPU/media resources are owned by each Three entry.
module.exports = {
  text: { bucket: "light", repeatCooldownMs: 60000 },
  image: { bucket: "light", repeatCooldownMs: 60000 },
  model: { bucket: "heavy", async: true },
  video: { bucket: "heavy", async: true },
  audio: { bucket: "audio" },
  danmaku: {
    bucket: "transient",
    dispose(entry) {
      this.flyingDanmakus = (this.flyingDanmakus || []).filter(
        (item) => item.node !== entry.node,
      );
    },
  },
};
