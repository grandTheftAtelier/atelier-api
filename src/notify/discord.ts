/**
 * Discord webhook notifications — operational, out-of-band alerts for whoever
 * runs the server. Opt-in via ATELIER_DISCORD_WEBHOOK_URL; a no-op when unset.
 *
 * Every send is fire-and-forget and can never throw into the caller: a failing
 * or slow webhook must not delay an auth redirect or a build. `allowed_mentions`
 * is locked to `parse: []` so a hostile username (e.g. "@everyone") can never
 * turn a notification into a mass ping.
 */

import type { Env } from "../env";
import { log } from "../logging/log";

// Discord brand colours reused for embed accents.
const COLOR_BLURPLE = 0x5865f2;
const COLOR_RED = 0xed4245;

const WEBHOOK_TIMEOUT_MS = 5000;

let webhookUrl = "";
let publicOrigin = "";

export function configureNotifier(env: Env): void {
  webhookUrl = env.ATELIER_DISCORD_WEBHOOK_URL;
  publicOrigin = env.ATELIER_PUBLIC_ORIGIN;
}

export function isNotifierConfigured(): boolean {
  return webhookUrl.length > 0;
}

interface EmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

interface Embed {
  title: string;
  description?: string;
  color: number;
  fields?: EmbedField[];
  timestamp: string;
  footer: { text: string };
}

/**
 * Make arbitrary text safe for an embed: neutralise backticks (they break code
 * spans), collapse all whitespace (newlines/tabs included) to single spaces,
 * and clamp the length so a multi-line error or an odd username stays tidy.
 */
function clean(text: string, max = 256): string {
  const flat = text
    .replace(/`/gu, "'")
    .replace(/\s+/gu, " ")
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

async function send(embed: Embed): Promise<void> {
  if (!webhookUrl) return;
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ embeds: [embed], allowed_mentions: { parse: [] } }),
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
    if (!res.ok) {
      log.warn("notify", `Discord webhook returned ${res.status}`, { status: res.status });
    }
  } catch (e) {
    log.warn("notify", "Discord webhook request failed", {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/** A brand-new user has signed in and is waiting for an admin to approve them. */
export async function notifyPendingUser(user: {
  discordId: string;
  username: string;
}): Promise<void> {
  if (!webhookUrl) return;
  await send({
    title: "🔑 New access request",
    description: `**${clean(user.username, 80)}** signed in to atelier and is waiting for approval.`,
    color: COLOR_BLURPLE,
    fields: [
      { name: "Discord ID", value: `\`${clean(user.discordId, 32)}\``, inline: true },
      { name: "Review", value: `[Open the admin dashboard](${publicOrigin}/admin)`, inline: true },
    ],
    timestamp: new Date().toISOString(),
    footer: { text: "atelier-api" },
  });
}

/** A server build finished in the `error` state. */
export async function notifyBuildFailed(info: {
  packId: string;
  packName?: string | null;
  revision: number;
  buildId: string;
  error?: string | null;
}): Promise<void> {
  if (!webhookUrl) return;
  const name = info.packName ? clean(info.packName, 80) : `\`${clean(info.packId, 32)}\``;
  const fields: EmbedField[] = [
    { name: "Pack", value: `\`${clean(info.packId, 32)}\``, inline: true },
    { name: "Revision", value: `\`${info.revision}\``, inline: true },
    { name: "Build", value: `\`${clean(info.buildId, 40)}\``, inline: true },
  ];
  if (info.error) fields.push({ name: "Error", value: clean(info.error, 1000) });
  await send({
    title: "❌ Server build failed",
    description: `The server build for ${name} (revision ${info.revision}) failed.`,
    color: COLOR_RED,
    fields,
    timestamp: new Date().toISOString(),
    footer: { text: "atelier-api" },
  });
}
