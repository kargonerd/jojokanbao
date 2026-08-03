import type { Session, User } from "@supabase/supabase-js";

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Profile = {
  id: string;
  display_name: string;
  avatar_path: string | null;
  created_at: string;
  updated_at: string;
};

export type PersonalInvitationStatus =
  | {
      allocated: false;
      redeemed: false;
    }
  | {
      allocated: true;
      code: string;
      redeemed: boolean;
      expires_at: string | null;
      disabled: boolean;
    };

export type PersonalInvitation = {
  code: string;
  expires_at: string | null;
};

export type Database = {
  public: {
    Tables: {
      profiles: {
        Row: Profile;
        Insert: {
          id: string;
          avatar_path?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          avatar_path?: string | null;
          updated_at?: string;
        };
        Relationships: [];
      };
    };
    Views: { [_ in never]: never };
    Functions: {
      generate_personal_signup_invitation: {
        Args: Record<PropertyKey, never>;
        Returns: PersonalInvitation[];
      };
      get_personal_invitation_status: {
        Args: Record<PropertyKey, never>;
        Returns: PersonalInvitationStatus;
      };
    };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
  };
};

export interface AuthState {
  session: Session | null;
  user: User | null;
  profile: Profile | null;
  initialized: boolean;
  busy: boolean;
  error: string | null;
  notice: string | null;
}

export interface SignUpInput {
  email: string;
  password: string;
  invitationCode: string;
  emailRedirectTo: string;
}
