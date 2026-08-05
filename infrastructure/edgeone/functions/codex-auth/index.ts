import { createCodexCredentialAdminHandler } from "@jojo/agent";

const handle = createCodexCredentialAdminHandler();

export async function onRequest(context: Parameters<typeof handle>[0]) {
  return handle(context);
}
