import { describe, expect, it } from "vitest";
import { getAllowedSection, normalizeArticleUrl, parseFeed } from "../src/feed";
import { feedXml } from "./helpers";

describe("N1 RSS feed", () => {
  it("parses metadata, sorts entries, and filters sections", () => {
    const xml = feedXml([
      {
        url: "https://n1info.rs/english/news/not-serbian/",
        title: "Excluded",
        publicationDate: "Wed, 24 Jun 2026 12:02:00 +0200",
      },
      {
        url: "https://n1info.rs/svet/second/?utm_source=test",
        title: "Svet &amp; region",
        publicationDate: "Wed, 24 Jun 2026 12:01:00 +0200",
        description: "Opis druge vesti",
        imageUrl: "https://n1info.rs/image.jpg",
      },
      {
        url: "https://n1info.rs/vesti/first",
        title: "Prva vest",
        publicationDate: "Wed, 24 Jun 2026 12:00:00 +0200",
      },
    ]);

    expect(parseFeed(xml)).toEqual([
      {
        url: "https://n1info.rs/vesti/first/",
        title: "Prva vest",
        publicationDate: "2026-06-24T10:00:00.000Z",
        section: "vesti",
        description: "Kratak opis",
        imageUrl: undefined,
      },
      {
        url: "https://n1info.rs/svet/second/",
        title: "Svet & region",
        publicationDate: "2026-06-24T10:01:00.000Z",
        section: "svet",
        description: "Opis druge vesti",
        imageUrl: "https://n1info.rs/image.jpg",
      },
    ]);
  });

  it("supports CDATA and numeric XML entities", () => {
    const xml = feedXml([
      {
        url: "https://n1info.rs/vesti/cdata/",
        title: "<![CDATA[Naslov &#38; detalji]]>",
        publicationDate: "Wed, 24 Jun 2026 12:00:00 +0200",
      },
    ]);
    expect(parseFeed(xml)[0]?.title).toBe("Naslov & detalji");
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

  it("rejects malformed RSS structure", () => {
    expect(() => parseFeed("<invalid />")).toThrow(/rss\/item is missing/);
  });
});
