const DISPATCH_URL =
  "https://api.github.com/repos/nialiv-p/n1-telegram-publisher/actions/workflows/ingest-feed.yml/dispatches";

export async function dispatchIngestionWorkflow(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (!token) throw new Error("GITHUB_DISPATCH_TOKEN must be configured");
  const response = await fetchImpl(DISPATCH_URL, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "n1-telegram-publisher",
      "X-GitHub-Api-Version": "2026-03-10",
    },
    body: JSON.stringify({ ref: "main" }),
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status !== 204) {
    const details = (await response.text()).slice(0, 500);
    throw new Error(`GitHub workflow dispatch failed with HTTP ${response.status}: ${details}`);
  }
}
