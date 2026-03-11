import { promises as fs } from "fs";
import { randomBytes, createHash, randomUUID } from "crypto";
import { homedir } from "os";
import { join, resolve } from "path";
import { ProxyAgent, fetch } from "undici";
import { ConfigService } from "./config";
import {
  OpenAIAuthStore,
  PendingOpenAIAuthSession,
  StoredOpenAIAuthProfile,
} from "./openai-auth-store";

const DEFAULT_CODEX_AUTH_FILE = "~/.codex/auth.json";
const AUTH_AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const AUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const DEFAULT_REDIRECT_URI = "http://127.0.0.1:1455/auth/callback";
const DEFAULT_REFRESH_SKEW_SECONDS = 300;

export interface OpenAIAuthRuntimeRecord {
  accessToken: string;
  refreshToken?: string;
  accountId?: string;
  expiresAt?: string;
  source: "inline" | "ccr-managed" | "codex-file";
  profile?: string;
  authFile?: string;
}

export interface ResolveOpenAIAuthOptions {
  access_token?: string;
  refresh_token?: string;
  account_id?: string;
  profile?: string;
  auth_strategy?: "codex-file" | "ccr-managed";
  auth_file?: string;
  use_codex_file_fallback?: boolean;
  refresh_before_expiry_seconds?: number;
}

interface OAuthTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  id_token?: string;
}

interface CodexAuthFile {
  tokens?: {
    access_token?: string;
    refresh_token?: string;
    account_id?: string;
  };
  last_refresh?: string;
}

export interface OpenAIProfileStatus {
  profile: string;
  account_id?: string;
  expires_at?: string;
  updated_at: string;
  source: string;
  is_expired: boolean;
}

export interface OpenAIAuthSessionStart {
  sessionId: string;
  profile: string;
  redirectUri: string;
  authUrl: string;
  state: string;
}

export class OpenAIAuthService {
  private readonly store: OpenAIAuthStore;

  constructor(
    private readonly configService?: Pick<ConfigService, "get" | "getHttpsProxy">,
    private readonly logger?: any
  ) {
    this.store = new OpenAIAuthStore(logger);
  }

  getStore(): OpenAIAuthStore {
    return this.store;
  }

  async listProfileStatuses(): Promise<OpenAIProfileStatus[]> {
    const profiles = await this.store.listProfiles();
    return Object.entries(profiles)
      .map(([profile, data]) => ({
        profile,
        account_id: data.account_id,
        expires_at: data.expires_at,
        updated_at: data.updated_at,
        source: data.source,
        is_expired: this.isExpired(data.expires_at),
      }))
      .sort((a, b) => a.profile.localeCompare(b.profile));
  }

  async getProfileStatus(
    profile: string
  ): Promise<OpenAIProfileStatus | undefined> {
    const data = await this.store.getProfile(profile);
    if (!data) {
      return undefined;
    }

    return {
      profile,
      account_id: data.account_id,
      expires_at: data.expires_at,
      updated_at: data.updated_at,
      source: data.source,
      is_expired: this.isExpired(data.expires_at),
    };
  }

  async deleteProfile(profile: string): Promise<boolean> {
    return this.store.deleteProfile(profile);
  }

  async createAuthSession(
    profile: string = "default",
    redirectUri?: string
  ): Promise<OpenAIAuthSessionStart> {
    const codeVerifier = this.base64UrlEncode(randomBytes(32));
    const state = this.base64UrlEncode(randomBytes(24));
    const sessionId = randomUUID();
    const targetRedirectUri = redirectUri || DEFAULT_REDIRECT_URI;
    const session: PendingOpenAIAuthSession = {
      id: sessionId,
      profile,
      state,
      code_verifier: codeVerifier,
      redirect_uri: targetRedirectUri,
      created_at: new Date().toISOString(),
    };

    await this.store.createPendingSession(session);

    return {
      sessionId,
      profile,
      redirectUri: targetRedirectUri,
      state,
      authUrl: this.buildAuthorizeUrl(targetRedirectUri, state, codeVerifier),
    };
  }

  async completeAuthSession(
    sessionId: string,
    code: string,
    state?: string
  ): Promise<StoredOpenAIAuthProfile> {
    const session = await this.store.getPendingSession(sessionId);
    if (!session) {
      throw new Error("OpenAI auth session not found or expired");
    }

    if (state && session.state !== state) {
      throw new Error("OpenAI auth state mismatch");
    }

    try {
      const token = await this.exchangeCodeForToken(
        code,
        session.code_verifier,
        session.redirect_uri
      );
      const profile = this.buildStoredProfile(token, "oauth");
      await this.store.saveProfile(session.profile, profile);
      return profile;
    } finally {
      await this.store.deletePendingSession(sessionId).catch(() => undefined);
    }
  }

  async exchangeCodeDirect(params: {
    code: string;
    codeVerifier: string;
    redirectUri?: string;
    profile?: string;
  }): Promise<StoredOpenAIAuthProfile> {
    const token = await this.exchangeCodeForToken(
      params.code,
      params.codeVerifier,
      params.redirectUri || DEFAULT_REDIRECT_URI
    );
    const profile = this.buildStoredProfile(token, "oauth");
    await this.store.saveProfile(params.profile || "default", profile);
    return profile;
  }

  async resolveAuth(
    options: ResolveOpenAIAuthOptions = {}
  ): Promise<OpenAIAuthRuntimeRecord> {
    const strategy = options.auth_strategy || this.getDefaultAuthStrategy(options);
    const allowCodexFallback =
      options.use_codex_file_fallback ??
      this.configService?.get<boolean>("OPENAI_AUTH_USE_CODEX_FILE_FALLBACK", true) ??
      true;
    const skewSeconds =
      options.refresh_before_expiry_seconds ??
      this.configService?.get<number>(
        "OPENAI_AUTH_REFRESH_SKEW_SECONDS",
        DEFAULT_REFRESH_SKEW_SECONDS
      ) ??
      DEFAULT_REFRESH_SKEW_SECONDS;

    let record: OpenAIAuthRuntimeRecord | undefined;

    if (options.access_token) {
      record = {
        accessToken: options.access_token,
        refreshToken: options.refresh_token,
        accountId:
          options.account_id || this.extractAccountId(options.access_token),
        expiresAt: this.extractExpiryIso(options.access_token),
        source: "inline",
        profile: options.profile,
      };
    } else if (strategy === "ccr-managed") {
      const profileName = options.profile || this.getDefaultProfile();
      const profile = await this.store.getProfile(profileName);
      if (profile) {
        record = this.runtimeFromStoredProfile(profileName, profile);
      } else if (allowCodexFallback) {
        record = await this.loadCodexFileRecord(options.auth_file);
      }
    } else {
      record = await this.loadCodexFileRecord(options.auth_file);
    }

    if (!record?.accessToken) {
      throw new Error(
        "openai-codex transformer could not find usable auth. Configure ccr auth openai login, set transformer.options.access_token, or ensure ~/.codex/auth.json exists."
      );
    }

    if (this.shouldRefresh(record, skewSeconds)) {
      return this.refreshRuntimeRecord(record);
    }

    return record;
  }

  async refreshRuntimeRecord(
    record: OpenAIAuthRuntimeRecord
  ): Promise<OpenAIAuthRuntimeRecord> {
    if (!record.refreshToken) {
      return record;
    }

    if (record.source === "ccr-managed" && record.profile) {
      return this.store.withLock(async () => {
        const current = await this.store.getProfile(record.profile!);
        const runtime = current
          ? this.runtimeFromStoredProfile(record.profile!, current)
          : record;
        if (!this.shouldRefresh(runtime, DEFAULT_REFRESH_SKEW_SECONDS)) {
          return runtime;
        }
        const refreshed = await this.refreshTokenPair(runtime.refreshToken!);
        const profile = this.buildStoredProfile(
          refreshed,
          "oauth",
          current?.account_id || runtime.accountId
        );
        await this.store.saveProfile(record.profile!, profile, { skipLock: true });
        return this.runtimeFromStoredProfile(record.profile!, profile);
      });
    }

    if (record.source === "codex-file" && record.authFile) {
      const authFile = record.authFile;
      const lockTimeout =
        this.configService?.get<number>(
          "OPENAI_AUTH_LOCK_TIMEOUT_MS",
          10_000
        ) ?? 10_000;
      return this.store.withLock(async () => {
        const latest = await this.loadCodexFileRecord(authFile);
        if (latest && !this.shouldRefresh(latest, DEFAULT_REFRESH_SKEW_SECONDS)) {
          return latest;
        }
        const refreshed = await this.refreshTokenPair(
          (latest || record).refreshToken!
        );
        const nextAccessToken =
          refreshed.access_token || (latest || record).accessToken;
        const nextRefreshToken =
          refreshed.refresh_token || (latest || record).refreshToken;
        const fileData = await this.readCodexAuthFile(authFile);
        const nextAccountId =
          this.extractAccountId(nextAccessToken) ||
          fileData?.tokens?.account_id ||
          record.accountId;
        const nextFile: CodexAuthFile = {
          ...(fileData || {}),
          tokens: {
            ...(fileData?.tokens || {}),
            access_token: nextAccessToken,
            refresh_token: nextRefreshToken,
            account_id: nextAccountId,
          },
          last_refresh: new Date().toISOString(),
        };
        await fs.writeFile(authFile, JSON.stringify(nextFile, null, 2), "utf-8");
        return {
          accessToken: nextAccessToken,
          refreshToken: nextRefreshToken,
          accountId: nextAccountId,
          expiresAt: this.extractExpiryIso(nextAccessToken),
          source: "codex-file",
          authFile,
        };
      }, lockTimeout);
    }

    const refreshed = await this.refreshTokenPair(record.refreshToken);
    const nextAccessToken = refreshed.access_token || record.accessToken;
    return {
      ...record,
      accessToken: nextAccessToken,
      refreshToken: refreshed.refresh_token || record.refreshToken,
      accountId: this.extractAccountId(nextAccessToken) || record.accountId,
      expiresAt: this.extractExpiryIso(nextAccessToken),
    };
  }

  async importCodexAuthFile(
    profile: string = "default",
    authFile?: string
  ): Promise<StoredOpenAIAuthProfile> {
    const resolved = await this.loadCodexFileRecord(authFile);
    if (!resolved) {
      throw new Error("No Codex auth file found to import");
    }
    const stored: StoredOpenAIAuthProfile = {
      provider: "openai-codex",
      access_token: resolved.accessToken,
      refresh_token: resolved.refreshToken,
      account_id: resolved.accountId,
      expires_at: resolved.expiresAt,
      updated_at: new Date().toISOString(),
      source: "codex-file",
      auth_file: resolved.authFile,
    };
    await this.store.saveProfile(profile, stored);
    return stored;
  }

  private getDefaultAuthStrategy(options: ResolveOpenAIAuthOptions): "ccr-managed" | "codex-file" {
    if (options.profile) {
      return "ccr-managed";
    }
    return (
      this.configService?.get<"ccr-managed" | "codex-file">(
        "OPENAI_AUTH_STRATEGY",
        "codex-file"
      ) || "codex-file"
    );
  }

  private getDefaultProfile(): string {
    return (
      this.configService?.get<string>("OPENAI_AUTH_PROFILE", "default") ||
      "default"
    );
  }

  private async loadCodexFileRecord(
    authFile?: string
  ): Promise<OpenAIAuthRuntimeRecord | undefined> {
    const filePath = this.resolveHome(
      authFile ||
        this.configService?.get<string>("OPENAI_AUTH_FILE") ||
        DEFAULT_CODEX_AUTH_FILE
    );
    const data = await this.readCodexAuthFile(filePath);
    if (!data?.tokens?.access_token) {
      return undefined;
    }
    return {
      accessToken: data.tokens.access_token,
      refreshToken: data.tokens.refresh_token,
      accountId:
        data.tokens.account_id ||
        this.extractAccountId(data.tokens.access_token),
      expiresAt: this.extractExpiryIso(data.tokens.access_token),
      source: "codex-file",
      authFile: filePath,
    };
  }

  private async readCodexAuthFile(
    filePath: string
  ): Promise<CodexAuthFile | undefined> {
    try {
      const content = await fs.readFile(filePath, "utf-8");
      return JSON.parse(content) as CodexAuthFile;
    } catch (error: any) {
      if (error?.code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  }

  private runtimeFromStoredProfile(
    profile: string,
    profileData: StoredOpenAIAuthProfile
  ): OpenAIAuthRuntimeRecord {
    return {
      accessToken: profileData.access_token,
      refreshToken: profileData.refresh_token,
      accountId: profileData.account_id,
      expiresAt: profileData.expires_at,
      source: "ccr-managed",
      profile,
    };
  }

  private async refreshTokenPair(
    refreshToken: string
  ): Promise<OAuthTokenResponse> {
    const dispatcher = this.createProxyDispatcher();
    const response = await fetch(AUTH_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
      ...(dispatcher ? { dispatcher } : {}),
    });

    if (!response.ok) {
      throw new Error(
        `openai-codex token refresh failed with status ${response.status}: ${await response.text()}`
      );
    }

    return (await response.json()) as OAuthTokenResponse;
  }

  private async exchangeCodeForToken(
    code: string,
    codeVerifier: string,
    redirectUri: string
  ): Promise<OAuthTokenResponse> {
    const dispatcher = this.createProxyDispatcher();
    const response = await fetch(AUTH_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        grant_type: "authorization_code",
        code,
        code_verifier: codeVerifier,
        redirect_uri: redirectUri,
      }),
      ...(dispatcher ? { dispatcher } : {}),
    });

    if (!response.ok) {
      throw new Error(
        `OpenAI auth token exchange failed with status ${response.status}: ${await response.text()}`
      );
    }

    return (await response.json()) as OAuthTokenResponse;
  }

  private buildStoredProfile(
    token: OAuthTokenResponse,
    source: StoredOpenAIAuthProfile["source"],
    fallbackAccountId?: string
  ): StoredOpenAIAuthProfile {
    const accessToken = token.access_token || "";
    const expiresAt = token.expires_in
      ? new Date(Date.now() + token.expires_in * 1000).toISOString()
      : this.extractExpiryIso(accessToken);
    return {
      provider: "openai-codex",
      access_token: accessToken,
      refresh_token: token.refresh_token,
      account_id:
        this.extractAccountId(accessToken) ||
        this.extractAccountId(token.id_token || "") ||
        fallbackAccountId,
      expires_at: expiresAt,
      updated_at: new Date().toISOString(),
      source,
    };
  }

  private buildAuthorizeUrl(
    redirectUri: string,
    state: string,
    codeVerifier: string
  ): string {
    const url = new URL(AUTH_AUTHORIZE_URL);
    url.searchParams.set("client_id", CLIENT_ID);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("scope", "openid profile email offline_access");
    url.searchParams.set("code_challenge", this.createCodeChallenge(codeVerifier));
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", state);
    return url.toString();
  }

  private createCodeChallenge(codeVerifier: string): string {
    return this.base64UrlEncode(
      createHash("sha256").update(codeVerifier).digest()
    );
  }

  private base64UrlEncode(value: Buffer): string {
    return value
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
  }

  private shouldRefresh(
    record: OpenAIAuthRuntimeRecord,
    skewSeconds: number
  ): boolean {
    if (!record.refreshToken) {
      return false;
    }
    const expiresAt =
      record.expiresAt ||
      this.extractExpiryIso(record.accessToken);
    if (!expiresAt) {
      return false;
    }
    return Date.parse(expiresAt) - skewSeconds * 1000 <= Date.now();
  }

  private isExpired(expiresAt?: string): boolean {
    return !!expiresAt && Date.parse(expiresAt) <= Date.now();
  }

  private extractExpiryIso(token?: string): string | undefined {
    const exp = this.parseJwtExpiry(token);
    return exp ? new Date(exp * 1000).toISOString() : undefined;
  }

  private extractAccountId(token?: string): string | undefined {
    if (!token) {
      return undefined;
    }
    try {
      const payload = this.parseJwtPayload(token);
      const authData = payload?.["https://api.openai.com/auth"];
      return (
        authData?.chatgpt_account_id ||
        authData?.chatgpt_accountId ||
        payload?.account_id
      );
    } catch {
      return undefined;
    }
  }

  private parseJwtExpiry(token?: string): number | null {
    try {
      const payload = this.parseJwtPayload(token);
      return typeof payload?.exp === "number" ? payload.exp : null;
    } catch {
      return null;
    }
  }

  private parseJwtPayload(token?: string): any {
    const [, payload] = (token || "").split(".");
    if (!payload) {
      return null;
    }
    return JSON.parse(
      Buffer.from(this.base64UrlToBase64(payload), "base64").toString("utf-8")
    );
  }

  private base64UrlToBase64(value: string): string {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padding = normalized.length % 4;
    return padding === 0 ? normalized : normalized + "=".repeat(4 - padding);
  }

  private createProxyDispatcher(): ProxyAgent | undefined {
    const proxy =
      this.configService?.getHttpsProxy?.() ||
      this.configService?.get<string>("PROXY_URL");
    if (!proxy) {
      return undefined;
    }
    return new ProxyAgent(new URL(proxy).toString());
  }

  private resolveHome(filePath: string): string {
    if (filePath === "~") {
      return homedir();
    }
    if (filePath.startsWith("~/")) {
      return join(homedir(), filePath.slice(2));
    }
    return resolve(filePath);
  }
}
