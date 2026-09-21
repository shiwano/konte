import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ComfyUIHttpClient } from "../http-client.js";
import type { ComfyUIHistoryEntry, ComfyUIPromptResponse, ComfyUIQueueInfo } from "../types.js";

let server: http.Server;
let client: ComfyUIHttpClient;
let baseUrl: string;
let lastUploadBody = "";

const mockPromptResponse: ComfyUIPromptResponse = {
  prompt_id: "test-prompt-id",
  number: 1,
  node_errors: {},
};

const mockHistoryEntry: ComfyUIHistoryEntry = {
  outputs: {
    "9": {
      images: [{ filename: "output.png", subfolder: "", type: "output" }],
    },
  },
  status: {
    status_str: "success",
    completed: true,
    messages: [],
  },
};

const mockQueueInfo: ComfyUIQueueInfo = {
  queue_running: [],
  queue_pending: [],
};

function createMockServer(): Promise<http.Server> {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

      if (url.pathname === "/prompt" && req.method === "POST") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(mockPromptResponse));
        return;
      }

      if (url.pathname.startsWith("/history/")) {
        const promptId = url.pathname.split("/").pop() ?? "";
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ [promptId]: mockHistoryEntry }));
        return;
      }

      if (url.pathname === "/history/empty") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({}));
        return;
      }

      if (url.pathname === "/queue") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(mockQueueInfo));
        return;
      }

      if (url.pathname === "/interrupt" && req.method === "POST") {
        res.writeHead(200);
        res.end();
        return;
      }

      if (url.pathname === "/system_stats") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ system: { os: "linux" } }));
        return;
      }

      if (url.pathname === "/view") {
        res.writeHead(200);
        res.end(Buffer.from("fake-image-data"));
        return;
      }

      if (url.pathname === "/upload/image" && req.method === "POST") {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
          lastUploadBody = Buffer.concat(chunks).toString("utf-8");
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ name: "test.png", subfolder: "", type: "input" }));
        });
        return;
      }

      res.writeHead(404);
      res.end("Not Found");
    });

    srv.listen(0, "127.0.0.1", () => {
      resolve(srv);
    });
  });
}

beforeAll(async () => {
  server = await createMockServer();
  const addr = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;
  client = new ComfyUIHttpClient(baseUrl, { clientId: "test-client" });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("ComfyUIHttpClient", () => {
  it("queues a prompt", async () => {
    const result = await client.queuePrompt({
      "3": {
        class_type: "KSampler",
        inputs: { seed: 42 },
      },
    });

    expect(result.prompt_id).toBe("test-prompt-id");
    expect(result.number).toBe(1);
  });

  it("gets history for a prompt", async () => {
    const result = await client.getHistory("test-prompt-id");

    expect(result).not.toBeNull();
    expect(result?.status.completed).toBe(true);
    expect(result?.outputs["9"]!.images).toHaveLength(1);
  });

  it("returns null for non-existent history", async () => {
    const emptyHandler = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({}));
    });

    await new Promise<void>((resolve) => {
      emptyHandler.listen(0, "127.0.0.1", () => resolve());
    });
    const emptyAddr = emptyHandler.address() as { port: number };
    const c = new ComfyUIHttpClient(`http://127.0.0.1:${emptyAddr.port}`);
    try {
      const result = await c.getHistory("nonexistent");
      expect(result).toBeNull();
    } finally {
      await new Promise<void>((resolve) => emptyHandler.close(() => resolve()));
    }
  });

  it("gets queue info", async () => {
    const result = await client.getQueue();

    expect(result.queue_running).toEqual([]);
    expect(result.queue_pending).toEqual([]);
  });

  it("interrupts execution", async () => {
    await expect(client.interrupt()).resolves.toBeUndefined();
  });

  it("pings successfully", async () => {
    const result = await client.ping();
    expect(result).toBe(true);
  });

  it("ping returns false on connection failure", async () => {
    const badClient = new ComfyUIHttpClient("http://127.0.0.1:1");
    const result = await badClient.ping();
    expect(result).toBe(false);
  });

  it("streams an output file to disk", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "konte-http-client-"));
    try {
      const outputPath = path.join(dir, "output.png");
      await client.downloadOutputToFile(
        { filename: "output.png", subfolder: "", type: "output" },
        outputPath,
      );

      expect(await fs.readFile(outputPath, "utf-8")).toBe("fake-image-data");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("uploads an image", async () => {
    const data = Buffer.from("fake-image");
    const result = await client.uploadImage("test.png", data);

    expect(result.name).toBe("test.png");
  });

  it("uploads without overwriting, so a re-upload never rewrites a file a running prompt reads", async () => {
    await client.uploadImage("test.png", Buffer.from("fake-image"));

    expect(lastUploadBody).toMatch(/name="overwrite"\r\n\r\nfalse\r\n/);
  });

  it("throws COMFYUI_UNAVAILABLE on connection failure", async () => {
    const badClient = new ComfyUIHttpClient("http://127.0.0.1:1");
    await expect(badClient.queuePrompt({})).rejects.toMatchObject({
      code: "COMFYUI_UNAVAILABLE",
    });
  });

  it("throws COMFYUI_ERROR on HTTP error response", async () => {
    const errorServer = http.createServer((_req, res) => {
      res.writeHead(500);
      res.end("Internal Server Error");
    });

    await new Promise<void>((resolve) => {
      errorServer.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = errorServer.address() as { port: number };
    const c = new ComfyUIHttpClient(`http://127.0.0.1:${addr.port}`);

    try {
      await expect(c.queuePrompt({})).rejects.toMatchObject({
        code: "COMFYUI_ERROR",
      });
    } finally {
      await new Promise<void>((resolve) => errorServer.close(() => resolve()));
    }
  });

  it("distills node_errors from a 400 validation response", async () => {
    const validationServer = http.createServer((_req, res) => {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            type: "prompt_outputs_failed_validation",
            message: "Prompt outputs failed validation",
            details: "",
            extra_info: {},
          },
          node_errors: {
            "83": {
              class_type: "LoadImage",
              dependent_outputs: [],
              errors: [
                {
                  type: "invalid_input",
                  message: "Invalid image file",
                  details: "texture_fur.png",
                  extra_info: {},
                },
              ],
            },
          },
        }),
      );
    });

    await new Promise<void>((resolve) => {
      validationServer.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = validationServer.address() as { port: number };
    const c = new ComfyUIHttpClient(`http://127.0.0.1:${addr.port}`);

    try {
      await expect(c.queuePrompt({})).rejects.toMatchObject({
        code: "COMFYUI_ERROR",
        message: expect.stringContaining(
          "node 83 (LoadImage): Invalid image file: texture_fur.png",
        ),
      });
    } finally {
      await new Promise<void>((resolve) => validationServer.close(() => resolve()));
    }
  });

  it("redacts a credentialed URL echoed back in a validation error", async () => {
    const echoServer = http.createServer((_req, res) => {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            type: "prompt_outputs_failed_validation",
            message: "Prompt outputs failed validation",
            details: "",
            extra_info: {},
          },
          node_errors: {
            "12": {
              class_type: "LoadImageFromUrl",
              dependent_outputs: [],
              errors: [
                {
                  type: "invalid_input",
                  message: "Could not fetch image",
                  details: "https://cdn.example.com/in.png?token=SECRET_TOKEN&sig=abc",
                  extra_info: {},
                },
              ],
            },
          },
        }),
      );
    });

    await new Promise<void>((resolve) => {
      echoServer.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = echoServer.address() as { port: number };
    const c = new ComfyUIHttpClient(`http://127.0.0.1:${addr.port}`);

    try {
      const err = await c.queuePrompt({}).catch((e: unknown) => e);
      const message = (err as { message: string }).message;
      expect(message).toContain("https://cdn.example.com/in.png");
      expect(message).not.toContain("SECRET_TOKEN");
    } finally {
      await new Promise<void>((resolve) => echoServer.close(() => resolve()));
    }
  });

  it("redacts a credentialed URL in a non-JSON error body", async () => {
    const htmlServer = http.createServer((_req, res) => {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("upstream fetch of https://cdn.example.com/in.png?token=SECRET_TOKEN failed");
    });

    await new Promise<void>((resolve) => {
      htmlServer.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = htmlServer.address() as { port: number };
    const c = new ComfyUIHttpClient(`http://127.0.0.1:${addr.port}`);

    try {
      const err = await c.queuePrompt({}).catch((e: unknown) => e);
      const message = (err as { message: string }).message;
      expect(message).toContain("https://cdn.example.com/in.png");
      expect(message).not.toContain("SECRET_TOKEN");
    } finally {
      await new Promise<void>((resolve) => htmlServer.close(() => resolve()));
    }
  });
});
