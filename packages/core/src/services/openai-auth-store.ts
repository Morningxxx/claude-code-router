import { promises as fs } from "fs";
import { homedir } from "os";
import { join } from "path";

const AUTH_DIR = join(homedir(), ".claude-code-router", "auth");
const PROFILES_FILE = join(AUTH_DIR, "openai-auth-profiles.json");
const SESSIONS_FILE = join(AUTH_DIR, "openai-auth-sessions.json");
const LOCK_FILE = join(AUTH_DIR, "openai-auth.lock");
const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const LOCK_POLL_INTERVAL_MS = 150;

export interface StoredOpenAIAuthProfile {
  provider: "openai-codex";
  access_token: string;
  refresh_token?: string;
  account_id?: string;
  expires_at?: string;
  updated_at: string;
  source: "oauth" | "codex-file" | "inline";
  auth_file?: string;
}

interface OpenAIAuthProfilesFile {
  profiles: Record<string, StoredOpenAIAuthProfile>;
}

export interface PendingOpenAIAuthSession {
  id: string;
  profile: string;
  state: string;
  code_verifier: string;
  redirect_uri: string;
  created_at: string;
}

interface OpenAIAuthSessionsFile {
  sessions: Record<string, PendingOpenAIAuthSession>;
}

export class OpenAIAuthStore {
  constructor(private readonly logger?: any) {}

  getAuthDir(): string {
    return AUTH_DIR;
  }

  getProfilesFile(): string {
    return PROFILES_FILE;
  }

  getSessionsFile(): string {
    return SESSIONS_FILE;
  }

  async ensureAuthDir(): Promise<void> {
    await fs.mkdir(AUTH_DIR, { recursive: true });
  }

  async withLock<T>(
    callback: () => Promise<T>,
    timeoutMs: number = DEFAULT_LOCK_TIMEOUT_MS
  ): Promise<T> {
    await this.ensureAuthDir();
    const deadline = Date.now() + timeoutMs;

    while (true) {
      try {
        const handle = await fs.open(LOCK_FILE, "wx");

        try {
          await handle.writeFile(
            JSON.stringify({
              pid: process.pid,
              created_at: new Date().toISOString(),
            })
          );
          return await callback();
        } finally {
          await handle.close().catch(() => undefined);
          await fs.unlink(LOCK_FILE).catch(() => undefined);
        }
      } catch (error: any) {
        if (error?.code !== "EEXIST") {
          throw error;
        }

        if (Date.now() >= deadline) {
          throw new Error("Timed out waiting for OpenAI auth lock");
        }

        await new Promise((resolve) =>
          setTimeout(resolve, LOCK_POLL_INTERVAL_MS)
        );
      }
    }
  }

  async listProfiles(): Promise<Record<string, StoredOpenAIAuthProfile>> {
    const data = await this.readProfilesFile();
    return { ...data.profiles };
  }

  async getProfile(
    profile: string
  ): Promise<StoredOpenAIAuthProfile | undefined> {
    const profiles = await this.listProfiles();
    return profiles[profile];
  }

  async saveProfile(
    profile: string,
    data: StoredOpenAIAuthProfile,
    options: { skipLock?: boolean } = {}
  ): Promise<void> {
    const write = async () => {
      const file = await this.readProfilesFile();
      file.profiles[profile] = data;
      await this.writeJson(PROFILES_FILE, file);
    };

    if (options.skipLock) {
      await write();
      return;
    }

    await this.withLock(write);
  }

  async deleteProfile(
    profile: string,
    options: { skipLock?: boolean } = {}
  ): Promise<boolean> {
    const remove = async () => {
      const file = await this.readProfilesFile();
      if (!file.profiles[profile]) {
        return false;
      }
      delete file.profiles[profile];
      await this.writeJson(PROFILES_FILE, file);
      return true;
    };

    if (options.skipLock) {
      return remove();
    }

    return this.withLock(remove);
  }

  async listPendingSessions(): Promise<Record<string, PendingOpenAIAuthSession>> {
    const data = await this.readSessionsFile();
    return { ...data.sessions };
  }

  async createPendingSession(
    session: PendingOpenAIAuthSession,
    options: { skipLock?: boolean } = {}
  ): Promise<void> {
    const write = async () => {
      const data = await this.readSessionsFile();
      data.sessions[session.id] = session;
      await this.writeJson(SESSIONS_FILE, data);
    };

    if (options.skipLock) {
      await write();
      return;
    }

    await this.withLock(write);
  }

  async getPendingSession(
    sessionId: string
  ): Promise<PendingOpenAIAuthSession | undefined> {
    const data = await this.readSessionsFile();
    return data.sessions[sessionId];
  }

  async deletePendingSession(
    sessionId: string,
    options: { skipLock?: boolean } = {}
  ): Promise<void> {
    const remove = async () => {
      const data = await this.readSessionsFile();
      delete data.sessions[sessionId];
      await this.writeJson(SESSIONS_FILE, data);
    };

    if (options.skipLock) {
      await remove();
      return;
    }

    await this.withLock(remove);
  }

  private async readProfilesFile(): Promise<OpenAIAuthProfilesFile> {
    return this.readJson(PROFILES_FILE, { profiles: {} });
  }

  private async readSessionsFile(): Promise<OpenAIAuthSessionsFile> {
    return this.readJson(SESSIONS_FILE, { sessions: {} });
  }

  private async readJson<T>(filePath: string, fallback: T): Promise<T> {
    await this.ensureAuthDir();
    try {
      const content = await fs.readFile(filePath, "utf-8");
      return JSON.parse(content) as T;
    } catch (error: any) {
      if (error?.code === "ENOENT") {
        return fallback;
      }
      this.logger?.warn?.(
        { error, filePath },
        "Failed to read OpenAI auth JSON file"
      );
      throw error;
    }
  }

  private async writeJson(filePath: string, data: unknown): Promise<void> {
    await this.ensureAuthDir();
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
  }
}
