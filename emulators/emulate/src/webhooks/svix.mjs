import { createHmac } from "node:crypto";

export const svixShouldRetry = response => response?.headers.get("webhook-delivery") !== "abort-message";

export function svixHeaders({ id, rawBody, secret }, timestamp = Math.floor(Date.now() / 1000)) {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const signature = createHmac("sha256", key).update(`${id}.${timestamp}.${rawBody}`).digest("base64");
  return { "content-type": "application/json", "svix-id": id,
    "svix-timestamp": String(timestamp), "svix-signature": `v1,${signature}` };
}
