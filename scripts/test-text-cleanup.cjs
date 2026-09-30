const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const componentRoot = path.resolve(__dirname, "../miniprogram/components/xr-start");
const tests = [];
const test = (name, run) => tests.push([name, run]);

function harness(style = "plain_white") {
  const events = [];
  const warnings = [];
  const created = [];
  const faults = { afterTextAttached: false };
  const xr = {
    XRNode: "XRNode", XRText: "XRText", XRMesh: "XRMesh",
    Transform: "Transform", Text: "Text",
    Vector3: { createFromNumber: (x, y, z) => ({ x, y, z }) },
  };
  class Node {
    constructor(type, attributes = {}) {
      this.type = type;
      this.attributes = attributes;
      this.children = [];
      this.parent = null;
      this.releaseCount = 0;
      this.transform = {
        visible: true,
        worldPosition: { x: 0, y: 0, z: 1 },
        setData: ({ visible }) => {
          if (visible !== undefined) this.transform.visible = visible;
          events.push({ kind: "visibility", node: this, visible });
        },
      };
      if (type === xr.XRText) {
        this.text = {
          value: attributes.value,
          setData: ({ value }) => {
            this.text.value = value;
            events.push({ kind: "text", node: this, value });
          },
        };
      }
      created.push(this);
    }
    getComponent(type) {
      if (type === xr.Transform) return this.transform;
      if (type === xr.Text) return this.text;
      return null;
    }
    setAttribute(name, value) {
      this.attributes[name] = value;
      if (name === "value" && this.text) this.text.setData({ value });
    }
    addChild(child) {
      assert.equal(child.parent, null);
      this.children.push(child);
      child.parent = this;
      if (child.type === xr.XRText && faults.afterTextAttached) {
        faults.afterTextAttached = false;
        throw new Error("injected failure after attaching XRText");
      }
    }
    removeChild(child) {
      assert.equal(child.parent, this);
      const index = this.children.indexOf(child);
      assert.notEqual(index, -1);
      events.push({ kind: "detach", node: child });
      this.children.splice(index, 1);
      child.parent = null;
    }
    getChildrenByFilter(filter) { return this.children.filter(filter); }
    dfs(callback) {
      callback(this);
      for (const child of this.children) child.dfs(callback);
    }
    release() {
      this.releaseCount++;
      events.push({ kind: "release", node: this });
      for (const child of this.children) child.release();
    }
  }
  const wx = { getXrFrameSystem: () => xr };
  function load(relative, dependencies = {}) {
    const filename = path.join(componentRoot, relative);
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, "utf8"), {
      module,
      exports: module.exports,
      require: (id) => Object.hasOwn(dependencies, id)
        ? dependencies[id]
        : require(require.resolve(id, { paths: [path.dirname(filename)] })),
      wx, Date, Set, Map, setTimeout, clearTimeout,
      console: { ...console, warn: (...args) => warnings.push(args) },
    }, { filename });
    return module.exports;
  }
  const queue = load("assets/queue.js")({
    buckets: { light: { cap: 20, evict: "farthest" }, transient: { cap: 5, evict: "fifo" } },
  });
  const text = load("assets/text.js");
  const danmaku = load("effects/danmaku.js")({});
  const matching = load("matching/index.js", {
    "./config": {},
    "../../../utils/supabase": { CONFIG: {} },
    "./capture": { createCaptureTiming: () => ({}) },
    "./log": () => {},
  });
  const shadowRoot = new Node("shadow");
  const instance = {
    ...queue, ...text, ...danmaku,
    _clearRemoteAssets: matching._clearRemoteAssets,
    xr, shadowRoot,
    scene: { createElement: (type, attributes) => new Node(type, attributes) },
    retrievalMode: "gps", _contentEpoch: 0, _activePlacementEpoch: 0,
    _allowedAssetIds: new Set(["text-asset"]), _seenAssets: new Map(),
    nodeList: [], flyingDanmakus: [], _hugeNodeList: [],
    _pendingAudioContexts: new Set(), _audioEntries: [], nodeIdCounter: 0,
    _textAssetStyle: style,
    getCamTransform: () => ({
      position: { x: 0, y: 0, z: 0 },
      worldMatrix: { transformDirection: (vector) => vector },
    }),
    _calcForwardPos: () => ({ x: 0, y: 0, z: 1 }),
    stopRandomConfetti() {},
  };
  const asset = {
    id: "text-asset", file_type: "text", text_content: "需要清除的文字",
    _contentEpoch: 0, config: { text_color: "#ABC", text_size: 1.75 },
  };
  return { instance, asset, created, events, warnings, faults, Node, xr };
}

function assertTreeCleared(context, root) {
  const nodes = [];
  root.dfs((node) => nodes.push(node));
  assert.equal(root.parent, null, "root is detached from the scene");
  const detachIndex = context.events.findIndex((event) => event.kind === "detach" && event.node === root);
  const releaseIndex = context.events.findIndex((event) => event.kind === "release" && event.node === root);
  assert.ok(detachIndex >= 0);
  assert.ok(releaseIndex > detachIndex, "release follows detachment");
  for (const node of nodes) {
    assert.equal(node.transform.visible, false, `${node.type} is hidden`);
    assert.equal(node.releaseCount, 1, `${node.type} releases exactly once`);
    if (node.text) {
      assert.equal(node.text.value, "", "XRText content is explicitly cleared");
      assert.ok(context.events.findIndex((event) =>
        event.kind === "text" && event.node === node && event.value === "") < detachIndex,
      "text is cleared before parent detachment");
    }
  }
}

for (const style of ["plain_white", "dialog_decorated"]) {
  test(`${style}: real text placement clears content, hides, detaches and releases the subtree`, () => {
    const context = harness(style);
    const { instance, asset, xr } = context;
    instance._placeTextAsset(asset);
    assert.equal(instance.nodeList.length, 1);
    const entry = instance.nodeList[0];
    const textNodes = context.created.filter((node) => node.type === xr.XRText);
    assert.equal(textNodes.length, 1);
    assert.equal(textNodes[0].text.value, asset.text_content);
    assert.equal(entry.textRefs.textEl, textNodes[0]);
    assert.equal(entry.node.children.length, style === "plain_white" ? 1 : 3);
    instance._clearRemoteAssets();
    assert.equal(instance.nodeList.length, 0);
    assert.equal(instance.shadowRoot.children.length, 0);
    assert.equal(instance._allowedAssetIds.size, 0);
    assertTreeCleared(context, entry.node);
    assert.equal(context.warnings.length, 0);
  });

  test(`${style}: failure after XRText attachment leaves no registered or orphan node`, () => {
    const context = harness(style);
    const { instance, asset, faults } = context;
    faults.afterTextAttached = true;
    assert.throws(() => instance._placeTextAsset(asset), /injected failure/);
    assert.equal(instance.nodeList.length, 0);
    assert.equal(instance.shadowRoot.children.length, 0);
    assertTreeCleared(context, context.created[1]);
    assert.equal(context.warnings.length, 0);
  });
}

test("capacity failure after registration rolls back the already-pushed text entry", () => {
  const context = harness();
  const { instance, asset } = context;
  instance._enforceCapacity = () => { throw new Error("injected capacity failure"); };
  assert.throws(() => instance._placeTextAsset(asset), /injected capacity failure/);
  assert.equal(instance.nodeList.length, 0);
  assert.equal(instance.shadowRoot.children.length, 0);
  assertTreeCleared(context, context.created[1]);
});

test("clearRemoteAssets reclaims an unregistered root built with the real bubble builder", () => {
  const context = harness("dialog_decorated");
  const { instance, Node, xr } = context;
  const root = new Node(xr.XRNode);
  instance.shadowRoot.addChild(root);
  instance._buildBubbleNodes(root, "未登记的历史文字");
  assert.equal(instance.nodeList.length, 0);
  assert.equal(root.children.length, 3);
  instance._clearRemoteAssets();
  assert.equal(instance.shadowRoot.children.length, 0);
  assertTreeCleared(context, root);
  assert.equal(context.warnings.length, 0);
});

test("GPS danmaku build failure removes its registered root without leaving a flying entry", () => {
  const context = harness("dialog_decorated");
  const { instance, faults } = context;
  faults.afterTextAttached = true;
  assert.doesNotThrow(() => instance.showDanmakuInXR("发送失败的弹幕"));
  assert.equal(instance.nodeList.length, 0);
  assert.equal(instance.flyingDanmakus.length, 0);
  assert.equal(instance.shadowRoot.children.length, 0);
  assertTreeCleared(context, context.created[1]);
  assert.equal(context.warnings.length, 1, "construction failure is reported");
});

test("GPS danmaku capacity failure rolls back an entry pushed before the throw", () => {
  const context = harness();
  const { instance } = context;
  instance._enforceCapacity = () => { throw new Error("injected capacity failure"); };
  instance.showDanmakuInXR("容量检查失败的弹幕");
  assert.equal(instance.nodeList.length, 0);
  assert.equal(instance.flyingDanmakus.length, 0);
  assert.equal(instance.shadowRoot.children.length, 0);
  assertTreeCleared(context, context.created[1]);
  assert.equal(context.warnings.length, 1);
});

test("repeated destroy after a full scene clear does not release nodes twice", () => {
  const context = harness();
  const { instance, asset } = context;
  instance._placeTextAsset(asset);
  const entry = instance.nodeList[0];
  instance._clearRemoteAssets();
  const eventCount = context.events.length;
  instance._destroyNode(entry);
  instance._destroyNode(entry);
  instance._clearRemoteAssets();
  assert.equal(context.events.length, eventCount);
  assertTreeCleared(context, entry.node);
});

for (const [name, run] of tests) {
  run();
  console.log(`PASS ${name}`);
}
console.log(`${tests.length} text cleanup regression checks passed.`);
