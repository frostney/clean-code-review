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
} from 'lucide-react';

import type { GroupId } from '@/agent/lib/judging/questions';

/**
 * One icon per chapter of *Clean Code*, in one place: the group headers in a
 * card and any other list of groups read the same picture for the same
 * chapter, so a reader learns the alphabet once.
 *
 * Keyed by `GroupId`, so a new group in `agent/lib/judging/questions.ts` is a type
 * error here rather than a silently missing icon.
 */
const ICONS: Record<GroupId, LucideIcon> = {
  classes: Layers,
  comments: MessageSquare,
  errors: TriangleAlert,
  formatting: AlignLeft,
  functions: Braces,
  names: Tag,
  objects: Boxes,
  smells: Wind,
  tests: FlaskConical,
  verdict: Gavel,
};

/** 14px, muted, decorative: the group's title beside it is the label. */
export function GroupIcon({
  group,
  className = '',
}: {
  group: GroupId;
  className?: string;
}) {
  const Icon = ICONS[group];
  return (
    <Icon
      aria-hidden="true"
      className={`shrink-0 text-muted ${className}`}
      size={14}
      strokeWidth={1.75}
    />
  );
}
