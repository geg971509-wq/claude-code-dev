import { useState, useEffect, useCallback, useReducer, useRef } from 'react';
import imageCompression from 'browser-image-compression';
import type { ACPClient } from '../src/acp/client';
import type { PermissionRequestPayload, PermissionOption, ContentBlock, ImageContent } from '../src/acp/types';
import type { ToolCallEntry, ChatInputMessage, PendingPermission } from '../src/lib/types';
import {
  acpErrorToThreadActions,
  acpHistoryReplayCompletedActions,
  acpPromptFailureMessage,
  acpUpdateToThreadActionsForState,
  permissionResponseToolStatus,
  shouldHandleAcpError,
  submitAcpPrompt,
} from '../src/lib/acp-thread-events';
import {
  cancelThreadActions,
  initialThreadState,
  threadStateReducer,
  type ThreadState,
  type ThreadStateAction,
} from '../src/lib/thread-state';
import { ChatView } from './chat/ChatView';
import { ChatInput } from './chat/ChatInput';
import { PermissionPanel } from './chat/PermissionPanel';
import { ModelSelectorPopover } from './model-selector';
import { useCommands } from '../src/hooks/useCommands';

// Image compression options
// Claude API has a 5MB limit, so we target 2MB to be safe
const IMAGE_COMPRESSION_OPTIONS = {
  maxSizeMB: 2, // Max output size in MB
  maxWidthOrHeight: 2048, // Max dimension (scales proportionally, no cropping)
  useWebWorker: true, // Non-blocking compression
  fileType: 'image/jpeg' as const, // Convert to JPEG for better compression
};

// Convert data URL to Blob without using fetch()
// This is critical for Chrome extensions where fetch(dataUrl) violates CSP
function dataUrlToBlob(dataUrl: string): Blob {
  // Parse the data URL: data:[<mediatype>][;base64],<data>
  const commaIndex = dataUrl.indexOf(',');
  if (commaIndex === -1) {
    throw new Error('Invalid data URL: missing comma separator');
  }

  const header = dataUrl.slice(0, commaIndex);
  const base64Data = dataUrl.slice(commaIndex + 1);

  // Extract MIME type from header (e.g., "data:image/png;base64")
  const mimeMatch = header.match(/^data:([^;,]+)/);
  const mimeType = mimeMatch ? mimeMatch[1] : 'application/octet-stream';

  // Decode base64 to binary
  const binaryString = atob(base64Data);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }

  return new Blob([bytes], { type: mimeType });
}

import { Plus, Shield, ChevronDown, ChevronUp, Check } from 'lucide-react';
import { Button } from './ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';

// =============================================================================
// Type Definitions - imported from shared types module
// =============================================================================

interface ChatInterfaceProps {
  client: ACPClient;
  agentId?: string;
}

// =============================================================================
// Permission Mode Selector
// =============================================================================

const PERMISSION_MODES = [
  { value: 'default', label: '默认', description: '手动审批权限请求' },
  { value: 'acceptEdits', label: '自动接受编辑', description: '自动允许文件编辑操作' },
  { value: 'bypassPermissions', label: '跳过权限', description: '跳过所有权限检查' },
  { value: 'plan', label: '规划模式', description: '仅规划，不执行工具' },
  { value: 'dontAsk', label: '不询问', description: '不弹出询问，自动拒绝' },
  { value: 'auto', label: '自动判断', description: 'AI 自动判断是否批准' },
] as const;

function PermissionModeSelector({ mode, onModeChange }: { mode: string; onModeChange: (mode: string) => void }) {
  const [open, setOpen] = useState(false);
  const current = PERMISSION_MODES.find(m => m.value === mode) ?? PERMISSION_MODES[0];

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="gap-1.5 text-muted-foreground hover:text-foreground h-7 px-2">
          <Shield className="h-3 w-3" />
          <span className="max-w-24 truncate">{current.label}</span>
          {open ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-1" align="start">
        {PERMISSION_MODES.map(m => (
          <button
            key={m.value}
            type="button"
            onClick={() => {
              onModeChange(m.value);
              setOpen(false);
            }}
            className="flex w-full items-start gap-2 rounded-md px-2.5 py-2 text-left hover:bg-surface-2 transition-colors"
          >
            <span className="mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center">
              {mode === m.value && <Check className="h-3.5 w-3.5 text-brand" />}
            </span>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-text-primary">{m.label}</div>
              <div className="text-xs text-text-muted">{m.description}</div>
            </div>
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

// =============================================================================
// ChatInterface Component
// =============================================================================

export function ChatInterface({ client, agentId }: ChatInterfaceProps) {
  const [threadState, dispatch] = useReducer(threadStateReducer, null, initialThreadState);
  const threadStateRef = useRef<ThreadState>(threadState);
  const { entries, phase, activeAssistantId } = threadState;
  const isLoading = phase !== 'idle' && phase !== 'error';
  const [sessionReady, setSessionReady] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [permissionMode, setPermissionMode] = useState(() => localStorage.getItem('acp_permission_mode') || 'default');
  // Reference: Zed's supports_images() checks prompt_capabilities.image
  const [supportsImages, setSupportsImages] = useState(false);
  const { commands: availableCommands } = useCommands(client);

  useEffect(() => {
    threadStateRef.current = threadState;
  }, [threadState]);

  const dispatchThread = useCallback((action: ThreadStateAction) => {
    threadStateRef.current = threadStateReducer(threadStateRef.current, action);
    dispatch(action);
  }, []);

  const resetThreadState = useCallback(
    (sessionId: string | null = null) => {
      dispatchThread({ type: 'reset', sessionId });
      setSessionReady(false);
    },
    [dispatchThread],
  );

  const storageKey = agentId ? `acp_last_session_${agentId}` : null;

  const activateSession = useCallback(
    (sessionId: string, options?: { resetEntries?: boolean }) => {
      const shouldResetEntries = options?.resetEntries ?? true;
      if (shouldResetEntries || threadStateRef.current.sessionId !== sessionId) {
        dispatchThread({ type: 'reset', sessionId });
      }
      setSessionReady(true);
      setSupportsImages(client.supportsImages);
      // Persist session ID for restoration on remount
      if (storageKey) {
        try {
          localStorage.setItem(storageKey, sessionId);
        } catch {}
      }
      console.log('[ChatInterface] Active session:', sessionId, 'supportsImages:', client.supportsImages);
    },
    [client, dispatchThread, storageKey],
  );

  // =============================================================================
  // Permission Request Handler
  // =============================================================================
  const handlePermissionRequest = useCallback(
    (request: PermissionRequestPayload) => {
      if (request.sessionId !== threadStateRef.current.sessionId) return;
      console.log('[ChatInterface] Permission request:', request);
      const existing = threadStateRef.current.entries.find(
        entry => entry.type === 'tool_call' && entry.toolCall.id === request.toolCall.toolCallId,
      );
      dispatchThread({
        type: 'tool_upsert',
        sessionId: request.sessionId,
        toolCall: {
          id: request.toolCall.toolCallId,
          title: request.toolCall.title ?? 'Permission Request',
          status: 'waiting_for_confirmation',
          ...(request.toolCall.content === undefined ? {} : { content: request.toolCall.content }),
          permissionRequest: { requestId: request.requestId, options: request.options },
          ...(!existing ? { isStandalonePermission: true } : {}),
        },
      });
    },
    [dispatchThread],
  );

  // =============================================================================
  // Setup Effect
  // =============================================================================
  useEffect(() => {
    client.setSessionCreatedHandler(sessionId => {
      console.log('[ChatInterface] Session created:', sessionId);
      activateSession(sessionId);
    });

    client.setSessionLoadedHandler(sessionId => {
      console.log('[ChatInterface] Session loaded/resumed:', sessionId);
      for (const action of acpHistoryReplayCompletedActions(threadStateRef.current, sessionId)) {
        dispatchThread(action);
      }
      activateSession(sessionId, { resetEntries: false });
    });

    client.setSessionSwitchingHandler(sessionId => {
      console.log('[ChatInterface] Switching to session:', sessionId);
      resetThreadState(sessionId);
    });

    client.setSessionUpdateHandler((sessionId, update) => {
      for (const action of acpUpdateToThreadActionsForState(threadStateRef.current, sessionId, update)) {
        dispatchThread(action);
      }
    });

    client.setPromptCompleteHandler((sessionId, stopReason) => {
      console.log('[ChatInterface] Prompt complete:', stopReason);
      dispatchThread({
        type: /cancel|interrupt|abort|stop/i.test(stopReason) ? 'turn_cancelled' : 'turn_completed',
        sessionId,
      });
    });

    client.setPermissionRequestHandler(handlePermissionRequest);

    client.setErrorMessageHandler((msg, sessionId) => {
      if (!shouldHandleAcpError(threadStateRef.current.sessionId, sessionId)) return;
      console.error('[ChatInterface] Agent error:', msg);
      setErrorMessage(msg);
      for (const action of acpErrorToThreadActions(sessionId)) {
        dispatchThread(action);
      }
      // Clear any existing timer
      if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
      // Auto-clear after 5 seconds
      errorTimerRef.current = setTimeout(() => setErrorMessage(null), 5000);
    });

    // Restore last session or create a new one
    const lastSessionId = storageKey ? localStorage.getItem(storageKey) : null;
    if (lastSessionId && (client.supportsLoadSession || client.supportsResumeSession)) {
      console.log('[ChatInterface] Restoring session:', lastSessionId);
      const restore = async () => {
        try {
          if (client.supportsLoadSession) {
            await client.loadSession({ sessionId: lastSessionId });
          } else {
            await client.resumeSession({ sessionId: lastSessionId });
          }
        } catch (err) {
          console.warn('[ChatInterface] Failed to restore session, creating new one:', err);
          client.createSession(undefined, permissionMode);
        }
      };
      restore();
    } else {
      client.createSession(undefined, permissionMode);
    }
    return () => {
      if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
      client.setSessionCreatedHandler(() => {});
      client.setSessionLoadedHandler(() => {});
      client.setSessionSwitchingHandler(null);
      client.setSessionUpdateHandler(() => {});
      client.setPromptCompleteHandler(() => {});
      client.setPermissionRequestHandler(() => {});
      client.setErrorMessageHandler(() => {});
    };
  }, [activateSession, client, dispatchThread, handlePermissionRequest, resetThreadState]);

  // =============================================================================
  // User Actions
  // =============================================================================

  // Reference: Zed's ConnectionView.reset() + set_server_state() + _external_thread()
  // Creates a new session by clearing current state and calling new_session
  // This is the core of Zed's NewThread action
  const handleNewSession = useCallback(() => {
    console.log('[ChatInterface] Creating new session...');

    // Reference: Zed's set_server_state() calls close_all_sessions() before setting new state
    // Cancel any ongoing request before creating new session
    if (isLoading) {
      client.cancel();
    }

    // 1. Clear all entries (like Zed's set_server_state which creates new view)
    resetThreadState();

    // 3. Create new session (like Zed's initial_state -> connection.new_session())
    // The session_created handler will set sessionReady=true when ready
    client.createSession(undefined, permissionMode);
  }, [client, isLoading, resetThreadState, permissionMode]);

  // Cancel handler - matches Zed's cancel() logic in acp_thread.rs
  // 1. Mark all pending/running/waiting_for_confirmation tool calls as canceled
  // 2. Send cancel notification to agent
  // 3. Do NOT set isLoading=false here - wait for prompt_complete with stopReason="cancelled"
  const handleCancel = () => {
    console.log('[ChatInterface] Cancel requested');
    const current = threadStateRef.current;
    if (!current.sessionId) return;
    for (const action of cancelThreadActions(current)) dispatchThread(action);
    client.cancel();
  };

  const handlePermissionResponse = useCallback(
    (requestId: string, optionId: string | null, optionKind: PermissionOption['kind'] | null) => {
      console.log('[ChatInterface] Permission response:', { requestId, optionId, optionKind });
      client.respondToPermission(requestId, optionId);

      const current = threadStateRef.current;
      const entry = current.entries.find(
        candidate => candidate.type === 'tool_call' && candidate.toolCall.permissionRequest?.requestId === requestId,
      );
      if (!current.sessionId || entry?.type !== 'tool_call') return;
      dispatchThread({
        type: 'tool_upsert',
        sessionId: current.sessionId,
        toolCall: {
          id: entry.toolCall.id,
          status: permissionResponseToolStatus(optionId, optionKind, entry.toolCall.isStandalonePermission === true),
          permissionRequest: undefined,
          isStandalonePermission: undefined,
        },
      });
    },
    [client, dispatchThread],
  );

  // =============================================================================
  // Render
  // =============================================================================

  // Collect pending permissions from tool call entries
  const pendingPermissions: PendingPermission[] = entries
    .filter(
      (e): e is ToolCallEntry =>
        e.type === 'tool_call' && e.toolCall.status === 'waiting_for_confirmation' && !!e.toolCall.permissionRequest,
    )
    .map(e => ({
      requestId: e.toolCall.permissionRequest!.requestId,
      toolName: e.toolCall.title,
      toolInput: e.toolCall.rawInput || {},
      description: e.toolCall.title,
      options: e.toolCall.permissionRequest!.options,
    }));

  // Handle permission respond for unified PermissionPanel
  const handlePermissionPanelRespond = useCallback(
    (requestId: string, approved: boolean) => {
      // Find the matching permission request to get the real optionId
      const perm = pendingPermissions.find(p => p.requestId === requestId);
      let optionId: string | null = null;
      let optionKind: PermissionOption['kind'] | null = null;

      if (perm?.options && perm.options.length > 0) {
        if (approved) {
          // Pick the first allow option (prefer allow_once, then allow_always)
          const allowOpt =
            perm.options.find(o => o.kind === 'allow_once') ?? perm.options.find(o => o.kind === 'allow_always');
          if (allowOpt) {
            optionId = allowOpt.optionId;
            optionKind = allowOpt.kind;
          }
        } else {
          // Pick the first reject option
          const rejectOpt =
            perm.options.find(o => o.kind === 'reject_once') ?? perm.options.find(o => o.kind === 'reject_always');
          if (rejectOpt) {
            optionId = rejectOpt.optionId;
            optionKind = rejectOpt.kind;
          }
        }
      }

      // Fallback: if no matching option found, use null (cancelled)
      if (!optionId) {
        optionKind = approved ? 'allow_once' : 'reject_once';
      }

      handlePermissionResponse(requestId, optionId, optionKind);
    },
    [handlePermissionResponse, pendingPermissions],
  );

  // Handle ChatInput submit — convert ChatInputMessage to ContentBlock[]
  const handleChatInputSubmit = useCallback(
    async (message: ChatInputMessage) => {
      const text = message.text.trim();
      const images = message.images || [];

      const current = threadStateRef.current;
      if ((!text && images.length === 0) || !sessionReady || (current.phase !== 'idle' && current.phase !== 'error')) {
        return;
      }

      const sessionId = current.sessionId;
      if (!sessionId) return;
      const contentBlocks: ContentBlock[] = [
        ...(text ? [{ type: 'text' as const, text }] : []),
        ...images.map(image => ({
          type: 'image' as const,
          mimeType: image.mimeType,
          data: image.data,
        })),
      ];
      const result = await submitAcpPrompt({
        sessionId,
        content: contentBlocks,
        dispatch: dispatchThread,
        sendPrompt: blocks => client.sendPrompt(blocks, sessionId),
        prepareImage: async image => {
          const blob = dataUrlToBlob(`data:${image.mimeType};base64,${image.data}`);
          let finalBlob: Blob = blob;
          let finalMimeType = image.mimeType;
          if (blob.size > 2 * 1024 * 1024) {
            const imageFile = new File([blob], 'image.jpg', { type: blob.type });
            finalBlob = await imageCompression(imageFile, IMAGE_COMPRESSION_OPTIONS);
            finalMimeType = 'image/jpeg';
          }
          const base64Data = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => {
              const value = reader.result as string;
              const commaIndex = value.indexOf(',');
              resolve(commaIndex >= 0 ? value.slice(commaIndex + 1) : value);
            };
            reader.onerror = () => reject(new Error('FileReader error: ' + reader.error?.message));
            reader.readAsDataURL(finalBlob);
          });
          return { type: 'image', mimeType: finalMimeType, data: base64Data } satisfies ImageContent;
        },
      });
      const failureMessage = acpPromptFailureMessage(result);
      if (failureMessage && threadStateRef.current.sessionId === sessionId) {
        if (result.status !== 'sent') {
          console.error(`[ChatInterface] Prompt ${result.status}:`, result.error);
        }
        setErrorMessage(failureMessage);
        if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
        errorTimerRef.current = setTimeout(() => setErrorMessage(null), 5000);
      }
    },
    [sessionReady, client, dispatchThread],
  );

  return (
    <div className="flex flex-col h-full">
      {/* Chat messages — unified ChatView */}
      <ChatView
        entries={entries}
        phase={sessionReady ? phase : 'idle'}
        activeAssistantId={sessionReady ? activeAssistantId : null}
        onPermissionRespond={(requestId, optionId, optionKind) => {
          handlePermissionResponse(requestId, optionId, optionKind as PermissionOption['kind'] | null);
        }}
        emptyTitle={sessionReady ? '开始对话' : undefined}
        emptyDescription={sessionReady ? '输入消息开始与 ACP agent 聊天' : undefined}
      />

      {/* Permission panel — fixed above input */}
      <PermissionPanel requests={pendingPermissions} onRespond={handlePermissionPanelRespond} />

      {/* Error banner */}
      {errorMessage && (
        <div className="mx-auto max-w-3xl w-full px-4 sm:px-8 pb-1">
          <div className="rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 px-3 py-2 text-sm text-red-700 dark:text-red-300 flex items-center justify-between">
            <span>{errorMessage}</span>
            <button
              type="button"
              onClick={() => setErrorMessage(null)}
              className="ml-2 text-red-500 hover:text-red-700 dark:text-red-400 dark:hover:text-red-200 flex-shrink-0"
            >
              {'\u00D7'}
            </button>
          </div>
        </div>
      )}

      {/* Model selector + New thread + ChatInput */}
      <div className="flex-shrink-0">
        <div className="max-w-3xl mx-auto w-full px-4 sm:px-8 pb-1 flex items-center justify-between">
          <div className="flex items-center gap-1">
            <PermissionModeSelector
              mode={permissionMode}
              onModeChange={(m: string) => {
                setPermissionMode(m);
                localStorage.setItem('acp_permission_mode', m);
              }}
            />
            <ModelSelectorPopover client={client} />
          </div>
          {entries.length > 0 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs text-text-muted hover:text-brand font-display gap-1"
                  onClick={handleNewSession}
                >
                  <Plus className="h-3 w-3" />
                  新会话
                </Button>
              </TooltipTrigger>
              <TooltipContent>New Thread</TooltipContent>
            </Tooltip>
          )}
        </div>
        <ChatInput
          onSubmit={handleChatInputSubmit}
          isLoading={isLoading}
          onInterrupt={handleCancel}
          disabled={!sessionReady}
          placeholder={sessionReady ? '给 Claude 发送消息…' : '等待会话...'}
          supportsImages={supportsImages}
          onError={setErrorMessage}
          commands={availableCommands.length > 0 ? availableCommands : undefined}
        />
      </div>
    </div>
  );
}
