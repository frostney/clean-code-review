import {
  AlignLeft,
  Boxes,
  Braces,
  FlaskConical,
  Gavel,
  Layers,
  type LucideIcon,
  MessageSquare,
  Tag,
  TriangleAlert,
  Wind,
} from "lucide-react";
import type { GroupId } from "@/agent/lib/questions";

/**
 * One icon per chapter of *Clean Code*, in one place: the group headers in a
 * card and any other list of groups read the same picture for the same
 * chapter, so a reader learns the alphabet once.
 *
 * Keyed by `GroupId`, so a new group in `agent/lib/questions.ts` is a type
 * error here rather than a silently missing icon.
 */
const ICONS: Record<GroupId, LucideIcon> = {
  names: Tag,
  functions: Braces,
  comments: MessageSquare,
  formatting: AlignLeft,
  objects: Boxes,
  errors: TriangleAlert,
  tests: FlaskConical,
  classes: Layers,
  smells: Wind,
  verdict: Gavel,
};

/** 14px, muted, decorative: the group's title beside it is the label. */
export function GroupIcon({ group, className = "" }: { group: GroupId; className?: string }) {
  const Icon = ICONS[group];
  return <Icon aria-hidden="true" size={14} strokeWidth={1.75} className={`shrink-0 text-muted ${className}`} />;
}
