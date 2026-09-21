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

// Keyed by `GroupId`, so a new group is a type error rather than a missing icon.
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

/** Decorative: the group title beside it is the label. */
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
