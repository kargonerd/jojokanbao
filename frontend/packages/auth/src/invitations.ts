import type { JojoAuthClient } from "./client";
import type { PersonalInvitation, PersonalInvitationStatus } from "./types";

export interface PersonalInvitationRepository {
  getStatus: () => Promise<PersonalInvitationStatus>;
  generate: () => Promise<PersonalInvitation>;
}

export function createPersonalInvitationRepository(
  client: JojoAuthClient,
): PersonalInvitationRepository {
  return {
    async getStatus() {
      const { data, error } = await client.rpc(
        "get_personal_invitation_status",
      );
      if (error) throw error;
      return data;
    },

    async generate() {
      const { data, error } = await client.rpc(
        "generate_personal_signup_invitation",
      );
      if (error) throw error;

      const invitation = data[0];
      if (!invitation)
        throw new Error("Invitation generation returned no code.");
      return invitation;
    },
  };
}
