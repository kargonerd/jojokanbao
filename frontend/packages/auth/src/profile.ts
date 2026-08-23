import type { JojoAuthClient } from "./client";
import type { Profile } from "./types";

interface ProfileRepository {
  getOrCreate: (userId: string) => Promise<Profile>;
}

export function createProfileRepository(client: JojoAuthClient): ProfileRepository {
  const getOrCreate = async (userId: string): Promise<Profile> => {
    const { data, error } = await client.from("profiles").select("*").eq("id", userId).maybeSingle();
    if (error) throw error;
    if (data) return data;

    const { data: created, error: createError } = await client
      .from("profiles")
      .insert({ id: userId })
      .select("*")
      .single();
    if (createError) throw createError;
    return created;
  };

  return { getOrCreate };
}
