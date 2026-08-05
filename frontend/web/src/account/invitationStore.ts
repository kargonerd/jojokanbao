import { getAuthErrorMessage, type PersonalInvitationStatus } from "@jojo/auth";
import { create } from "zustand";
import { personalInvitationRepository } from "./auth";

interface PersonalInvitationState {
  ownerUserId: string | null;
  status: PersonalInvitationStatus | null;
  loading: boolean;
  generating: boolean;
  error: string | null;
  load: (userId: string) => Promise<void>;
  generate: () => Promise<void>;
}

export const usePersonalInvitationStore = create<PersonalInvitationState>(
  (set, get) => ({
    ownerUserId: null,
    status: null,
    loading: false,
    generating: false,
    error: null,

    load: async (userId) => {
      set({
        ownerUserId: userId,
        status: null,
        loading: true,
        generating: false,
        error: null,
      });
      try {
        const status = await personalInvitationRepository.getStatus();
        if (get().ownerUserId === userId) {
          set({ status, loading: false });
        }
      } catch (error) {
        if (get().ownerUserId === userId) {
          set({ loading: false, error: getAuthErrorMessage(error) });
        }
      }
    },

    generate: async () => {
      const ownerUserId = get().ownerUserId;
      if (!ownerUserId) return;
      set({ generating: true, error: null });
      try {
        const invitation = await personalInvitationRepository.generate();
        if (get().ownerUserId !== ownerUserId) return;
        set({
          status: {
            allocated: true,
            code: invitation.code,
            expires_at: invitation.expires_at,
            redeemed: false,
            disabled: false,
          },
          generating: false,
        });
      } catch (error) {
        if (get().ownerUserId === ownerUserId) {
          set({ generating: false, error: getAuthErrorMessage(error) });
        }
      }
    },
  }),
);
