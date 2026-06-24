import { describe, expect, it, vi } from "vitest";
import { dispatchIngestionWorkflow } from "../src/github";

describe("GitHub workflow dispatch", () => {
  it("dispatches the ingestion workflow on main", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof fetch;

    await dispatchIngestionWorkflow("test-token", fetchImpl);

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] ?? [];
    expect(url).toContain("/actions/workflows/ingest-feed.yml/dispatches");
    expect(init).toMatchObject({ method: "POST", body: JSON.stringify({ ref: "main" }) });
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test-token");
  });

  it("reports GitHub API failures without exposing the token", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ message: "Forbidden" }, { status: 403 }),
    ) as unknown as typeof fetch;

    await expect(dispatchIngestionWorkflow("secret-token", fetchImpl)).rejects.toThrow(
      /HTTP 403.*Forbidden/,
    );
  });

  it("requires a configured token", async () => {
    await expect(dispatchIngestionWorkflow("")).rejects.toThrow(/must be configured/);
  });
});
