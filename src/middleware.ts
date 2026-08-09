import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

/**
 * Gate the research corpus.
 *
 * The trends radar is served as static files so its validated chart code runs
 * unchanged, but static means public: without this, five years of commercial
 * demand research sat at a guessable URL for anyone on the internet. Cloudflare
 * normally answers asset requests without waking the Worker at all, so
 * wrangler's `run_worker_first` routes /research/* here first.
 *
 * The check is deliberately a real one — a valid session AND the admin role —
 * because a signed-in client is not entitled to this either.
 */
export async function middleware(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    // Fail closed: an unconfigured deployment must not serve the corpus.
    return new NextResponse("Not found", { status: 404 });
  }

  const response = NextResponse.next();
  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return new NextResponse("Not found", { status: 404 });
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();
  if (profile?.role !== "admin") {
    // 404 rather than 403: a client has no business learning this exists.
    return new NextResponse("Not found", { status: 404 });
  }

  return response;
}

export const config = {
  matcher: ["/research/:path*"],
};
