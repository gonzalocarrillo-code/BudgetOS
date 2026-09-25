import type { Tag } from "@prisma/client";

export const tagView = (t: Tag) => ({ id: t.id, name: t.name, color: t.color, kind: t.kind });
