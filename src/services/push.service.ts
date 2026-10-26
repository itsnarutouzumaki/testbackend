import type { AppConfig } from "../config";

export interface PushMessage {
  to: string;
  title: string;
  body: string;
  sound: "default";
  priority: "high";
  channelId: string;
  data: Record<string, unknown>;
}

export interface PushOutcome {
  acceptedTokens: string[];
  failedTokens: string[];
  unregisteredTokens: string[];
  httpStatuses?: number[];
  ticketIds?: string[];
}

export async function sendExpoPush(messages: PushMessage[], config: AppConfig): Promise<PushOutcome> {
  const outcome: PushOutcome = { acceptedTokens: [], failedTokens: [], unregisteredTokens: [], httpStatuses: [], ticketIds: [] };
  if (messages.length === 0) return outcome;

  for (let start = 0; start < messages.length; start += 100) {
    const chunk = messages.slice(start, start + 100);
    try {
      const response = await fetch("https://exp.host/--/api/v2/push/send", {
        method: "POST",
        headers: {
          accept: "application/json",
          "accept-encoding": "gzip, deflate",
          "content-type": "application/json",
          ...(config.expoPushAccessToken ? { authorization: `Bearer ${config.expoPushAccessToken}` } : {})
        },
        body: JSON.stringify(chunk)
      });
      outcome.httpStatuses!.push(response.status);
      if (!response.ok) {
        outcome.failedTokens.push(...chunk.map((message) => message.to));
        console.error(`Expo push request failed with HTTP ${response.status}.`);
        continue;
      }
      const payload = await response.json() as { data?: Array<{ id?: string; status?: string; details?: { error?: string }; message?: string }> | { id?: string; status?: string; details?: { error?: string }; message?: string } };
      const tickets = Array.isArray(payload.data) ? payload.data : payload.data ? [payload.data] : [];
      chunk.forEach((message, index) => {
        const ticket = tickets[index];
        if (ticket?.id) outcome.ticketIds!.push(ticket.id);
        if (ticket?.status === "ok") outcome.acceptedTokens.push(message.to);
        else {
          outcome.failedTokens.push(message.to);
          if (ticket?.details?.error === "DeviceNotRegistered") outcome.unregisteredTokens.push(message.to);
          if (ticket?.message) console.error("Expo push ticket was rejected.");
        }
      });
      if (tickets.length !== chunk.length) {
        for (let index = tickets.length; index < chunk.length; index += 1) outcome.failedTokens.push(chunk[index]!.to);
      }
    } catch (error) {
      outcome.failedTokens.push(...chunk.map((message) => message.to));
      console.error("Could not reach Expo Push Service.");
    }
  }
  return outcome;
}
