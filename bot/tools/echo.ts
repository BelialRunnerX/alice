import { defineTool } from "@cursor/bdk/tools";
import { z } from "zod/v3";

export default defineTool({
  description: "Echo a short message back (demo tool).",
  inputSchema: z.object({ message: z.string() }),
  async execute({ message }) {
    return { echoed: message };
  },
});
