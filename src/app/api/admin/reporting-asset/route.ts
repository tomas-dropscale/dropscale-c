import { NextResponse, type NextRequest } from "next/server";

import { getSessionProfile } from "@/lib/supabase/server";

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const SAFE_IMAGE_TYPES = new Set([
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

function allowedAssetUrl(value: string | null): URL | null {
  if (!value || value.length > 2_048) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      url.hostname === "tpc.googlesyndication.com" &&
      !url.username &&
      !url.password
      ? url
      : null;
  } catch {
    return null;
  }
}

async function readBoundedImage(response: Response): Promise<Uint8Array | null> {
  if (!response.body) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body.getReader();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_IMAGE_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function GET(request: NextRequest) {
  const { profile } = await getSessionProfile();
  if (profile?.role !== "admin") {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }

  const assetUrl = allowedAssetUrl(request.nextUrl.searchParams.get("url"));
  if (!assetUrl) {
    return NextResponse.json({ error: "Invalid asset URL." }, { status: 400 });
  }

  try {
    const upstream = await fetch(assetUrl, {
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    const contentType = upstream.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    const declaredBytes = Number(upstream.headers.get("content-length") ?? "0");
    if (
      !upstream.ok ||
      !contentType ||
      !SAFE_IMAGE_TYPES.has(contentType) ||
      (Number.isFinite(declaredBytes) && declaredBytes > MAX_IMAGE_BYTES)
    ) {
      return NextResponse.json({ error: "Asset unavailable." }, { status: 502 });
    }

    const image = await readBoundedImage(upstream);
    if (!image) {
      return NextResponse.json({ error: "Asset unavailable." }, { status: 502 });
    }

    const body = image.buffer.slice(
      image.byteOffset,
      image.byteOffset + image.byteLength,
    ) as ArrayBuffer;
    return new Response(body, {
      headers: {
        "Cache-Control": "private, max-age=86400",
        "Content-Type": contentType,
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return NextResponse.json({ error: "Asset unavailable." }, { status: 502 });
  }
}
