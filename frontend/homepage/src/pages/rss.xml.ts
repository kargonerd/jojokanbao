import rss from "@astrojs/rss";
import { getCollection } from "astro:content";
import type { APIContext } from "astro";
import { sortByDate } from "@/lib/blog";

export async function GET(context: APIContext) {
  const posts = sortByDate(await getCollection("blog", ({ data }) => !data.draft));

  return rss({
    title: "JOJO",
    description: "关注现实问题、技术变迁与社会关系。",
    site: context.site!,
    items: posts.map((post) => ({
      title: post.data.title,
      description: post.data.description,
      pubDate: post.data.date,
      link: `/articles/${post.id}/`,
    })),
  });
}
