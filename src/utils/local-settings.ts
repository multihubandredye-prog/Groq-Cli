import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

interface Config {
  groqApiKey?: string;
  groqApiKeys?: string[];
  defaultModel?: string;
  groqProxy?: string;
}

const CONFIG_DIR = '.groq'; // In home directory
const CONFIG_FILE = 'local-settings.json';

export class ConfigManager {
  private configPath: string;

  constructor() {
    const homeDir = os.homedir();
    this.configPath = path.join(homeDir, CONFIG_DIR, CONFIG_FILE);
  }

  private ensureConfigDir(): void {
    const configDir = path.dirname(this.configPath);
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
  }

  private readConfig(): Config {
    try {
      if (!fs.existsSync(this.configPath)) {
        return {};
      }
      const configData = fs.readFileSync(this.configPath, 'utf8');
      return JSON.parse(configData);
    } catch (error) {
      console.warn('Failed to read config file:', error);
      return {};
    }
  }

  private writeConfig(config: Config): void {
    this.ensureConfigDir();
    fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2), {
      mode: 0o600
    });
    try {
      fs.chmodSync(this.configPath, 0o600);
    } catch {
      // noop
    }
  }

  public getApiKey(): string | null {
    const config = this.readConfig();
    if (config.groqApiKey) return config.groqApiKey;
    if (Array.isArray(config.groqApiKeys) && config.groqApiKeys.length > 0) {
      return config.groqApiKeys[0];
    }
    return null;
  }

  /**
   * Retorna todas as chaves cadastradas (para auto-rotação em caso de limite de cota!).
   */
  public getApiKeys(): string[] {
    const config = this.readConfig();
    const set = new Set<string>();
    if (process.env.GROQ_API_KEY?.trim()) {
      set.add(process.env.GROQ_API_KEY.trim());
    }
    if (config.groqApiKey?.trim()) {
      set.add(config.groqApiKey.trim());
    }
    if (Array.isArray(config.groqApiKeys)) {
      for (const k of config.groqApiKeys) {
        if (typeof k === 'string' && k.trim()) set.add(k.trim());
      }
    }
    return [...set];
  }

  public setApiKey(apiKeyInput: string): void {
    try {
      const config = this.readConfig();
      // Permite colar uma chave ou várias separadas por vírgula/espaço!
      const incoming = apiKeyInput
        .split(/[\s,;]+/)
        .map(s => s.trim())
        .filter(Boolean);
      if (incoming.length === 0) {
        throw new Error('Empty API key');
      }

      const existing = Array.isArray(config.groqApiKeys) ? config.groqApiKeys : [];
      if (config.groqApiKey && !existing.includes(config.groqApiKey)) {
        existing.unshift(config.groqApiKey);
      }

      const merged = [...incoming, ...existing.filter(k => !incoming.includes(k))];
      config.groqApiKey = merged[0];
      config.groqApiKeys = merged;
      this.writeConfig(config);
    } catch (error) {
      throw new Error(`Failed to save API key: ${error}`);
    }
  }

  public clearApiKey(): void {
    try {
      const config = this.readConfig();
      delete config.groqApiKey;
      delete config.groqApiKeys;

      if (Object.keys(config).length === 0) {
        if (fs.existsSync(this.configPath)) {
          fs.unlinkSync(this.configPath);
        }
      } else {
        this.writeConfig(config);
      }
    } catch (error) {
      console.warn('Failed to clear API key:', error);
    }
  }

  public getDefaultModel(): string | null {
    const config = this.readConfig();
    return config.defaultModel || null;
  }

  public setDefaultModel(model: string): void {
    try {
      const config = this.readConfig();
      config.defaultModel = model;
      this.writeConfig(config);
    } catch (error) {
      throw new Error(`Failed to save default model: ${error}`);
    }
  }

  public getProxy(): string | null {
    const config = this.readConfig();
    return config.groqProxy || null;
  }

  public setProxy(proxy: string): void {
    try {
      const trimmed = proxy?.trim?.() ?? '';
      if (!trimmed) {
        throw new Error('Proxy must be a non-empty string');
      }
      
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(trimmed);
      } catch {
        throw new Error(`Invalid proxy URL: ${trimmed}`);
      }
      
      const allowedProtocols = new Set(['http:', 'https:', 'socks:', 'socks4:', 'socks5:']);
      if (!allowedProtocols.has(parsedUrl.protocol)) {
        throw new Error(`Unsupported proxy protocol: ${parsedUrl.protocol}`);
      }
      
      const config = this.readConfig();
      config.groqProxy = trimmed;
      this.writeConfig(config);
    } catch (error) {
      throw new Error(`Failed to save proxy: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  public clearProxy(): void {
    try {
      const config = this.readConfig();
      delete config.groqProxy;

      if (Object.keys(config).length === 0) {
        if (fs.existsSync(this.configPath)) {
          fs.unlinkSync(this.configPath);
        }
      } else {
        this.writeConfig(config);
      }
    } catch (error) {
      console.warn('Failed to clear proxy:', error);
    }
  }
}
