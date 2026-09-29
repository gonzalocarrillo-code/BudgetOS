import { actionButton, context, esc, section, type Block } from "@budget/workers";
import type { PrismaClient } from "@prisma/client";
import { setSlackWorkspace } from "../../auth/commands/slack-workspace.js";
import type { ChosenWorkspace } from "../identity.js";
import { reply } from "../views.js";

/**
 * /budget workspace [name] (S-010): which workspace /budget answers for, and a way to choose. The
 * choice holds until the person types /budget in another workspace's channel, which always wins.
 */
export async function workspaceReply(prisma: PrismaClient, chosen: ChosenWorkspace, text: string): Promise<Record<string, unknown>> {
  if (text === "") return { response_type: "ephemeral", ...workspaceChoice(chosen) };
  const q = text.trim().toLowerCase();
  const named = chosen.mine.filter((m) => m.workspace.name.toLowerCase() === q || m.workspace.slug.toLowerCase() === q);
  const started = named.length ? named : chosen.mine.filter((m) => m.workspace.name.toLowerCase().startsWith(q));
  const target = started.length === 1 ? started[0] : undefined;
  if (!target) {
    const yours = chosen.mine.map((m) => `*${esc(m.workspace.name)}*`).join(", ");
    return reply(started.length > 1 ? `“${text}” could be ${started.map((m) => m.workspace.name).join(" or ")}: type more of its name.` : `You have no role in a linked workspace called “${text}”. Yours: ${yours}.`);
  }
  await setSlackWorkspace(prisma, target.auth);
  return reply(`:white_check_mark: /budget answers for *${esc(target.workspace.name)}* from now on, except in another workspace's channel.`);
}

/** Which workspace answers now, and a button for each of the person's others. */
export function workspaceChoice(chosen: ChosenWorkspace, notice?: string): { text: string; blocks: Block[] } {
  const why = { channel: "because you typed it in its channel", default: "because you chose it", only: "the only workspace you have a role in", first: "the first of yours by name" }[chosen.how];
  const others = chosen.mine.filter((m) => m.workspace.id !== chosen.workspace.id);
  const blocks: Block[] = [
    ...(notice ? [context(notice)] : []),
    section(`/budget answers for *${esc(chosen.workspace.name)}*, ${why}.${others.length ? "\nChoose another; a workspace's own channel still answers for it." : ""}`),
    ...(others.length ? [{ type: "actions" as const, elements: others.slice(0, 20).map((m) => actionButton(`Use ${m.workspace.name}`.slice(0, 75), "workspace.use", m.workspace.id, m.workspace.id)) }] : []),
  ];
  return { text: `/budget answers for ${chosen.workspace.name}`, blocks };
}
