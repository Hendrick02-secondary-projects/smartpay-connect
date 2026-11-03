import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { organizations } from "@/lib/db/schema";
import { errorResponse, HttpError } from "@/lib/http";
import { portalQrSvg } from "@/lib/qr";

export async function GET(_request: Request, { params }: { params: Promise<{ org: string }> }) {
  try {
    const { org } = await params;
    const [row] = await getDb().select({ slug: organizations.slug }).from(organizations).where(eq(organizations.slug, org)).limit(1);
    if (!row) throw new HttpError(404, "not_found", "Organização não encontrada.");
    const svg = await portalQrSvg(row.slug);
    return new Response(svg, {
      headers: {
        "Content-Type": "image/svg+xml",
        "Content-Disposition": `attachment; filename="qr-${row.slug}-payments.svg"`,
        "Cache-Control": "public, max-age=3600",
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
