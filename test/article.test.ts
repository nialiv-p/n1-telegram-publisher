import { describe, expect, it } from "vitest";
import { parseArticleMetadata } from "../src/article";

describe("article metadata", () => {
  it("reads Open Graph fields regardless of attribute order", () => {
    const html = `<html><head>
      <meta content="Naslov &amp; detalji" property="og:title">
      <meta property='og:description' content='Opis &quot;vesti&quot;'>
      <meta content="https://n1info.rs/image.jpg" property="og:image">
    </head></html>`;
    expect(parseArticleMetadata(html)).toEqual({
      title: "Naslov & detalji",
      description: 'Opis "vesti"',
      imageUrl: "https://n1info.rs/image.jpg",
    });
  });

  it("falls back to the standard description and rejects non-HTTPS images", () => {
    const html = `<meta name="description" content="Opis"><meta property="og:image" content="http://example.com/a.jpg">`;
    expect(parseArticleMetadata(html)).toEqual({
      title: undefined,
      description: "Opis",
      imageUrl: undefined,
    });
  });
});
