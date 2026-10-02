/**
 * Thin Mistral chat-completions client (plain fetch, no SDK).
 * - JSON mode via response_format
 * - per-attempt timeout
 * - one retry for 429 / 5xx / network errors (never for timeouts, to bound latency)
 */

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CompletionResult {
  content: string;
  promptTokens?: number | undefined;
  completionTokens?: number | undefined;
}

export class LlmError extends Error {
  constructor(
    public readonly kind: 'timeout' | 'http' | 'network' | 'invalid_response',
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

export interface MistralOptions {
  apiKey: string;
  model: string;
  baseUrl: string;
  timeoutMs: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function retryDelayMs(retryAfter: string | null): number {
  const seconds = retryAfter ? Number(retryAfter) : NaN;
  // Respect Retry-After but never stall a chat turn for long.
  return Number.isFinite(seconds) ? Math.min(seconds * 1000, 2000) : 600;
}

export class MistralClient {
  constructor(private readonly opts: MistralOptions) {}

  get model() {
    return this.opts.model;
  }

  async complete(
    messages: LlmMessage[],
    params: { temperature?: number; maxTokens?: number; json?: boolean } = {},
  ): Promise<CompletionResult> {
    const body = JSON.stringify({
      model: this.opts.model,
      messages,
      temperature: params.temperature ?? 0.2,
      max_tokens: params.maxTokens ?? 400,
      ...(params.json ? { response_format: { type: 'json_object' } } : {}),
    });

    const maxAttempts = 2;
    for (let attempt = 1; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(`${this.opts.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            Authorization: `Bearer ${this.opts.apiKey}`,
          },
          body,
          signal: AbortSignal.timeout(this.opts.timeoutMs),
        });
      } catch (err) {
        const name = (err as Error).name;
        if (name === 'TimeoutError' || name === 'AbortError') {
          throw new LlmError('timeout', `Mistral did not respond within ${this.opts.timeoutMs}ms`);
        }
        if (attempt < maxAttempts) {
          await sleep(400);
          continue;
        }
        throw new LlmError('network', `Network error calling Mistral: ${(err as Error).message}`);
      }

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const retryable = res.status === 429 || res.status >= 500;
        if (retryable && attempt < maxAttempts) {
          await sleep(retryDelayMs(res.headers.get('retry-after')));
          continue;
        }
        throw new LlmError('http', `Mistral HTTP ${res.status}: ${text.slice(0, 300)}`, res.status);
      }

      const data = (await res.json().catch(() => null)) as {
        choices?: { message?: { content?: unknown } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      } | null;
      const content = data?.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || content.length === 0) {
        throw new LlmError('invalid_response', 'Mistral returned no message content');
      }
      return {
        content,
        promptTokens: data?.usage?.prompt_tokens,
        completionTokens: data?.usage?.completion_tokens,
      };
    }
  }
}
