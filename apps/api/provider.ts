import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import https from "node:https";
import http from "node:http";

export type AIConfig = { apiKey: string; baseUrl: string; model: string };
const blocked4 = new BlockList();
const blocked6 = new BlockList();
for (const [ip, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blocked4.addSubnet(ip, prefix, "ipv4");
for (const [ip, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const)
  blocked6.addSubnet(ip, prefix, "ipv6");
export function isPublicAddress(address: string) {
  const family = isIP(address);
  return family === 4
    ? !blocked4.check(address, "ipv4")
    : family === 6 &&
        /^[23]/i.test(address) &&
        !blocked6.check(address, "ipv6");
}
export function validateBaseUrl(value: string) {
  const url = new URL(value);
  const localTest =
    process.env.NODE_ENV === "test" &&
    process.env.AI_ALLOW_LOCAL_TEST === "true";
  if (
    (!localTest && url.protocol !== "https:") ||
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    (!localTest && url.port && url.port !== "443")
  )
    throw new Error(
      "AI 地址必须是无用户名、查询参数及片段的 HTTPS 地址，端口须为 443",
    );
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (
    !localTest &&
    (host === "localhost" ||
      host.endsWith(".localhost") ||
      host.endsWith(".internal") ||
      host.endsWith(".local") ||
      (isIP(host) && !isPublicAddress(host)))
  )
    throw new Error("AI 地址不能指向内网或云元数据服务");
  return url;
}
export async function requestAI(
  value: string,
  options: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) {
  const url = validateBaseUrl(value);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await lookup(hostname, { all: true });
  const localTest =
    process.env.NODE_ENV === "test" &&
    process.env.AI_ALLOW_LOCAL_TEST === "true";
  if (
    !addresses.length ||
    (!localTest && addresses.some((x) => !isPublicAddress(x.address)))
  )
    throw new Error("AI 地址解析到不允许的网络");
  const address = addresses[0];
  // Pin the validated DNS answer for this connection, retaining hostname/SNI verification.
  return await new Promise<{
    ok: boolean;
    status: number;
    json: () => Promise<unknown>;
  }>((resolve, reject) => {
    const send = url.protocol === "https:" ? https.request : http.request;
    const req = send(
      url,
      {
        method: options.method,
        headers: options.headers,
        signal: options.signal,
        family: address.family,
        lookup: (_name, options, cb) => {
          if ((options as { all?: boolean }).all) (cb as any)(null, [address]);
          else cb(null, address.address, address.family);
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 2 * 1024 * 1024) {
            req.destroy(new Error("AI 响应过大"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("error", reject);
        res.on("end", () => {
          const status = res.statusCode || 0;
          resolve({
            ok: status >= 200 && status < 300,
            status,
            json: async () =>
              JSON.parse(Buffer.concat(chunks).toString("utf8")),
          });
        });
      },
    );
    req.on("error", reject);
    req.end(options.body);
  });
}
