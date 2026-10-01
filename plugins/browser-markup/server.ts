import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { MARKUP_MENTION_PROVIDER_ID } from "./shared";

const STORAGE_PREFIX = "screenshot:";

const screenshotSchema = z
  .object({
    // Project attachment path returned by projects.attachments.upload.
    path: z.string().min(1).max(1024),
    url: z.string().max(32768),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  })
  .strict();

export type ScreenshotRecord = z.infer<typeof screenshotSchema>;

export const browserMarkupRpcContract = defineRpcContract({
  save: {
    input: screenshotSchema,
    output: z.object({ id: z.string() }).strict(),
  },
});

export function formatScreenshotContext(record: ScreenshotRecord): string {
  return [
    "The user attached an annotated screenshot of a Browser tab. Their drawings (arrows, boxes, highlights, text) mark what they want you to look at.",
    `URL: ${record.url}`,
    `Viewport capture: ${record.width}x${record.height}px`,
  ].join("\n");
}

export default async function plugin(bb: BbPluginApi) {
  bb.rpc.register(browserMarkupRpcContract, {
    async save(record) {
      const id = crypto.randomUUID();
      await bb.storage.kv.set(`${STORAGE_PREFIX}${id}`, record);
      return { id };
    },
  });

  bb.ui.registerMentionProvider({
    id: MARKUP_MENTION_PROVIDER_ID,
    label: "Annotated screenshots",
    search: () => [],
    async resolve(id) {
      const parsed = screenshotSchema.safeParse(
        await bb.storage.kv.get(`${STORAGE_PREFIX}${id}`),
      );
      if (!parsed.success) {
        throw new Error("This annotated screenshot is no longer available");
      }
      return {
        context: formatScreenshotContext(parsed.data),
        experimental_images: [{ type: "localImage", path: parsed.data.path }],
      };
    },
  });
}
