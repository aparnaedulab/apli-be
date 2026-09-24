import { env } from '../../config/env.js';

/**
 * Where a WhatsApp message actually goes.
 *
 * Two providers behind one shape. The log provider is what runs until the
 * Cloud API is configured: it sends nothing and says so, so a college can see
 * in its message log that WhatsApp is waiting on setup rather than wondering
 * why nobody got anything. The Cloud provider talks to Meta's API with plain
 * fetch - no SDK, one POST per message.
 */

export interface OutgoingMessage {
  /** E.164, e.g. +919000000000. */
  to: string;
  template: string;
  lang: string;
  params: string[];
}

export type SendResult = { ok: true; id: string | null } | { ok: false; error: string };

export interface WhatsAppProvider {
  name: 'log' | 'cloud';
  /** False for the log provider: nothing is really sent. */
  configured: boolean;
  send(message: OutgoingMessage): Promise<SendResult>;
}

export const NOT_SET_UP = 'WhatsApp is not set up on this portal, so nothing was sent.';

export const logProvider: WhatsAppProvider = {
  name: 'log',
  configured: false,
  async send() {
    return { ok: false, error: NOT_SET_UP };
  },
};

type FetchLike = (input: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export function cloudProvider(opts: {
  token: string;
  phoneNumberId: string;
  apiVersion: string;
  fetchImpl?: FetchLike;
}): WhatsAppProvider {
  const doFetch: FetchLike = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  const url = `https://graph.facebook.com/${opts.apiVersion}/${opts.phoneNumberId}/messages`;

  return {
    name: 'cloud',
    configured: true,
    async send(message) {
      const body = {
        messaging_product: 'whatsapp',
        // The Cloud API takes the number as digits with the country code.
        to: message.to.replace(/^\+/, ''),
        type: 'template',
        template: {
          name: message.template,
          language: { code: message.lang },
          components: [
            {
              type: 'body',
              parameters: message.params.map((text) => ({ type: 'text', text })),
            },
          ],
        },
      };

      try {
        const res = await doFetch(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${opts.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const json = (await res.json().catch(() => null)) as
          | { messages?: { id?: string }[]; error?: { message?: string; code?: number } }
          | null;

        if (!res.ok) {
          const reason = json?.error?.message ?? `The WhatsApp API answered ${res.status}.`;
          return { ok: false, error: reason };
        }
        return { ok: true, id: json?.messages?.[0]?.id ?? null };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'Could not reach the WhatsApp API.' };
      }
    },
  };
}

/** The provider this deployment uses: Cloud when both keys are set, otherwise the log. */
export function currentProvider(): WhatsAppProvider {
  if (env.WHATSAPP_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID) {
    return cloudProvider({
      token: env.WHATSAPP_TOKEN,
      phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID,
      apiVersion: env.WHATSAPP_API_VERSION,
    });
  }
  return logProvider;
}
