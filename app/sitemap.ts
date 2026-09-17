import type { MetadataRoute } from "next";
import { SITE } from "@/lib/site";

/** One page, said plainly, so the canonical URL is never guessed at. */
export default function sitemap(): MetadataRoute.Sitemap {
  return [{ url: SITE.url, changeFrequency: "weekly", priority: 1 }];
}
