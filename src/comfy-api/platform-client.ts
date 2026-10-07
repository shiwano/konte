import { z } from "zod";
import { parseApiResponse } from "../backends/http-util.js";
import {
  type ComfyApiAuth,
  ComfyApiHttpError,
  COMFY_PLATFORM_ORIGIN,
  sendIdempotent,
  sendOnce,
  toHttpError,
} from "./http.js";

const BuildSchema = z
  .object({ id: z.string(), updatedAt: z.string().nullable().optional() })
  .passthrough();
export type PlatformBuild = z.infer<typeof BuildSchema>;

const CreateReleaseSchema = z
  .object({ releaseId: z.string().optional(), buildVersionId: z.string().optional() })
  .passthrough();

const ReleaseSchema = z
  .object({
    id: z.string().optional(),
    status: z.string().optional(),
    deployable: z.boolean().optional(),
    artifacts: z
      .array(z.object({ failureReason: z.string().nullable().optional() }).passthrough())
      .optional(),
  })
  .passthrough();
export type PlatformRelease = z.infer<typeof ReleaseSchema>;

const DeploymentSchema = z
  .object({
    id: z.string(),
    status: z.string(),
    releaseId: z.string().nullable().optional(),
    endpointUrl: z.string().nullable().optional(),
    deletedAt: z.string().nullable().optional(),
    computeConfig: z
      .object({
        gpuClass: z.string().optional(),
        region: z.string().optional(),
        min: z.number().optional(),
        max: z.number().optional(),
      })
      .passthrough()
      .optional(),
    progress: z
      .object({ step: z.string().nullable().optional() })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();
export type PlatformDeployment = z.infer<typeof DeploymentSchema>;

const DeploymentPageSchema = z
  .object({
    deployments: z.array(DeploymentSchema).default([]),
    nextCursor: z.string().nullable().optional(),
  })
  .passthrough();
// A listing that keeps answering with a fresh cursor is cut off here.
const MAX_DEPLOYMENT_PAGES = 100;

const ReleaseLogsSchema = z.object({ log: z.string().optional() }).passthrough();

export type ComputeConfig = { gpuClass: string; region: string; min: 0; max: number };

/** The Builder (`/builder/v1`) and Deploy (`/deploy/v1`) control APIs. */
export class ComfyPlatformClient {
  private readonly auth: ComfyApiAuth;
  private readonly origin: string;

  constructor(apiKey: string, origin: string = COMFY_PLATFORM_ORIGIN) {
    this.auth = { scheme: "x-api-key", key: apiKey };
    this.origin = origin.replace(/\/+$/, "");
  }

  private builder(path: string): string {
    return `${this.origin}/builder/v1/${path}`;
  }

  private deploy(path: string): string {
    return `${this.origin}/deploy/v1/${path}`;
  }

  private async post(
    url: string,
    body: unknown,
    what: string,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    const res = await sendOnce(
      url,
      {
        method: "POST",
        auth: this.auth,
        headers: { "Content-Type": "application/json", ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      what,
    );
    if (!res.ok) throw await toHttpError(res, what);
    return res;
  }

  private async get(url: string, what: string): Promise<Response> {
    const res = await sendIdempotent(url, { auth: this.auth });
    if (!res.ok) throw await toHttpError(res, what);
    return res;
  }

  async createBuild(name: string, definition: unknown): Promise<PlatformBuild> {
    const res = await this.post(this.builder("builds"), { name, definition }, "Build create");
    return parseApiResponse(res, BuildSchema, "COMFY_API_ERROR", "Build create");
  }

  async getBuild(buildId: string): Promise<PlatformBuild> {
    const res = await this.get(this.builder(`builds/${encodeURIComponent(buildId)}`), "Build read");
    return parseApiResponse(res, BuildSchema, "COMFY_API_ERROR", "Build read");
  }

  async updateBuild(
    buildId: string,
    definition: unknown,
    expectedUpdatedAt: string | null,
  ): Promise<PlatformBuild> {
    const res = await sendOnce(
      this.builder(`builds/${encodeURIComponent(buildId)}`),
      {
        method: "PATCH",
        auth: this.auth,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ definition, expectedUpdatedAt }),
      },
      "Build update",
    );
    if (!res.ok) throw await toHttpError(res, "Build update");
    return parseApiResponse(res, BuildSchema, "COMFY_API_ERROR", "Build update");
  }

  /** Idempotent per definition: the builder dedups a release on its definition hash. */
  async createRelease(buildId: string): Promise<string> {
    const what = "Release create";
    const res = await this.post(
      this.builder(`builds/${encodeURIComponent(buildId)}/releases`),
      { targets: [{ os: "linux", gpu: "nvidia" }] },
      what,
    );
    const body = await parseApiResponse(res, CreateReleaseSchema, "COMFY_API_ERROR", what);
    const id = body.releaseId ?? body.buildVersionId;
    if (!id) {
      throw new ComfyApiHttpError("COMFY_API_ERROR", `${what} returned no release id`, {
        status: res.status,
        serverCode: null,
        body: "",
      });
    }
    return id;
  }

  async getRelease(releaseId: string): Promise<PlatformRelease> {
    const res = await this.get(
      this.builder(`releases/${encodeURIComponent(releaseId)}`),
      "Release read",
    );
    return parseApiResponse(res, ReleaseSchema, "COMFY_API_ERROR", "Release read");
  }

  async getReleaseLog(releaseId: string): Promise<string | null> {
    try {
      const res = await this.get(
        this.builder(`releases/${encodeURIComponent(releaseId)}/logs`),
        "Release logs",
      );
      return (
        (await parseApiResponse(res, ReleaseLogsSchema, "COMFY_API_ERROR", "Release logs")).log ??
        null
      );
    } catch {
      return null;
    }
  }

  async createDeployment(
    releaseId: string,
    computeConfig: ComputeConfig,
    idempotencyKey: string,
  ): Promise<PlatformDeployment> {
    const res = await this.post(
      this.deploy("deployments"),
      { releaseId, computeConfig },
      "Deployment create",
      { "Idempotency-Key": idempotencyKey },
    );
    return parseApiResponse(res, DeploymentSchema, "COMFY_API_ERROR", "Deployment create");
  }

  /** The deployment, or null when it is gone or soft-deleted. */
  async getDeployment(deploymentId: string): Promise<PlatformDeployment | null> {
    const res = await sendIdempotent(
      this.deploy(`deployments/${encodeURIComponent(deploymentId)}`),
      {
        auth: this.auth,
      },
    );
    if (res.status === 404) return null;
    if (!res.ok) throw await toHttpError(res, "Deployment read");
    const deployment = await parseApiResponse(
      res,
      DeploymentSchema,
      "COMFY_API_ERROR",
      "Deployment read",
    );
    return deployment.deletedAt ? null : deployment;
  }

  /** Every deployment of the account that is not deleted. The listing returns deleted ones too. */
  async listDeployments(): Promise<PlatformDeployment[]> {
    const out: PlatformDeployment[] = [];
    let after: string | null = null;
    for (let page = 0; page < MAX_DEPLOYMENT_PAGES; page++) {
      const query = after ? `?after=${encodeURIComponent(after)}` : "";
      const res = await this.get(this.deploy(`deployments${query}`), "Deployment list");
      const body = await parseApiResponse(
        res,
        DeploymentPageSchema,
        "COMFY_API_ERROR",
        "Deployment list",
      );
      out.push(...body.deployments.filter((d) => !d.deletedAt));
      if (!body.nextCursor) break;
      after = body.nextCursor;
    }
    return out;
  }

  async updateDeployment(deploymentId: string, computeConfig: ComputeConfig): Promise<void> {
    const what = "Deployment scale";
    const res = await sendOnce(
      this.deploy(`deployments/${encodeURIComponent(deploymentId)}`),
      {
        method: "PATCH",
        auth: this.auth,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ computeConfig }),
      },
      what,
    );
    if (!res.ok) throw await toHttpError(res, what);
  }

  async startDeployment(deploymentId: string): Promise<void> {
    await this.post(
      this.deploy(`deployments/${encodeURIComponent(deploymentId)}/start`),
      undefined,
      "Deployment start",
    );
  }

  async stopDeployment(deploymentId: string): Promise<void> {
    await this.post(
      this.deploy(`deployments/${encodeURIComponent(deploymentId)}/stop`),
      undefined,
      "Deployment stop",
    );
  }

  /** Soft delete; a second one is also accepted. */
  async deleteDeployment(deploymentId: string): Promise<void> {
    const what = "Deployment delete";
    const res = await sendIdempotent(
      this.deploy(`deployments/${encodeURIComponent(deploymentId)}`),
      {
        method: "DELETE",
        auth: this.auth,
      },
    );
    if (res.status === 404) return;
    if (!res.ok) throw await toHttpError(res, what);
  }
}
