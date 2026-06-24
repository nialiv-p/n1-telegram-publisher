import { describe, expect, it } from "vitest";
import { buildTelegramContent, escapeTelegramHtml } from "../src/format";

describe("Telegram formatting", () => {
  it("escapes Telegram HTML", () => {
    expect(escapeTelegramHtml('A & B < C > D "quoted"')).toBe(
      'A &amp; B &lt; C &gt; D "quoted"',
    );
  });

  it("builds a photo caption and text fallback", () => {
    const result = buildTelegramContent(
      "Naslov <vesti>",
      "Kratak & jasan opis.",
      "https://n1info.rs/vesti/test/",
    );
    expect(result.photoCaption).toContain("<b>Naslov &lt;vesti&gt;</b>");
    expect(result.photoCaption).toContain("Kratak &amp; jasan opis.");
    expect(result.photoCaption).toContain("Pročitajte na N1");
    expect(result.textMessage.length).toBeLessThanOrEqual(4096);
  });

  it("truncates a long description on a word boundary within caption limit", () => {
    const result = buildTelegramContent(
      "Naslov",
      "veoma dugačak opis ".repeat(200),
      "https://n1info.rs/vesti/test/",
    );
    expect(result.photoCaption.length).toBeLessThanOrEqual(1024);
    expect(result.photoCaption).toMatch(/…\n\n<a href=/);
    expect(result.photoCaption).not.toMatch(/dugač…/);
  });
});
