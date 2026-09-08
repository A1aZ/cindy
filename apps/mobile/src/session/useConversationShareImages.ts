import { useCallback, useEffect, useRef, useState } from "react";
import { Image } from "react-native";
import { Directory, File, Paths } from "expo-file-system";
import {
  prepareConversationShareImages,
  type ConversationShareImageContext,
} from "@/session/conversationShareImages";
import type {
  ConversationShareImage,
  ConversationShareMessage,
} from "@/session/conversationShareWebViewHtml";
import {
  isDesktopLocalMediaUrl,
  type ResolveRemoteMediaFn,
} from "@/session/remoteMedia";
import { withDownloadedRemoteMediaFile } from "@/session/remoteMediaDiskCacheExpo";
import { extOfMime, imageMimeFromUrl } from "@/session/remoteMediaDiskCache";
import {
  getSentAttachmentThumbUri,
  ensureSentAttachmentThumbsHydrated,
} from "@/session/sentAttachmentThumbStore";

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

async function readShareImageSize(uri: string, signal: AbortSignal) {
  if (signal.aborted) throw new Error("conversation share image cancelled");
  let onAbort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error("conversation share image cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    // Android's encoded-image size reader accepts file:// but rejects data:.
    // Racing cancellation also releases temporary files if native IO stalls.
    return await Promise.race([Image.getSize(uri), cancelled]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function readShareImageFile(
  uri: string,
  mimeType: string,
  canRead: () => boolean,
  signal: AbortSignal,
  embeddedUri?: string,
): Promise<ConversationShareImage | null> {
  if (!canRead()) return null;
  const file = new File(uri);
  if (!file.exists || file.size <= 0 || file.size > MAX_IMAGE_BYTES)
    return null;
  const size = await readShareImageSize(uri, signal);
  if (!canRead()) return null;
  const dataUri = embeddedUri ?? `data:${mimeType};base64,${await file.base64()}`;
  return canRead() ? { uri: dataUri, ...size } : null;
}

/** Inline sources need a file only for sizing; exports keep their embedded bytes. */
async function readShareImageDataUri(
  uri: string,
  canRead: () => boolean,
  signal: AbortSignal,
): Promise<ConversationShareImage | null> {
  const header = /^data:(image\/[^;,]+);base64,/.exec(uri);
  if (!header || uri.length === header[0].length || !canRead()) return null;
  const directory = new Directory(Paths.cache, "conversation-share-images");
  let file: File | null = null;
  try {
    directory.create({ intermediates: true, idempotent: true });
    const unique = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    file = new File(directory, `image-${unique}.${extOfMime(header[1]!)}`);
    const FileSystem = await import("expo-file-system/legacy");
    if (!canRead()) return null;
    await FileSystem.writeAsStringAsync(file.uri, uri.slice(header[0].length), {
      encoding: FileSystem.EncodingType.Base64,
    });
    return await readShareImageFile(file.uri, header[1]!, canRead, signal, uri);
  } finally {
    try {
      file?.delete();
    } catch {
      // Best-effort cleanup within the OS cache, including partial writes.
    }
  }
}

async function loadShareImage(
  url: string,
  resolve: ResolveRemoteMediaFn,
  canRead: () => boolean,
  signal: AbortSignal,
): Promise<ConversationShareImage | null> {
  // The existing store owns both OSS and desktop-media upload thumbnails.
  await ensureSentAttachmentThumbsHydrated();
  if (!canRead()) return null;
  const localThumb = getSentAttachmentThumbUri(url);
  if (localThumb) {
    const image = await readShareImageFile(
      localThumb,
      imageMimeFromUrl(localThumb) ?? "image/jpeg",
      canRead,
      signal,
    ).catch(() => null);
    if (image) return image;
  }
  if (!canRead()) return null;
  let uri = url;
  let mimeType = imageMimeFromUrl(uri) ?? "image/jpeg";
  if (uri === url && isDesktopLocalMediaUrl(url)) {
    const media = await resolve(
      {
        kind: "image",
        url,
        previewable: true,
        thumbnail: true,
      },
      { signal },
    );
    if (
      !canRead() ||
      !media.mimeType.startsWith("image/") ||
      !Number.isFinite(media.size) ||
      media.size <= 0 ||
      media.size > MAX_IMAGE_BYTES
    )
      return null;
    uri = media.url;
    mimeType = media.mimeType;
    // Only download objects whose size the controlled desktop resolver knows.
    // Arbitrary HTTP sources have no trusted pre-transfer bound: keep alt text.
    if (/^https?:\/\//i.test(uri)) {
      return withDownloadedRemoteMediaFile(uri, mimeType, MAX_IMAGE_BYTES, (file) =>
        readShareImageFile(file.uri, mimeType, canRead, signal),
      );
    }
  }
  if (uri.startsWith("file://") && isDesktopLocalMediaUrl(url)) {
    // Other local files must come from the controlled media resolver.
    return readShareImageFile(uri, mimeType, canRead, signal);
  }
  if (
    !canRead() ||
    !uri.startsWith("data:image/") ||
    uri.length > (MAX_IMAGE_BYTES * 4) / 3 + 128
  )
    return null;
  return readShareImageDataUri(uri, canRead, signal);
}

interface ShareImageJob {
  sourceMessages: readonly ConversationShareMessage[];
  resolve: ResolveRemoteMediaFn;
  context: ConversationShareImageContext;
  finish: (messages: readonly ConversationShareMessage[]) => void;
}

/** Prepare one click-time snapshot; live message updates cannot replace it. */
export function useConversationShareImages(
  messages: readonly ConversationShareMessage[],
  resolve: ResolveRemoteMediaFn,
  { workdir, remoteHostId, sessionId }: ConversationShareImageContext,
) {
  const [job, setJob] = useState<ShareImageJob | null>(null);
  const prepare = useCallback(() => {
    return new Promise<readonly ConversationShareMessage[]>((finish) => {
      setJob({
        sourceMessages: messages,
        resolve,
        context: { workdir, remoteHostId, sessionId },
        finish,
      });
    });
  }, [messages, resolve, workdir, remoteHostId, sessionId]);
  const cancel = useCallback(() => setJob(null), []);
  const selectionKey = JSON.stringify(
    messages.map((message) => message.clientId),
  );
  useEffect(cancel, [cancel, selectionKey, sessionId]);
  const revision = useRef(0);
  const activeJob = useRef<typeof job | null>(null);
  const [prepared, setPrepared] = useState<{
    job: typeof job;
    messages: readonly ConversationShareMessage[];
    revision: number;
  } | null>(null);
  useEffect(() => {
    if (!job) return;
    const { sourceMessages, resolve, context } = job;
    // The existing media queue removes this export's still-queued waiter.
    // Effect-local ownership also gives StrictMode replays a fresh signal.
    const controller = new AbortController();
    let active = true;
    activeJob.current = job;
    let timedOut = false;
    let finishImageWait!: (image: null) => void;
    const imageDeadline = new Promise<null>((done) => {
      finishImageWait = done;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      finishImageWait(null);
    }, 20_000);
    void prepareConversationShareImages(
      sourceMessages,
      // Keep completed images and all message text when the shared deadline
      // expires. Remaining images become placeholders without starting more IO.
      (url) =>
        timedOut
          ? Promise.resolve(null)
          : Promise.race([
              loadShareImage(
                url,
                resolve,
                () => active && !timedOut,
                controller.signal,
              ),
              imageDeadline,
            ]),
      context,
      () => active,
    )
      .then((result) => {
        clearTimeout(timer);
        if (active)
          setPrepared({ job, messages: result, revision: ++revision.current });
      })
      .catch(() => {
        clearTimeout(timer);
        if (active)
          setPrepared({
            job,
            messages: sourceMessages,
            revision: ++revision.current,
          });
      });
    return () => {
      active = false;
      controller.abort();
      clearTimeout(timer);
      finishImageWait(null);
      activeJob.current = null;
      // StrictMode immediately replays this effect with the same job.
      queueMicrotask(() => {
        if (activeJob.current !== job) job.finish([]);
      });
    };
  }, [job]);
  useEffect(() => {
    if (job && prepared?.job === job) job.finish(prepared.messages);
  }, [job, prepared]);
  return {
    prepare,
    cancel,
    messages: prepared?.job === job ? prepared.messages : [],
    revision: prepared?.job === job ? prepared.revision : 0,
  };
}
