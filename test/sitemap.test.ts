import { describe, expect, it } from "vitest";
import { getAllowedSection, normalizeArticleUrl, parseSitemap } from "../src/sitemap";
import { sitemapXml } from "./helpers";

describe("sitemap", () => {
  it("parses namespaces, entities, sorts entries, and filters sections", () => {
    const xml = sitemapXml([
      {
        url: "https://n1info.rs/english/news/not-serbian/",
        title: "Excluded",
        publicationDate: "2026-06-24T12:02:00+02:00",
      },
      {
        url: "https://n1info.rs/svet/second/?utm_source=test",
        title: "Svet &amp; region",
        publicationDate: "2026-06-24T12:01:00+02:00",
      },
      {
        url: "https://n1info.rs/vesti/first",
        title: "Prva vest",
        publicationDate: "2026-06-24T12:00:00+02:00",
      },
    ]);

    expect(parseSitemap(xml)).toEqual([
      {
        url: "https://n1info.rs/vesti/first/",
        title: "Prva vest",
        publicationDate: "2026-06-24T12:00:00+02:00",
        section: "vesti",
      },
      {
        url: "https://n1info.rs/svet/second/",
        title: "Svet & region",
        publicationDate: "2026-06-24T12:01:00+02:00",
        section: "svet",
      },
    ]);
  });

  it("supports CDATA and numeric XML entities", () => {
    const xml = sitemapXml([
      {
        url: "https://n1info.rs/vesti/cdata/",
        title: "<![CDATA[Naslov &#38; detalji]]>",
        publicationDate: "2026-06-24T12:00:00+02:00",
      },
    ]);
    expect(parseSitemap(xml)[0]?.title).toBe("Naslov & detalji");
  });

  it("normalizes only HTTPS N1 URLs", () => {
    expect(normalizeArticleUrl("https://n1info.rs/vesti/test?x=1#top")).toBe(
      "https://n1info.rs/vesti/test/",
    );
    expect(normalizeArticleUrl("http://n1info.rs/vesti/test")).toBeNull();
    expect(normalizeArticleUrl("https://example.com/vesti/test")).toBeNull();
  });

  it("uses an explicit allowlist", () => {
    expect(getAllowedSection("https://n1info.rs/kultura/test/")).toBe("kultura");
    expect(getAllowedSection("https://n1info.rs/video/test/")).toBeNull();
    expect(getAllowedSection("https://n1info.rs/unknown/test/")).toBeNull();
  });

  it("rejects malformed sitemap structure", () => {
    expect(() => parseSitemap("<not-a-sitemap />")).toThrow(/urlset\/url is missing/);
  });
});
