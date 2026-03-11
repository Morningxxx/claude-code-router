import { promises as fs } from "fs";
import { homedir } from "os";
import { resolve } from "path";
import { LLMProvider, UnifiedChatRequest } from "@/types/llm";
import { Transformer, TransformerOptions } from "@/types/transformer";

const DEFAULT_CODEX_AUTH_FILE = "~/.codex/auth.json";
const DEFAULT_CHATGPT_BASE_URL = "https://chatgpt.com/backend-api";
const DEFAULT_ORIGINATOR = "codex_cli_rs";
const DEFAULT_USER_AGENT = "codex-cli";
const REFRESH_TOKEN_URL = "https://auth.openai.com/oauth/token";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const DEFAULT_REFRESH_INTERVAL_DAYS = 8;
const DEFAULT_REFRESH_SKEW_SECONDS = 300;

interface OpenAICodexTransformerOptions extends TransformerOptions {
  access_token?: string;
  refresh_token?: string;
  account_id?: string;
  auth_file?: string;
  originator?: string;
  user_agent?: string;
  chatgpt_base_url?: string;
  refresh_interval_days?: number;
  refresh_before_expiry_seconds?: number;
}

interface OpenAICodexAuthFile {
  tokens?: {
    access_token?: string;
    refresh_token?: string;
    account_id?: string;
  };
  last_refresh?: string;
}

interface ResolvedCodexAuth {
  accessToken: string;
  refreshToken?: string;
  accountId?: string;
  authFilePath?: string;
  authFileData?: OpenAICodexAuthFile;
}

export class OpenAICodexTransformer implements Transformer {
  name = "openai-codex";

  constructor(private readonly options: OpenAICodexTransformerOptions = {}) {}

  async transformRequestIn(
    request: UnifiedChatRequest,
    provider: LLMProvider
  ): Promise<Record<string, any>> {
    const auth = await this.resolveAuth();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${auth.accessToken}`,
      originator: this.options.originator || DEFAULT_ORIGINATOR,
      "User-Agent": this.options.user_agent || DEFAULT_USER_AGENT,
    };

    if (auth.accountId) {
      headers["ChatGPT-Account-Id"] = auth.accountId;
    }

    return {
      body: request,
      config: {
        headers,
        url: this.normalizeResponsesUrl(provider.baseUrl),
      },
    };
  }

  private async resolveAuth(): Promise<ResolvedCodexAuth> {
    const authFromFile = await this.loadAuthFromFile();
    const resolved: ResolvedCodexAuth = {
      accessToken:
        this.options.access_token || authFromFile?.data.tokens?.access_token || "",
      refreshToken:
        this.options.refresh_token || authFromFile?.data.tokens?.refresh_token,
      accountId: this.options.account_id || authFromFile?.data.tokens?.account_id,
      authFilePath: authFromFile?.path,
      authFileData: authFromFile?.data,
    };

    if (!resolved.accessToken) {
      throw new Error(
        "openai-codex transformer could not find an access token. Set transformer.options.access_token or ensure ~/.codex/auth.json exists."
      );
    }

    if (this.shouldRefreshToken(resolved, authFromFile?.data)) {
      const refreshed = await this.refreshAccessToken(resolved.refreshToken!);
      resolved.accessToken = refreshed.access_token || resolved.accessToken;
      resolved.refreshToken = refreshed.refresh_token || resolved.refreshToken;

      if (resolved.authFilePath && resolved.authFileData?.tokens) {
        resolved.authFileData.tokens.access_token = resolved.accessToken;
        resolved.authFileData.tokens.refresh_token = resolved.refreshToken;
        resolved.authFileData.last_refresh = new Date().toISOString();
        await fs.writeFile(
          resolved.authFilePath,
          JSON.stringify(resolved.authFileData, null, 2),
          "utf-8"
        );
      }
    }

    return resolved;
  }

  private async loadAuthFromFile(): Promise<
    | {
        path: string;
        data: OpenAICodexAuthFile;
      }
    | undefined
  > {
    const authFilePath = this.expandHome(
      this.options.auth_file || DEFAULT_CODEX_AUTH_FILE
    );

    try {
      const content = await fs.readFile(authFilePath, "utf-8");
      return {
        path: authFilePath,
        data: JSON.parse(content) as OpenAICodexAuthFile,
      };
    } catch (error: any) {
      if (error?.code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  }

  private shouldRefreshToken(
    auth: ResolvedCodexAuth,
    authFileData?: OpenAICodexAuthFile
  ): boolean {
    if (!auth.refreshToken) {
      return false;
    }

    const skewSeconds =
      this.options.refresh_before_expiry_seconds ?? DEFAULT_REFRESH_SKEW_SECONDS;
    const tokenExpiry = this.parseJwtExpiry(auth.accessToken);
    if (tokenExpiry && tokenExpiry - skewSeconds <= Math.floor(Date.now() / 1000)) {
      return true;
    }

    const refreshIntervalDays =
      this.options.refresh_interval_days ?? DEFAULT_REFRESH_INTERVAL_DAYS;
    const lastRefresh = authFileData?.last_refresh
      ? Date.parse(authFileData.last_refresh)
      : NaN;

    return (
      Number.isFinite(lastRefresh) &&
      Date.now() - lastRefresh >= refreshIntervalDays * 24 * 60 * 60 * 1000
    );
  }

  private async refreshAccessToken(refreshToken: string): Promise<{
    access_token?: string;
    refresh_token?: string;
  }> {
    const response = await fetch(REFRESH_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    });

    if (!response.ok) {
      throw new Error(
        `openai-codex token refresh failed with status ${response.status}: ${await response.text()}`
      );
    }

    return (await response.json()) as {
      access_token?: string;
      refresh_token?: string;
    };
  }

  private normalizeResponsesUrl(baseUrl: string): string {
    const configuredBase = (baseUrl || this.options.chatgpt_base_url || "").trim();
    const defaultBase = this.options.chatgpt_base_url || DEFAULT_CHATGPT_BASE_URL;
    let normalized = configuredBase || defaultBase;

    while (normalized.endsWith("/")) {
      normalized = normalized.slice(0, -1);
    }

    if (normalized.endsWith("/codex/responses")) {
      return normalized;
    }

    if (normalized.endsWith("/backend-api")) {
      return `${normalized}/codex/responses`;
    }

    if (
      normalized.startsWith("https://chatgpt.com") ||
      normalized.startsWith("https://chat.openai.com")
    ) {
      if (!normalized.includes("/backend-api")) {
        return `${normalized}/backend-api/codex/responses`;
      }
      return `${normalized}/codex/responses`;
    }

    return normalized;
  }

  private expandHome(filePath: string): string {
    if (filePath === "~") {
      return homedir();
    }
    if (filePath.startsWith("~/")) {
      return resolve(homedir(), filePath.slice(2));
    }
    return resolve(filePath);
  }

  private parseJwtExpiry(token: string): number | null {
    try {
      const [, payload] = token.split(".");
      if (!payload) {
        return null;
      }
      const json = JSON.parse(
        Buffer.from(this.base64UrlToBase64(payload), "base64").toString("utf-8")
      );
      return typeof json.exp === "number" ? json.exp : null;
    } catch {
      return null;
    }
  }

  private base64UrlToBase64(value: string): string {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padding = normalized.length % 4;
    return padding === 0 ? normalized : normalized + "=".repeat(4 - padding);
  }
}
