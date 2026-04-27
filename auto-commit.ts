import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
export default function (pi: ExtensionAPI) {
  pi.on("turn_end", async (event, ctx) => {
    // 这里可以调用 git commit
    console.log("Turn ended, could auto-commit here");
  });
}
