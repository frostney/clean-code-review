import type { MetadataRoute } from "next";
import { SITE } from "@/lib/site";

/** Everything here is public and meant to be read, by people and by crawlers. */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: "/" }],
    sitemap: `${SITE.url}/sitemap.xml`,
    host: SITE.url,
  };
}
