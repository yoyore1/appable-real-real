import { useEffect, useState } from "react";
import type { ChatAttachment } from "@appable/shared";
import { fetchAttachmentBlobUrl } from "../chatAttachments.js";

export function ChatAttachmentThumb({ attachment }: { attachment: ChatAttachment }) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let blobUrl: string | null = null;
    let cancelled = false;
    void fetchAttachmentBlobUrl(attachment.url).then((url) => {
      if (cancelled) {
        URL.revokeObjectURL(url);
        return;
      }
      blobUrl = url;
      setSrc(url);
    });
    return () => {
      cancelled = true;
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [attachment.url]);

  return (
    <figure className="chat-attach-thumb">
      {src ? (
        <img src={src} alt={attachment.name} title={attachment.name} />
      ) : (
        <span className="chat-attach-thumb-placeholder" aria-hidden />
      )}
    </figure>
  );
}
