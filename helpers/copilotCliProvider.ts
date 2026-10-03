import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export type CopilotCliHealth = {
  status: 'CONNECTED' | 'OFFLINE' | 'ERROR';
  version?: string;
  error?: string;
};

export class CopilotCliProvider {
  readonly name = 'GitHub Copilot CLI';
  private readonly cwd: string;
  private readonly timeoutMs: number;

  constructor(options: { cwd?: string; timeoutMs?: number } = {}) {
    const localData = process.env.LOCALAPPDATA || process.cwd();
    this.cwd = options.cwd || join(localData, 'NexusAI', 'copilot-runtime');
    this.timeoutMs = options.timeoutMs ?? 120000;
  }

  private async ensureCwd() {
    await mkdir(this.cwd, { recursive: true });
  }

  private run(args: string[], timeoutMs = this.timeoutMs): Promise<{ stdout: string; stderr: string }> {
    return new Promise(async (resolve, reject) => {
      await this.ensureCwd();
      const finish = (error: Error | null, stdout: string, stderr: string) => {
        if (error) reject(new Error((stderr || error.message || 'Copilot CLI failed').trim()));
        else resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
      };

      if (process.platform === 'win32') {
        const encodedArgs = Buffer.from(JSON.stringify(args), 'utf8').toString('base64');
        const script = [
          "$ErrorActionPreference='Stop'",
          `$a=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedArgs}')) | ConvertFrom-Json`,
          '& copilot.cmd @a',
          'if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }',
        ].join('; ');
        const child=execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
          cwd: this.cwd,
          timeout: timeoutMs,
          windowsHide: true,
          maxBuffer: 4 * 1024 * 1024,
        }, finish);
        child.stdin?.end();
        return;
      }

      const child=execFile('copilot', args, {
        cwd: this.cwd,
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
      }, finish);
      child.stdin?.end();
    });
  }

  async checkHealth(): Promise<CopilotCliHealth> {
    try {
      const result = await this.run(['--version'], 10000);
      return { status: 'CONNECTED', version: result.stdout || result.stderr || 'installed' };
    } catch (error) {
      return { status: 'OFFLINE', error: error instanceof Error ? error.message : 'Copilot CLI unavailable' };
    }
  }

  async generate(prompt: string): Promise<string> {
    const normalized = prompt.trim();
    if (!normalized) throw new Error('Prompt is required');
    if (normalized.length > 60000) throw new Error('Prompt is too large for Copilot CLI bridge');

    const args = [
      '-p', normalized,
      '-s',
      '--no-ask-user',
      '--deny-tool=write',
      '--deny-tool=shell',
      '--deny-tool=url',
      '--deny-tool=memory',
    ];
    const result = await this.run(args);
    if (!result.stdout) throw new Error(result.stderr || 'Copilot CLI returned an empty response');
    return result.stdout;
  }
}
