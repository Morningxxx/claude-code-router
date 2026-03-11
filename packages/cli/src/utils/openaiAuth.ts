import http from "http";
import { input } from "@inquirer/prompts";
import { readConfigFile } from "./index";

const { OpenAIAuthService } = require("@musistudio/llms") as {
  OpenAIAuthService: new (configService?: any, logger?: any) => any;
};

type JsonConfig = Record<string, any>;

function getConfigAdapter(config: JsonConfig) {
  return {
    get<T = any>(key: string, defaultValue?: T): T | undefined {
      const value = config[key];
      return value !== undefined ? (value as T) : defaultValue;
    },
    getHttpsProxy(): string | undefined {
      return (
        config.HTTPS_PROXY ||
        config.https_proxy ||
        config.httpsProxy ||
        config.PROXY_URL
      );
    },
  };
}

async function createAuthService(): Promise<any> {
  const config = await readConfigFile();
  return new OpenAIAuthService(getConfigAdapter(config));
}

function parseArgs(args: string[]): Record<string, string | boolean> {
  const parsed: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i += 1) {
    const current = args[i];
    if (!current.startsWith("--")) {
      continue;
    }

    const key = current.slice(2);
    const next = args[i + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = true;
      continue;
    }
    parsed[key] = next;
    i += 1;
  }
  return parsed;
}

function tryOpenBrowser(url: string): void {
  const platform = process.platform;
  const { spawn } = require("child_process");

  let command: string | undefined;
  let commandArgs: string[] = [];

  if (platform === "darwin") {
    command = "open";
    commandArgs = [url];
  } else if (platform === "win32") {
    command = "cmd";
    commandArgs = ["/c", "start", "", url];
  } else if (platform === "linux") {
    command = "xdg-open";
    commandArgs = [url];
  }

  if (!command) {
    return;
  }

  const child = spawn(command, commandArgs, {
    detached: true,
    stdio: "ignore",
  });
  child.on("error", () => undefined);
  child.unref();
}

function parseCallbackInput(value: string): { code: string; state?: string } {
  const trimmed = value.trim();
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    const url = new URL(trimmed);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state") || undefined;
    if (!code) {
      throw new Error("The callback URL does not contain an authorization code");
    }
    return { code, state };
  }

  return { code: trimmed };
}

async function waitForCallback(start: {
  redirectUri: string;
  sessionId: string;
  authUrl: string;
  state: string;
}): Promise<{ code: string; state?: string }> {
  const redirect = new URL(start.redirectUri);
  if (redirect.hostname !== "127.0.0.1" && redirect.hostname !== "localhost") {
    const manualInput = await input({
      message: "Paste the callback URL or the authorization code",
    });
    return parseCallbackInput(manualInput);
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      server.close();
      reject(new Error("Timed out waiting for the OpenAI auth callback"));
    }, 120_000);

    const server = http.createServer((req, res) => {
      const url = new URL(req.url || "/", start.redirectUri);
      if (url.pathname !== redirect.pathname) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state") || undefined;
      const error = url.searchParams.get("error");

      if (error) {
        clearTimeout(timer);
        server.close();
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(`OpenAI auth failed: ${error}`);
        reject(new Error(`OpenAI auth failed: ${error}`));
        return;
      }

      if (!code) {
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Missing code");
        return;
      }

      clearTimeout(timer);
      server.close();
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        "<html><body><h2>OpenAI auth completed.</h2><p>You can close this window now.</p></body></html>"
      );
      resolve({ code, state });
    });

    server.on("error", reject);
    server.listen(Number(redirect.port || 80), redirect.hostname, () => {
      console.log(`Waiting for OpenAI auth callback on ${start.redirectUri}`);
    });
  });
}

async function login(profile: string, options: Record<string, string | boolean>) {
  const authService = await createAuthService();
  const start = await authService.createAuthSession(
    profile,
    typeof options["redirect-uri"] === "string"
      ? String(options["redirect-uri"])
      : undefined
  );

  console.log(`Profile: ${profile}`);
  console.log(`OpenAI auth URL:\n${start.authUrl}\n`);

  if (!options["no-browser"]) {
    tryOpenBrowser(start.authUrl);
  }

  let codeResult: { code: string; state?: string };
  if (typeof options.code === "string") {
    codeResult = { code: String(options.code) };
  } else {
    try {
      codeResult = await waitForCallback(start);
    } catch (error: any) {
      console.log(error.message);
      const manualInput = await input({
        message: "Paste the callback URL or the authorization code",
      });
      codeResult = parseCallbackInput(manualInput);
    }
  }

  const profileData = await authService.completeAuthSession(
    start.sessionId,
    codeResult.code,
    codeResult.state
  );

  console.log(`Saved OpenAI auth profile: ${profile}`);
  console.log(`Account ID: ${profileData.account_id || "unknown"}`);
  console.log(`Expires At: ${profileData.expires_at || "unknown"}`);
}

async function listProfiles(): Promise<void> {
  const authService = await createAuthService();
  const profiles = await authService.listProfileStatuses();

  if (!profiles.length) {
    console.log("No OpenAI auth profiles configured.");
    return;
  }

  profiles.forEach((profile) => {
    console.log(
      [
        profile.profile,
        `source=${profile.source}`,
        `account=${profile.account_id || "unknown"}`,
        `expires=${profile.expires_at || "unknown"}`,
        `expired=${profile.is_expired ? "yes" : "no"}`,
      ].join(" ")
    );
  });
}

async function status(profile: string): Promise<void> {
  const authService = await createAuthService();
  const current = await authService.getProfileStatus(profile);

  if (!current) {
    console.log(`OpenAI auth profile not found: ${profile}`);
    process.exit(1);
  }

  console.log(`Profile: ${current.profile}`);
  console.log(`Source: ${current.source}`);
  console.log(`Account ID: ${current.account_id || "unknown"}`);
  console.log(`Expires At: ${current.expires_at || "unknown"}`);
  console.log(`Updated At: ${current.updated_at}`);
  console.log(`Expired: ${current.is_expired ? "yes" : "no"}`);
}

async function logout(profile: string): Promise<void> {
  const authService = await createAuthService();
  const deleted = await authService.deleteProfile(profile);
  if (!deleted) {
    console.log(`OpenAI auth profile not found: ${profile}`);
    return;
  }
  console.log(`Removed OpenAI auth profile: ${profile}`);
}

async function importCodex(profile: string, authFile?: string): Promise<void> {
  const authService = await createAuthService();
  const result = await authService.importCodexAuthFile(profile, authFile);
  console.log(`Imported Codex auth into profile: ${profile}`);
  console.log(`Account ID: ${result.account_id || "unknown"}`);
  console.log(`Expires At: ${result.expires_at || "unknown"}`);
}

export async function handleOpenAIAuthCommand(args: string[]): Promise<void> {
  const subcommand = args[0] || "status";
  const parsed = parseArgs(args.slice(1));
  const profile = typeof parsed.profile === "string" ? String(parsed.profile) : "default";

  switch (subcommand) {
    case "login":
      await login(profile, parsed);
      return;
    case "list":
      await listProfiles();
      return;
    case "status":
      await status(profile);
      return;
    case "logout":
      await logout(profile);
      return;
    case "import-codex":
      await importCodex(
        profile,
        typeof parsed["auth-file"] === "string"
          ? String(parsed["auth-file"])
          : undefined
      );
      return;
    default:
      console.log(
        "Usage: ccr auth openai <login|list|status|logout|import-codex> [--profile <name>] [--redirect-uri <url>] [--no-browser]"
      );
  }
}
