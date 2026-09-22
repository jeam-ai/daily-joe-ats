import { after } from "next/server";
import { runExtractionJobs } from "@/lib/server/ai-extraction";
import { z } from "zod";
import { requireOrigin, requireUser } from "@/lib/auth/session";
import { previewImport, confirmImport } from "@/lib/google/gmail/intake";
import { SafeError } from "@/lib/server/config";
import { safeError } from "@/lib/server/response";
export const maxDuration = 300;
export const runtime = "nodejs";
export async function POST(req: Request) {
  try {
    requireOrigin(req);
    const user = await requireUser();
    const raw = await req.text();
    if (raw.length > 15000) throw new SafeError("Request too large.");
    const body = JSON.parse(raw);
    if (body.action === "preview")
      return Response.json(await previewImport(user));
    const parsed = z
      .object({
        id: z.uuid(),
        confirmed: z.literal(true),
        selections: z
          .array(
            z.object({
              messageId: z.string().max(200),
              name: z.string().max(200),
              hiringNeedId: z.string().max(200),
            }),
          )
          .max(10),
      })
      .safeParse(body);
    if (!parsed.success) throw new SafeError("Invalid import confirmation.");
    const result = await confirmImport(
      user,
      parsed.data.id,
      parsed.data.selections,
      true,
    );
    after(() => runExtractionJobs());
    return Response.json({
      ...result,
      syncStatus: "Changes committed to Google Sheets.",
    });
  } catch (e) {
    return safeError(e);
  }
}
