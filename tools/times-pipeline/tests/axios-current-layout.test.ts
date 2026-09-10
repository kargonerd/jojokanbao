import { describe, expect, it } from "vitest";
import { assessArticleBody } from "../src/content/body.js";
import { axiosFetch } from "../src/sources/axios/fetch.js";
import { extractAxiosBody } from "../src/sources/axios/process.js";
import { extractAxiosImages } from "../src/sources/axios/images.js";

// Reduced from the 2026-09-10 publisher DOM: no article element, lead figure
// beside data-cy story-body, and smart-brevity spans around body blocks.
const page = `<main><div data-vars-event-name="story_view">
  <h1>News headline</h1>
  <div data-cy="author-image"><img src="/avatar.jpg"></div>
  <ul><li><a data-cy="byline-author" href="/authors/reporter">Reporter</a></li></ul>
  <p>Add Axios as your preferred source to see more of our stories on Google.</p>
  <figure data-cy="au-image"><img data-cy="StoryImage" src="/lead.jpg" srcset="/lead-small.jpg 640w, /lead-large.jpg 1920w" width="1920" height="1080">
    <figcaption data-cy="image-caption"><p>The lead photograph. Photo: Photographer</p></figcaption></figure>
  <div data-cy="story-body"><div data-chromatic="ignore"><span data-schema="smart-brevity">
    <p>The first body paragraph describes the news.</p><p><strong>Why it matters:</strong> Background and context.</p>
    <figure><img src="/inside.jpg" width="1200" height="800"><figcaption>Inside caption</figcaption></figure>
    <ul><li>A supporting detail.</li></ul><hr><p>The final paragraph.</p>
  </span></div></div>
</div><div><img src="/related.jpg"><p>Related story</p></div></main>`;
const url = "https://www.axios.com/2026/09/10/story";
const quality = { minimumCharacters: 20, minimumParagraphs: 3 };

describe("Axios current publisher layout", () => {
  it("uses the source extractor without leaking the author, promotion or captions", () => {
    const result = assessArticleBody(page, axiosFetch, quality, extractAxiosBody, url, "captured-page");
    expect(result.extractionPath).toBe("publisher-extractor-legacy");
    expect(result.body).toContain("The first body paragraph");
    expect(result.body).toContain("<hr>");
    for (const text of ["Reporter", "preferred source", "Photographer", "Inside caption", "Related story"]) {
      expect(result.body).not.toContain(text);
    }
  });

  it("captures the lead and inline images even without an article element", () => {
    expect(extractAxiosImages(page, url)).toEqual([
      expect.objectContaining({ sourceUrl: "https://www.axios.com/lead-large.jpg", role: "lead", caption: "The lead photograph. Photo: Photographer" }),
      expect.objectContaining({ sourceUrl: "https://www.axios.com/inside.jpg", role: "content", afterBlock: 2, caption: "Inside caption" }),
    ]);
  });
});
