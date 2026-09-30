/** Account-routing metadata only; callers must verify OAuth provenance first. */
export function codexAccountId(authorization: string): string | undefined {
  try {
    const payload = authorization.replace(/^Bearer\s+/iu, "").split(".")[1];
    if (!payload) return undefined;
    const decoded: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!decoded || typeof decoded !== "object" || !("https://api.openai.com/auth" in decoded))
      return undefined;
    const auth = decoded["https://api.openai.com/auth"];
    if (!auth || typeof auth !== "object" || !("chatgpt_account_id" in auth)) return undefined;
    const accountId = auth.chatgpt_account_id;
    return typeof accountId === "string" && accountId.trim() ? accountId : undefined;
  } catch {
    return undefined;
  }
}
