// What a message's "Message info" pane says (the bubble's ⋯ menu): the exact moment it was sent, in
// this device's timezone, and the other facts the message itself carries. Nothing here is fetched
// and nothing new leaves the server. Whether a message was delivered or read is not recorded by this
// chat, so it is not offered.

import type { Attachment, Message } from "./api/messages";

export interface InfoRow {
  readonly label: string;
  readonly value: string;
}

/** To the second, with weekday, full date and timezone: the bubble only shows hours and minutes. */
export function formatExactTime(epochS: number): string {
  return new Date(epochS * 1000).toLocaleString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  });
}

function formatDuration(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(whole / 60);
  const hours = Math.floor(minutes / 60);
  const rest = String(whole % 60).padStart(2, "0");
  if (hours > 0) return `${hours}:${String(minutes % 60).padStart(2, "0")}:${rest}`;
  return `${minutes}:${rest}`;
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}

function attachmentName(attachment: Attachment): string {
  if (attachment.kind === "voice") return "Voice note";
  if (attachment.kind === "video") return "Video";
  return attachment.animated === true ? "GIF" : "Photo";
}

function attachmentDetail(attachment: Attachment): string {
  const details: string[] = [];
  if (attachment.width !== null && attachment.height !== null) {
    details.push(`${attachment.width} × ${attachment.height}`);
  }
  if (attachment.durationS !== null) details.push(formatDuration(attachment.durationS));
  if (attachment.transcript?.status === "done") details.push("transcribed");
  if (attachment.status !== "ready") details.push("still processing");
  return details.join(", ");
}

function messageType(message: Message): string {
  if (message.viewOnce != null) {
    const kind = message.attachments[0]?.kind === "video" ? "video" : "photo";
    return `View-once ${kind}`;
  }
  if (message.canvas === true) return "Canvas";
  if (message.wyr != null) return "Would You Rather game";
  if (message.adventure != null) return "Adventure Time game";
  if (message.cookout != null) return "Cookout game";
  if (message.attachments.length === 0) return "Text message";
  const names = new Set(message.attachments.map(attachmentName));
  if (names.size === 1) {
    const [name = ""] = names;
    return message.attachments.length === 1 ? name : plural(message.attachments.length, name);
  }
  return plural(message.attachments.length, "attachment");
}

function drawingsOn(message: Message): number {
  return Array.isArray(message.drawings) ? message.drawings.length : 0;
}

export function messageInfoRows(message: Message): readonly InfoRow[] {
  const rows: InfoRow[] = [
    { label: "Sent", value: formatExactTime(message.createdAt) },
    { label: "From", value: message.sender },
    { label: "Type", value: messageType(message) },
  ];
  if (message.viewOnce != null) {
    const seconds = message.viewOnce.durationS;
    rows.push({ label: "Shown for", value: seconds === null ? "Until closed" : plural(seconds, "second") });
  }
  const text = message.text ?? "";
  if (text !== "") {
    const words = text.trim().split(/\s+/u).filter((word) => word !== "").length;
    rows.push({ label: "Length", value: `${plural(words, "word")}, ${plural(Array.from(text).length, "character")}` });
  }
  if (message.viewOnce == null) {
    message.attachments.forEach((attachment, index) => {
      const detail = attachmentDetail(attachment);
      if (detail === "") return;
      const number = message.attachments.length > 1 ? ` ${index + 1}` : "";
      rows.push({ label: `${attachmentName(attachment)}${number}`, value: detail });
    });
  }
  if (message.replyTo !== null) rows.push({ label: "Replying to", value: message.replyTo.sender });
  if (message.wyrRef != null) rows.push({ label: "Sent in", value: "A game's chat" });
  const drawings = drawingsOn(message);
  if (drawings > 0) rows.push({ label: "Drawn on", value: plural(drawings, "time") });
  for (const reaction of message.reactions) {
    rows.push({ label: `Reaction ${reaction.emoji}`, value: reaction.senders.join(", ") });
  }
  rows.push({ label: "Message number", value: message.seq.toLocaleString() });
  return rows;
}
