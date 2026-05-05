/**
 * AutoCode Model Layer
 * 
 * Abstraction layer supporting multiple AI providers with unified API.
 * Handles prompt construction, streaming, rate limiting, and response parsing.
 * 
 * Supports: OpenAI, Anthropic, Ollama, and custom endpoints.
 */

import * as vscode from 'vscode';
import {
  ModelRequest,
  ModelResponse,
  StreamCallback,
  StreamChunk,
  ModelProvider,
} from '../core/types';
import { ConfigManager } from '../core/config';
import { Logger } from '../core/logger';

/**
 * Provider-specific adapter interface
 */
interface ProviderAdapter {
  complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse>;
  stream(
    request: ModelRequest,
    callback: StreamCallback,
    token?: vscode.CancellationToken,
    signal?: AbortSignal
  ): Promise<ModelResponse>;
  checkStatus(): Promise<{ ok: boolean; error?: string }>;
}

export type ModelRequestCategory = 'completion' | 'background';

export class ModelLayer implements vscode.Disposable {
  private config: ConfigManager;
  private logger: Logger;
  private adapters: Map<ModelProvider, ProviderAdapter> = new Map();
  private requestCount = 0;
  private lastRequestTime = 0;
  private readonly MIN_REQUEST_INTERVAL_MS = 0; // Rate limiting
  private pendingRequests: Map<ModelRequestCategory, AbortController> = new Map();

  constructor() {
    this.config = ConfigManager.getInstance();
    this.logger = Logger.getInstance();
    this.initAdapters();
  }

  /**
   * Check the health/connectivity of the current model provider
   */
  async checkStatus(): Promise<{ ok: boolean; provider: string; model: string; error?: string }> {
      const adapter = this.getAdapter();
      const provider = this.config.getValue('provider');
      const model = this.config.getValue('model');
      try {
          const result = await adapter.checkStatus();
          return { ok: result.ok, provider, model, error: result.error };
      } catch (err: any) {
          return { ok: false, provider, model, error: err.message };
      }
  }

  private initAdapters(): void {
    this.adapters.set('openai', new OpenAIAdapter(this.config, this.logger));
    this.adapters.set('anthropic', new AnthropicAdapter(this.config, this.logger));
    this.adapters.set('ollama', new OllamaAdapter(this.config, this.logger));
    this.adapters.set('custom', new CustomAdapter(this.config, this.logger));
  }

  /**
   * Send a completion request to the configured model
   */
  async complete(request: ModelRequest, category: ModelRequestCategory = 'completion'): Promise<ModelResponse> {
    this.cancelCategory(category);
    const controller = new AbortController();
    this.pendingRequests.set(category, controller);

    const timeoutMs = category === 'completion' ? 15000 : 30000;
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    await this.rateLimit();
    const adapter = this.getAdapter();
    const timer = this.logger.time(`ModelLayer.complete:${category}`);

    try {
      this.logger.debug(`Sending ${category} request (${request.prompt.length} chars)`);
      const response = await this.withRetry(() => adapter.complete(request, controller.signal));
      timer();
      this.requestCount++;
      this.logger.debug(`Model response received (${response.text.length} chars)`);
      return response;
    } catch (err: any) {
      if (err.name === 'AbortError') {
          this.logger.debug(`Request ${category} cancelled`);
          throw err;
      }
      this.logger.error(`Model ${category} failed`, err);
      throw err;
    } finally {
        clearTimeout(timeoutId);
        if (this.pendingRequests.get(category) === controller) {
            this.pendingRequests.delete(category);
        }
    }
  }

  /**
   * Send a streaming completion request
   */
  async stream(
    request: ModelRequest,
    callback: StreamCallback,
    token?: vscode.CancellationToken,
    category: ModelRequestCategory = 'completion'
  ): Promise<ModelResponse> {
    this.cancelCategory(category);
    const controller = new AbortController();
    this.pendingRequests.set(category, controller);

    const timeoutMs = category === 'completion' ? 15000 : 30000;
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    await this.rateLimit();
    const adapter = this.getAdapter();
    const timer = this.logger.time(`ModelLayer.stream:${category}`);

    try {
      const response = await this.withRetry(() => adapter.stream(request, callback, token, controller.signal));
      timer();
      this.requestCount++;
      return response;
    } catch (err: any) {
      timer();
      if (err.name === 'AbortError') {
          throw err;
      }
      this.logger.error(`Model streaming (${category}) failed`, err);
      throw err;
    } finally {
        clearTimeout(timeoutId);
        if (this.pendingRequests.get(category) === controller) {
            this.pendingRequests.delete(category);
        }
    }
  }

  private cancelCategory(category: ModelRequestCategory): void {
      const controller = this.pendingRequests.get(category);
      if (controller) {
          controller.abort();
          this.pendingRequests.delete(category);
      }
      
      // If we are starting an interactive request, cancel background ones to free up resources
      if (category === 'completion') {
          const bg = this.pendingRequests.get('background');
          if (bg) {
              bg.abort();
              this.pendingRequests.delete('background');
          }
      }
  }

  private getAdapter(): ProviderAdapter {
    const provider = this.config.getValue('provider');
    const adapter = this.adapters.get(provider);
    if (!adapter) {
      throw new Error(`No adapter for provider: ${provider}`);
    }
    return adapter;
  }

  private async rateLimit(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastRequestTime;
    if (elapsed < this.MIN_REQUEST_INTERVAL_MS) {
      await new Promise((resolve) =>
        setTimeout(resolve, this.MIN_REQUEST_INTERVAL_MS - elapsed)
      );
    }
    this.lastRequestTime = Date.now();
  }

  private async withRetry<T>(fn: () => Promise<T>, maxAttempts = 3, baseDelayMs = 500): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err;
        const isRetryable = err instanceof Error && (
          err.message.includes('ECONNRESET') ||
          err.message.includes('ETIMEDOUT') ||
          err.message.includes('fetch failed') ||
          err.message.includes('502') ||
          err.message.includes('503') ||
          err.message.includes('429')
        );
        if (!isRetryable || attempt >= maxAttempts - 1) {
          throw err;
        }
        const delay = baseDelayMs * Math.pow(2, attempt) + Math.random() * 200;
        this.logger.warn(`Retryable error, attempt ${attempt + 1}/${maxAttempts}. Retrying in ${Math.round(delay)}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    throw lastError;
  }

  getRequestCount(): number {
    return this.requestCount;
  }

  dispose(): void {
    for (const controller of this.pendingRequests.values()) {
        controller.abort();
    }
    this.pendingRequests.clear();
  }
}

// ─────────────────────────────────────────────────────────────
// OpenAI Adapter
// ─────────────────────────────────────────────────────────────

class OpenAIAdapter implements ProviderAdapter {
  constructor(
    private config: ConfigManager,
    private logger: Logger
  ) {}

  async complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse> {
    const startTime = Date.now();
    const endpoint = this.config.getEndpoint();
    const apiKey = await this.config.getApiKey();
    const model = this.config.getValue('model');

    const body = {
      model,
      messages: [
        ...(request.systemPrompt
          ? [{ role: 'system', content: request.systemPrompt }]
          : []),
        { role: 'user', content: request.prompt },
      ],
      max_tokens: request.maxTokens,
      temperature: request.temperature,
      stop: request.stopSequences,
      stream: false,
    };

    const response = await fetch(`${endpoint}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal
    });

    if (!response.ok) {
      throw new Error(
        `OpenAI API error: ${response.status} ${response.statusText}`
      );
    }

    const data = (await response.json()) as any;
    const latencyMs = Date.now() - startTime;

    return {
      text: data.choices[0].message.content,
      finishReason:
        data.choices[0].finish_reason === 'stop' ? 'stop' : 'length',
      usage: {
        promptTokens: data.usage?.prompt_tokens || 0,
        completionTokens: data.usage?.completion_tokens || 0,
        totalTokens: data.usage?.total_tokens || 0,
      },
      latencyMs,
    };
  }

  async stream(
    request: ModelRequest,
    callback: StreamCallback,
    token?: vscode.CancellationToken,
    signal?: AbortSignal
  ): Promise<ModelResponse> {
    const startTime = Date.now();
    const endpoint = this.config.getEndpoint();
    const apiKey = await this.config.getApiKey();
    const model = this.config.getValue('model');

    const body = {
      model,
      messages: [
        ...(request.systemPrompt
          ? [{ role: 'system', content: request.systemPrompt }]
          : []),
        { role: 'user', content: request.prompt },
      ],
      max_tokens: request.maxTokens,
      temperature: request.temperature,
      stop: request.stopSequences,
      stream: true,
    };

    const controller = new AbortController();
    if (token) {
      token.onCancellationRequested(() => controller.abort());
    }

    const response = await fetch(`${endpoint}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: signal || controller.signal,
    });

    if (!response.ok) {
      throw new Error(
        `OpenAI API error: ${response.status} ${response.statusText}`
      );
    }

    let fullText = '';
    const reader = response.body?.getReader();
    if (!reader) {throw new Error('No response body');}

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) {break;}

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) {continue;}
        const data = line.slice(6).trim();
        if (data === '[DONE]') {
          callback({ text: '', done: true });
          break;
        }

        try {
          const parsed = JSON.parse(data);
          const content = parsed.choices?.[0]?.delta?.content || '';
          if (content) {
            fullText += content;
            callback({ text: content, done: false });
          }
        } catch {
          // Skip malformed chunks
        }
      }
    }

    const latencyMs = Date.now() - startTime;
    return {
      text: fullText,
      finishReason: 'stop',
      usage: {
        promptTokens: 0,
        completionTokens: Math.ceil(fullText.length / 4),
        totalTokens: 0,
      },
      latencyMs,
    };
  }

  async checkStatus(): Promise<{ ok: boolean; error?: string }> {
      try {
          const endpoint = this.config.getEndpoint();
          const apiKey = await this.config.getApiKey();
          if (!apiKey && this.config.getValue('provider') === 'openai') {
              return { ok: false, error: 'API Key missing for OpenAI' };
          }
          const response = await fetch(`${endpoint}/models`, {
              headers: { Authorization: `Bearer ${apiKey}` }
          });
          if (response.ok) {return { ok: true };}
          return { ok: false, error: `OpenAI API error: ${response.status}` };
      } catch (err: any) {
          return { ok: false, error: err.message };
      }
  }
}

// ─────────────────────────────────────────────────────────────
// Anthropic Adapter
// ─────────────────────────────────────────────────────────────

class AnthropicAdapter implements ProviderAdapter {
  constructor(
    private config: ConfigManager,
    private logger: Logger
  ) {}

  async complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse> {
    const startTime = Date.now();
    const endpoint = this.config.getEndpoint();
    const apiKey = await this.config.getApiKey();
    const model = this.config.getValue('model');

    const body = {
      model,
      max_tokens: request.maxTokens,
      system: request.systemPrompt || '',
      messages: [{ role: 'user', content: request.prompt }],
      temperature: request.temperature,
      stop_sequences: request.stopSequences,
    };

    const response = await fetch(`${endpoint}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal
    });

    if (!response.ok) {
      throw new Error(
        `Anthropic API error: ${response.status} ${response.statusText}`
      );
    }

    const data = (await response.json()) as any;
    const latencyMs = Date.now() - startTime;

    return {
      text: data.content[0].text,
      finishReason: data.stop_reason === 'end_turn' ? 'stop' : 'length',
      usage: {
        promptTokens: data.usage?.input_tokens || 0,
        completionTokens: data.usage?.output_tokens || 0,
        totalTokens:
          (data.usage?.input_tokens || 0) +
          (data.usage?.output_tokens || 0),
      },
      latencyMs,
    };
  }

  async stream(
    request: ModelRequest,
    callback: StreamCallback,
    token?: vscode.CancellationToken,
    signal?: AbortSignal
  ): Promise<ModelResponse> {
    const startTime = Date.now();
    const endpoint = this.config.getEndpoint();
    const apiKey = await this.config.getApiKey();
    const model = this.config.getValue('model');

    const body = {
      model,
      max_tokens: request.maxTokens,
      system: request.systemPrompt || '',
      messages: [{ role: 'user', content: request.prompt }],
      temperature: request.temperature,
      stop_sequences: request.stopSequences,
      stream: true,
    };

    const controller = new AbortController();
    if (token) {
      token.onCancellationRequested(() => controller.abort());
    }

    const response = await fetch(`${endpoint}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal: signal || controller.signal,
    });

    if (!response.ok) {
      throw new Error(
        `Anthropic API error: ${response.status} ${response.statusText}`
      );
    }

    let fullText = '';
    const reader = response.body?.getReader();
    if (!reader) {throw new Error('No response body');}

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) {break;}

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) {continue;}
        const data = line.slice(6).trim();

        try {
          const parsed = JSON.parse(data);
          if (parsed.type === 'content_block_delta') {
            const text = parsed.delta?.text || '';
            if (text) {
              fullText += text;
              callback({ text, done: false });
            }
          } else if (parsed.type === 'message_stop') {
            callback({ text: '', done: true });
          }
        } catch {
          // Skip malformed chunks
        }
      }
    }

    const latencyMs = Date.now() - startTime;
    return {
      text: fullText,
      finishReason: 'stop',
      usage: {
        promptTokens: 0,
        completionTokens: Math.ceil(fullText.length / 4),
        totalTokens: 0,
      },
      latencyMs,
    };
  }

  async checkStatus(): Promise<{ ok: boolean; error?: string }> {
      try {
          const endpoint = this.config.getEndpoint();
          const apiKey = await this.config.getApiKey();
          if (!apiKey && this.config.getValue('provider') === 'anthropic') {
              return { ok: false, error: 'API Key missing for Anthropic' };
          }
          const response = await fetch(`${endpoint}/messages`, {
              method: 'POST',
              headers: { 
                  'x-api-key': apiKey,
                  'anthropic-version': '2023-06-01',
                  'Content-Type': 'application/json'
              },
              body: JSON.stringify({ model: 'ping', messages: [], max_tokens: 1 })
          });
          if (response.status === 401 || response.status === 403) {
              return { ok: false, error: `Anthropic Auth error: ${response.status}` };
          }
          return { ok: true };
      } catch (err: any) {
          return { ok: false, error: err.message };
      }
  }
}

// ─────────────────────────────────────────────────────────────
// Ollama Adapter (Local models)
// ─────────────────────────────────────────────────────────────

class OllamaAdapter implements ProviderAdapter {
  constructor(
    private config: ConfigManager,
    private logger: Logger
  ) {}

  async complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse> {
    const startTime = Date.now();
    const endpoint = this.config.getEndpoint();
    const model = this.config.getValue('model');

    const body = {
      model,
      prompt: this.buildOllamaPrompt(request),
      stream: false,
      options: {
        temperature: request.temperature,
        num_predict: request.maxTokens,
        stop: request.stopSequences,
      },
    };

    const response = await fetch(`${endpoint}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal
    });

    if (!response.ok) {
      throw new Error(
        `Ollama API error: ${response.status} ${response.statusText}`
      );
    }

    const data = (await response.json()) as any;
    const latencyMs = Date.now() - startTime;

    return {
      text: data.response,
      finishReason: 'stop',
      usage: {
        promptTokens: data.prompt_eval_count || 0,
        completionTokens: data.eval_count || 0,
        totalTokens:
          (data.prompt_eval_count || 0) + (data.eval_count || 0),
      },
      latencyMs,
    };
  }

  async stream(
    request: ModelRequest,
    callback: StreamCallback,
    token?: vscode.CancellationToken,
    signal?: AbortSignal
  ): Promise<ModelResponse> {
    const startTime = Date.now();
    const endpoint = this.config.getEndpoint();
    const model = this.config.getValue('model');

    const body = {
      model,
      prompt: this.buildOllamaPrompt(request),
      stream: true,
      options: {
        temperature: request.temperature,
        num_predict: request.maxTokens,
        stop: request.stopSequences,
      },
    };

    const controller = new AbortController();
    if (token) {
      token.onCancellationRequested(() => controller.abort());
    }

    const response = await fetch(`${endpoint}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: signal || controller.signal,
    });

    if (!response.ok) {
      throw new Error(
        `Ollama API error: ${response.status} ${response.statusText}`
      );
    }

    let fullText = '';
    const reader = response.body?.getReader();
    if (!reader) {throw new Error('No response body');}

    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) {break;}

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n').filter(Boolean);

      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.response) {
            fullText += parsed.response;
            callback({ text: parsed.response, done: false });
          }
          if (parsed.done) {
            callback({ text: '', done: true });
          }
        } catch {
          // Skip malformed lines
        }
      }
    }

    const latencyMs = Date.now() - startTime;
    return {
      text: fullText,
      finishReason: 'stop',
      usage: {
        promptTokens: 0,
        completionTokens: Math.ceil(fullText.length / 4),
        totalTokens: 0,
      },
      latencyMs,
    };
  }

  private buildOllamaPrompt(request: ModelRequest): string {
    // If it's a FIM request, don't wrap it in chat markers
    if (request.prompt.includes('<|fim_prefix|>') || request.prompt.includes('<fim_prefix>')) {
        return request.prompt;
    }

    let prompt = '';
    if (request.systemPrompt) {
      prompt += `### System\n${request.systemPrompt}\n\n`;
    }
    prompt += `### User\n${request.prompt}\n\n### Assistant\n`;
    return prompt;
  }

  async checkStatus(): Promise<{ ok: boolean; error?: string }> {
      try {
          const endpoint = this.config.getEndpoint();
          const response = await fetch(`${endpoint}/api/tags`);
          if (response.ok) {
              return { ok: true };
          }
          return { ok: false, error: `Ollama error: ${response.status}` };
      } catch (err: any) {
          return { ok: false, error: `Could not connect to Ollama at ${this.config.getEndpoint()}. Make sure it is running.` };
      }
  }
}

// ─────────────────────────────────────────────────────────────
// Custom Adapter (user-provided endpoint)
// ─────────────────────────────────────────────────────────────

class CustomAdapter implements ProviderAdapter {
  constructor(
    private config: ConfigManager,
    private logger: Logger
  ) {}

  async complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse> {
    // Delegates to OpenAI-compatible endpoint format
    const openaiAdapter = new OpenAIAdapter(this.config, this.logger);
    return openaiAdapter.complete(request, signal);
  }

  async stream(
    request: ModelRequest,
    callback: StreamCallback,
    token?: vscode.CancellationToken,
    signal?: AbortSignal
  ): Promise<ModelResponse> {
    const openaiAdapter = new OpenAIAdapter(this.config, this.logger);
    return openaiAdapter.stream(request, callback, token, signal);
  }

  async checkStatus(): Promise<{ ok: boolean; error?: string }> {
      const openaiAdapter = new OpenAIAdapter(this.config, this.logger);
      return openaiAdapter.checkStatus();
  }
}
