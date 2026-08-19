export interface UserNotification {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  targetPath: string | null;
  resourceType: string | null;
  resourceId: string | null;
  payload: Record<string, unknown>;
  actorId: string | null;
  actorName: string | null;
  readAt: string | null;
  createdAt: string;
}
