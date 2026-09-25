import type { SavedView } from "@prisma/client";

export const savedViewView = (v: SavedView) => ({ id: v.id, workspaceId: v.workspaceId, name: v.name, screen: v.screen, definition: v.definition, visibility: v.visibility, createdBy: v.createdBy });
