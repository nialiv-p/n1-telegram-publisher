import { describe, expect, it } from "vitest";
// @ts-expect-error The enrichment CLI is intentionally plain JavaScript for GitHub Actions.
import { extractLead } from "../scripts/enrich-articles.mjs";

describe("article lead extraction", () => {
  it("extracts a complete lead with inline markup and entities", () => {
    const html = `<article>
      <p class="lead" data-testid="article-lead-text">
        Ovo je <strong>potpun</strong> uvod &amp; završava se rečenicom.
      </p>
      <div data-selector="article-content-wrapper"><p>Drugi pasus.</p></div>
    </article>`;
    expect(extractLead(html)).toBe("Ovo je potpun uvod & završava se rečenicom.");
  });

  it("returns undefined when the article lead is absent", () => {
    expect(extractLead("<article><p>Običan pasus</p></article>")).toBeUndefined();
  });
});
