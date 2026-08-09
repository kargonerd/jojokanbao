import { createCredentialAdminHandler } from "@jojo/agent/edgeone/credential-admin";

const handle = createCredentialAdminHandler();

export async function onRequest(context: Parameters<typeof handle>[0]) {
  return handle(context);
}
