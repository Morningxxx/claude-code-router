import { LLMProvider, UnifiedChatRequest } from "@/types/llm";
import { Transformer, TransformerOptions } from "@/types/transformer";
import { ConfigService } from "@/services/config";
import { OpenAIAuthService } from "@/services/openai-auth";
import { homedir } from "os";
import { join } from "path";

const DEFAULT_CHATGPT_BASE_URL = "https://chatgpt.com/backend-api";
const DEFAULT_ORIGINATOR = "codex_cli_rs";
const DEFAULT_USER_AGENT = "codex-cli";

interface OpenAICodexTransformerOptions extends TransformerOptions {
  access_token?: string;
  refresh_token?: string;
  account_id?: string;
  profile?: string;
  auth_strategy?: "codex-file" | "ccr-managed";
  auth_file?: string;
  originator?: string;
  user_agent?: string;
  chatgpt_base_url?: string;
  refresh_before_expiry_seconds?: number;
  use_codex_file_fallback?: boolean;
}

export class OpenAICodexTransformer implements Transformer {
  static TransformerName = "openai-codex";
  name = "openai-codex";
  private authService?: OpenAIAuthService;

  constructor(private readonly options: OpenAICodexTransformerOptions = {}) {}

  async transformRequestIn(
    request: UnifiedChatRequest,
    provider: LLMProvider
  ): Promise<Record<string, any>> {
    request.stream = true;

    const auth = await this.getAuthService().resolveAuth({
      access_token: this.options.access_token,
      refresh_token: this.options.refresh_token,
      account_id: this.options.account_id,
      profile: this.options.profile,
      auth_strategy: this.options.auth_strategy,
      auth_file: this.options.auth_file,
      use_codex_file_fallback: this.options.use_codex_file_fallback,
      refresh_before_expiry_seconds:
        this.options.refresh_before_expiry_seconds,
    });
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

  private getAuthService(): OpenAIAuthService {
    if (!this.authService) {
      const logger = this.logger;
      const configService = new ConfigService({
        jsonPath: join(homedir(), ".claude-code-router", "config.json"),
        useJsonFile: true,
        useEnvironmentVariables: false,
      });
      this.authService = new OpenAIAuthService(configService, logger);
    }
    return this.authService;
  }
}
