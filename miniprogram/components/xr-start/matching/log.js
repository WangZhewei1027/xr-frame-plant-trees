const config = require("./config");

// Only pass selected diagnostic fields, never headers, images or full API bodies.
module.exports = function matchLog(event, fields = {}, level = "info", requestId) {
  if (config.debugLogs === false) return;
  try {
    const write = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
    // Serialize immediately so DevTools does not show subsequently mutated values.
    write.call(console, `[AnchorMatch]${requestId ? `[${requestId}]` : ""} ${event}`,
      JSON.stringify(fields));
  } catch (_) {
    // Diagnostics must never interrupt recognition.
  }
};
