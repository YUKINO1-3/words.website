import { IncomingMessage, ServerResponse } from "node:http";
import { Duplex } from "node:stream";
import type { Express } from "express";
export async function invoke(
  app: Express,
  route: string,
  options: {
    method?: string;
    remoteAddress?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
) {
  return await new Promise<{
    status: number;
    headers: Record<string, string>;
    data: any;
    raw: string;
    buffer: Buffer;
  }>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = new Duplex({
      read() {},
      write(chunk, _encoding, done) {
        chunks.push(Buffer.from(chunk));
        done();
      },
    });
    Object.defineProperty(socket, "remoteAddress", {
      value: options.remoteAddress || "127.0.0.1",
    });
    const req = new IncomingMessage(socket as any);
    req.complete = true;
    req.url = route;
    req.method =
      options.method || (options.body === undefined ? "GET" : "POST");
    req.headers = { host: "127.0.0.1:3000", ...options.headers };
    const body =
      options.body === undefined
        ? undefined
        : Buffer.isBuffer(options.body)
          ? options.body
          : Buffer.from(JSON.stringify(options.body));
    if (body) {
      req.headers["content-type"] ||= "application/json";
      req.headers["content-length"] = String(body.length);
    }
    const res = new ServerResponse(req);

    const timer = setTimeout(
      () => reject(new Error("In-process request timed out: " + route)),
      10_000,
    );
    res.write = ((chunk: any, _encoding?: any, callback?: any) => {
      chunks.push(Buffer.from(chunk));
      if (typeof _encoding === "function") _encoding();
      else callback?.();
      return true;
    }) as any;
    res.end = ((chunk?: any) => {
      if (chunk) chunks.push(Buffer.from(chunk));
      clearTimeout(timer);
      const raw = Buffer.concat(chunks).toString();
      const headers = Object.fromEntries(
        Object.entries(res.getHeaders()).map(([k, v]) => [k, String(v)]),
      );
      let data;
      try {
        data = raw ? JSON.parse(raw) : null;
      } catch {
        data = raw;
      }
      resolve({
        status: res.statusCode,
        headers,
        data,
        raw,
        buffer: Buffer.concat(chunks),
      });
      res.emit("finish");
      socket.destroy();
      return res;
    }) as any;
    res.on("error", reject);
    app(req, res);
    if (body) req.push(body);
    req.push(null);
  });
}
