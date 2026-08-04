/**
 * Message protocol between LocalModelClient and the model worker.
 */
import type { ChatMessage, ToolCall, ToolDefinition } from '../types';
import type { OnnxDtype } from './model-registry';

export interface GenerateRequest {
  type: 'generate';
  id: number;
  modelId: string;
  dtype: OnnxDtype;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  maxNewTokens: number;
}

export interface AbortRequest {
  type: 'abort';
  id: number;
}

export type WorkerRequest = GenerateRequest | AbortRequest;

export interface ProgressEvent {
  type: 'progress';
  file: string;
  /** 0..100 for determinate files. */
  progress?: number;
  status: string;
}

export interface ResultEvent {
  type: 'result';
  id: number;
  content: string;
  toolCalls: ToolCall[];
}

export interface ErrorEvent {
  type: 'error';
  id?: number;
  message: string;
}

export type WorkerResponse = ProgressEvent | ResultEvent | ErrorEvent;
