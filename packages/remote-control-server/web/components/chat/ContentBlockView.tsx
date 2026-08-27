import type { RenderableContentBlock } from '../../src/lib/types';
import { MessageResponse } from '../ai-elements/message';

interface ContentBlockViewProps {
  blocks: RenderableContentBlock[];
  keyPrefix: string;
  mode: 'user' | 'assistant' | 'tool';
  streaming?: boolean;
}

const renderableImageTypes = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

function httpUrl(uri: string): string | null {
  try {
    const url = new URL(uri);
    return url.protocol === 'http:' || url.protocol === 'https:' ? uri : null;
  } catch {
    return null;
  }
}

function resourceName(uri: string): string {
  const parts = uri.split(/[/?#]/).filter(Boolean);
  const value = parts[parts.length - 1];
  if (!value) return 'resource';
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function base64Size(data: string): number {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

function formatSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function ImageBlock({ mimeType, data, alt }: { mimeType: string; data: string; alt: string }) {
  if (!renderableImageTypes.has(mimeType)) {
    return (
      <div className="rounded-md border border-border bg-surface-1 p-3 text-xs text-text-secondary">
        <div className="font-medium">Image attachment</div>
        <div className="mt-1 text-text-muted">{mimeType}</div>
      </div>
    );
  }
  const dataUrl = `data:${mimeType};base64,${data}`;
  return (
    <a
      className="inline-block overflow-hidden rounded-lg border border-border transition-colors hover:border-brand/40"
      href={dataUrl}
      rel="noreferrer noopener"
      target="_blank"
      title="Open original image"
    >
      <img alt={alt} className="h-24 w-24 object-cover sm:h-32 sm:w-32" loading="lazy" src={dataUrl} />
    </a>
  );
}

function AudioBlock({ block }: { block: Extract<RenderableContentBlock, { type: 'audio' }> }) {
  if (!block.playable) {
    return (
      <div className="rounded-md border border-border bg-surface-1 p-3 text-xs text-text-secondary">
        <div className="font-medium">Audio unavailable</div>
        <div className="mt-1 text-text-muted">{block.mimeType}</div>
      </div>
    );
  }
  return (
    <div className="rounded-md border border-border bg-surface-1 p-3">
      <div className="mb-2 text-xs font-medium text-text-secondary">Audio attachment</div>
      <audio className="w-full" controls preload="metadata" src={`data:${block.mimeType};base64,${block.data}`}>
        Audio playback is unavailable.
      </audio>
    </div>
  );
}

function ResourceLink({ block }: { block: Extract<RenderableContentBlock, { type: 'resource_link' }> }) {
  const link = httpUrl(block.uri);
  const label = block.title || block.name;
  const details = [block.mimeType, block.size == null ? undefined : formatSize(block.size)].filter(Boolean);
  return (
    <div className="rounded-md border border-border bg-surface-1 p-3 text-sm">
      {link ? (
        <a className="font-medium text-brand hover:underline" href={link} rel="noreferrer noopener" target="_blank">
          {label}
        </a>
      ) : (
        <div className="font-medium text-text-primary">{label}</div>
      )}
      {block.title && block.title !== block.name && (
        <div className="mt-1 text-xs text-text-secondary">{block.name}</div>
      )}
      {block.description && <div className="mt-1 whitespace-pre-wrap text-text-secondary">{block.description}</div>}
      <div className="mt-1 break-all text-xs text-text-muted">{block.uri}</div>
      {details.length > 0 && <div className="mt-1 text-xs text-text-muted">{details.join(' · ')}</div>}
    </div>
  );
}

function EmbeddedResource({ block }: { block: Extract<RenderableContentBlock, { type: 'resource' }> }) {
  const { resource } = block;
  if ('text' in resource) {
    return (
      <div className="rounded-md border border-border bg-surface-1 p-3">
        <div className="mb-2 break-all text-xs text-text-muted">
          {resource.uri}
          {resource.mimeType ? ` · ${resource.mimeType}` : ''}
        </div>
        <pre className="overflow-auto whitespace-pre-wrap break-words text-sm text-text-primary">{resource.text}</pre>
      </div>
    );
  }
  if (resource.mimeType && renderableImageTypes.has(resource.mimeType)) {
    return <ImageBlock alt="Embedded image" data={resource.blob} mimeType={resource.mimeType} />;
  }
  const name = resourceName(resource.uri);
  const size = base64Size(resource.blob);
  return (
    <div className="rounded-md border border-border bg-surface-1 p-3 text-sm">
      <div className="font-medium text-text-primary">{name}</div>
      <div className="mt-1 break-all text-xs text-text-muted">
        {resource.mimeType || 'application/octet-stream'} · {formatSize(size)} · {resource.uri}
      </div>
      <a
        className="mt-2 inline-block text-xs font-medium text-brand hover:underline"
        download={name}
        href={`data:application/octet-stream;base64,${resource.blob}`}
      >
        Download
      </a>
    </div>
  );
}

export function contentBlockKey(keyPrefix: string, block: RenderableContentBlock, slot: number): string {
  return `${keyPrefix}:${block.type}:${slot}`;
}

export function ContentBlockView({ blocks, keyPrefix, mode, streaming = false }: ContentBlockViewProps) {
  return (
    <div className="space-y-3">
      {blocks.map((block, slot) => {
        const key = contentBlockKey(keyPrefix, block, slot);
        if (block.type === 'text') {
          if (mode === 'user') {
            return (
              <div key={key} className="whitespace-pre-wrap break-words">
                {block.text}
              </div>
            );
          }
          if (mode === 'assistant') {
            return (
              <MessageResponse key={key} mode={streaming ? 'streaming' : 'static'}>
                {block.text}
              </MessageResponse>
            );
          }
          return (
            <pre
              key={key}
              className="overflow-auto whitespace-pre-wrap break-words rounded-md bg-surface-1 p-2 font-mono text-[11px] text-text-secondary"
            >
              {block.text}
            </pre>
          );
        }
        if (block.type === 'image') {
          return <ImageBlock key={key} alt="Uploaded image" data={block.data} mimeType={block.mimeType} />;
        }
        if (block.type === 'audio') {
          return <AudioBlock key={key} block={block} />;
        }
        if (block.type === 'resource_link') {
          return <ResourceLink key={key} block={block} />;
        }
        return <EmbeddedResource key={key} block={block} />;
      })}
    </div>
  );
}
