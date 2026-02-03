Component({
    behaviors: [require("../common/share-behavior").default],
    properties: {
        a: Number,
    },
    data: {
        loaded: false,
        arReady: false,
        clock: 0,
        last_clock: 0,
    },
    lifetimes: {
        async attached() {
            console.log("data", this.data);
            // 初始化节点管理
            this.nodeIdCounter = 0;
            this.nodeList = [];
            this.maxNodeCount = 10;
        },
    },
    methods: {
        async handleReady({ detail }) {
            const xrScene = (this.scene = detail.value);
            this.mat = new (wx.getXrFrameSystem().Matrix4)();
            this.shadowRoot = xrScene.getElementById("shadow-root");

            const { value: model } = await xrScene.assets.loadAsset({
                type: "gltf",
                assetId: "tree",
                src: "https://8thwall.8thwall.app/assets/tree-d51u9146bh.glb",
            });
            this.gltfModel = model;

            console.log("xr-scene", xrScene);
        },
        handleAssetsProgress: function ({ detail }) {
            console.log("assets progress", detail.value);
        },
        handleAssetsLoaded: function ({ detail }) {
            console.log("assets loaded", detail.value);
            // this.setData({loaded: true});
            this.scene.event.addOnce("touchstart", this.placeNode.bind(this));
        },
        handleARReady: function ({ detail }) {
            console.log("arReady", this.scene.ar.arVersion);
        },
        handleTick() {
            this.data.clock++;

            // 3 秒一次（假设 60fps）
            if (this.data.clock - this.data.last_clock < 180) return;
            this.data.last_clock = this.data.clock;

            const xr = wx.getXrFrameSystem();
            const scene = this.scene;

            const camera = scene.getElementById("camera");
            const camTransform = camera.getComponent(xr.Transform);
            if (!camTransform) return;

            const camPos = camTransform.position;

            // 随机摆在 camera 周围 0.8~1.5 米
            const angle = Math.random() * Math.PI * 2;
            const radius = 0.8 + Math.random() * 0.7;
            const x = camPos.x + Math.cos(angle) * radius;
            const z = camPos.z + Math.sin(angle) * radius;
            const y = camPos.y;

            // 控制节点总量，超出时删除最旧的
            if (this.nodeList.length >= this.maxNodeCount) {
                const oldestNode = this.nodeList.shift();
                this.shadowRoot.removeChild(oldestNode);
                console.log("[remove] oldest node removed");
            }

            // ========= 1️⃣ 创建 root XRNode =========
            const nodeId = `label-node-${this.nodeIdCounter++}`;
            const rootNode = scene.createElement(xr.XRNode, {
                id: nodeId,
                position: `${x} ${y} ${z}`,
                scale: "0.1 0.1 0.1",
            });

            // 👉 挂到 shadowRoot（不是 scene）
            this.shadowRoot.addChild(rootNode);

            // 记录节点
            this.nodeList.push(rootNode);

            // ========= 2️⃣ 创建 mesh（绿色平面） =========
            const mesh = scene.createElement(xr.XRMesh, {
                position: "0 0 -0.01",
                rotation: "90 0 0",
                scale: "8 1 8",
                geometry: "plane",
                states: "renderQueue: 2501, alphaMode: BLEND, cullOn: false",
                uniforms: "u_baseColorFactor:0.2 0.6 0.2 0.8",
            });
            rootNode.addChild(mesh);

            // ========= 3️⃣ 创建 text =========
            const text = scene.createElement(xr.XRText, {
                position: "0 0 0",
                value: "居中",
                size: "2",
                anchor: "0.5 0.5",
                "never-cull": "",
            });
            rootNode.addChild(text);

            console.log(
                `[spawn] ${nodeId} at`,
                x,
                y,
                z,
                `total: ${this.nodeList.length}`,
            );
        },
        placeNode(event) {
            try {
                console.log("start");

                const xr = wx.getXrFrameSystem();

                // 创建 XRGLTF 元素（和 example 一致）
                const gltfElement = this.scene.createElement(xr.XRGLTF);

                // 挂到 shadowRoot（⚠️ 关键）
                this.shadowRoot.addChild(gltfElement);

                // 设置模型
                gltfElement.getComponent(xr.GLTF).setData({
                    model: this.gltfModel,
                });

                // 通过 AR 系统放到当前命中的平面
                this.scene.ar.placeHere(gltfElement, true);

                // 设置缩放
                gltfElement.getComponent(xr.Transform).scale.setValue(0.3, 0.3, 0.3);

                const pos = gltfElement.getComponent(xr.Transform).position;

                console.log("Tree position: ", pos.x, pos.z, pos.y);

                console.log("place success");
            } catch (e) {
                console.error("placeNode error", e);
            }

            // 下一次再点才能继续放
            this.scene.event.addOnce("touchstart", this.placeNode.bind(this));
        },
    },
});
