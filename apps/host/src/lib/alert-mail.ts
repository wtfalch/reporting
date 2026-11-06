import { createLettermintTransport, createMailpitTransport } from '@wtfalch/mailer';
import type { AlertMail } from '@wtfalch/reporting-service';

/**
 * How this host sends the company's error emails, from the env foundry gives
 * it (the same names an app's `uses.mail` gets):
 *
 * - `MAIL_FROM`: the From line, an address or `Name <address>`. Unset, no
 *   mail is sent at all: an app sends only when `MAIL_FROM` is set.
 * - `MAIL_SINK_URL`: a Mailpit sink (a stage copy). Wins over the token, so
 *   a stage host never reaches the real provider.
 * - `LETTERMINT_API_TOKEN`: the company's Lettermint token (the `<slug>-app`
 *   project, joined as a consumer).
 *
 * `null` with anything missing or malformed: the alert tick then sends
 * nothing and logs that once. Never throws, never logs a value.
 */
export function alertMailFromEnv(env: Record<string, string | undefined>): AlertMail | null {
  const from = env.MAIL_FROM?.trim();
  // A From line is a header: a line break in it is a second header.
  if (!from || [...from].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f)) {
    return null;
  }
  try {
    if (env.MAIL_SINK_URL) {
      return { from, transport: createMailpitTransport({ baseUrl: env.MAIL_SINK_URL }) };
    }
    if (env.LETTERMINT_API_TOKEN) {
      return { from, transport: createLettermintTransport({ apiKey: env.LETTERMINT_API_TOKEN }) };
    }
  } catch {
    return null;
  }
  return null;
}
