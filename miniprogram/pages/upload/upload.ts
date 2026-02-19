interface LocationData {
  latitude: number;
  longitude: number;
  latStr: string;
  lngStr: string;
}

Page({
  data: {
    textContent: "",
    location: null as LocationData | null,
    isGettingLocation: false,
    isSubmitting: false,
    canSubmit: false,
  },

  // Supabase 配置
  supabaseUrl: "https://mkdfezaufjhrfjkfqlbj.supabase.co",
  supabaseKey:
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1rZGZlemF1ZmpocmZqa2ZxbGJqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjUyMDI2NzksImV4cCI6MjA4MDc3ODY3OX0.YvoVQP5k61rl1dbm-y7O-MQCsfke3rnSIzhWvbVGQdU",
  workspaceName: "test",

  onLoad() {
    this.getLocation();
  },

  onTextInput(e: WechatMiniprogram.Input) {
    const textContent = e.detail.value;
    this.setData({
      textContent,
      canSubmit: textContent.trim().length > 0 && this.data.location !== null,
    });
  },

  getLocation() {
    this.setData({ isGettingLocation: true });

    wx.getLocation({
      type: "gcj02",
      success: (res) => {
        console.log("[位置] 获取成功:", res);
        this.setData({
          location: {
            latitude: res.latitude,
            longitude: res.longitude,
            latStr: res.latitude.toFixed(6),
            lngStr: res.longitude.toFixed(6),
          },
          canSubmit: this.data.textContent.trim().length > 0,
        });
        wx.showToast({ title: "位置获取成功", icon: "success" });
      },
      fail: (err) => {
        console.error("[位置] 获取失败:", err);
        wx.showToast({ title: "位置获取失败", icon: "error" });
      },
      complete: () => {
        this.setData({ isGettingLocation: false });
      },
    });
  },

  async submitText() {
    const { textContent, location } = this.data;

    if (!textContent.trim() || !location) {
      wx.showToast({ title: "请填写内容并获取位置", icon: "none" });
      return;
    }

    this.setData({ isSubmitting: true });

    try {
      const response = await this.request({
        url: `${this.supabaseUrl}/rest/v1/rpc/upload_text_asset`,
        method: "POST",
        data: {
          user_lat: location.latitude,
          user_lng: location.longitude,
          workspace_name: this.workspaceName,
          content: textContent.trim(),
        },
      });

      if (response.statusCode === 200) {
        console.log("[上传] 成功:", response.data);
        wx.showToast({ title: "上传成功", icon: "success" });
        this.setData({ textContent: "", canSubmit: false });
      } else {
        throw new Error(`上传失败: ${response.statusCode}`);
      }
    } catch (err) {
      console.error("[上传] 错误:", err);
      wx.showToast({ title: "上传失败", icon: "error" });
    } finally {
      this.setData({ isSubmitting: false });
    }
  },

  // 封装请求方法
  request<T = any>(options: {
    url: string;
    method: "GET" | "POST";
    header?: Record<string, string>;
    data?: any;
  }): Promise<{ statusCode: number; data: T }> {
    return new Promise((resolve, reject) => {
      wx.request({
        url: options.url,
        method: options.method,
        header: {
          "Content-Type": "application/json",
          apikey: this.supabaseKey,
          Authorization: `Bearer ${this.supabaseKey}`,
          ...options.header,
        },
        data: options.data,
        success: (res) => resolve(res as { statusCode: number; data: T }),
        fail: reject,
      });
    });
  },

  goBack() {
    wx.navigateBack();
  },
});
